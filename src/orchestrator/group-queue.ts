/**
 * Group Queue — concurrency control for agent execution.
 *
 * Manages concurrent agent containers per group. Handles:
 * - Max concurrent containers limit
 * - Per-group message and task queuing
 * - Idle waiting and stdin piping
 * - Retry with exponential backoff
 * - Graceful shutdown
 */
import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  activeStartedAt: number | null;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  // Hard timeout per run. Set by registerProcess when timeoutMs is provided.
  // Cleared automatically when the registered process exits, or by runForGroup/
  // runTask's finally block. `timedOut` survives across the run so message-loop
  // can pick it up for status='timeout' on the agent_runs row.
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  timedOut: boolean;
}

// Grace period between SIGTERM and SIGKILL when timing out a runner.
const TIMEOUT_KILL_GRACE_MS = 30_000;

/**
 * Resolve hard timeout per agent run.
 *  - agentConfig.runTimeoutMs (per-group override) wins if set.
 *  - sandbox + fully-isolated → 8 min (tighter resource envelope).
 *  - everything else (container, sandbox-with-unsandboxed, deepseek) → 15 min.
 *
 * Lives here so both message-loop and task-scheduler can call it without a
 * cyclic import (task-scheduler is imported BY message-loop).
 */
const DEFAULT_TIMEOUT_SANDBOX_MS = 8 * 60 * 1000;
const DEFAULT_TIMEOUT_OTHER_MS = 15 * 60 * 1000;
export function resolveRunTimeoutMs(
  runtime: string,
  agentConfig: { runTimeoutMs?: number; unsandboxed?: boolean } | undefined,
): number {
  if (typeof agentConfig?.runTimeoutMs === 'number' && agentConfig.runTimeoutMs > 0) {
    return agentConfig.runTimeoutMs;
  }
  if (runtime === 'sandbox' && !agentConfig?.unsandboxed) {
    return DEFAULT_TIMEOUT_SANDBOX_MS;
  }
  return DEFAULT_TIMEOUT_OTHER_MS;
}

// If a group has been active for longer than this, force-clear it.
// Safety net for any code path that fails to release the active flag.
const STALE_ACTIVE_MS = 10 * 60 * 1000; // 10 minutes

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  private shutdownResolver: (() => void) | null = null;

  getActiveCount(): number {
    return this.activeCount;
  }

  getActiveGroupsForDebug(): Array<{
    groupJid: string;
    pendingMessages: boolean;
    pendingTaskCount: number;
    runningTaskId: string | null;
    activeSinceMs: number | null;
  }> {
    const now = Date.now();
    const active: Array<{
      groupJid: string;
      pendingMessages: boolean;
      pendingTaskCount: number;
      runningTaskId: string | null;
      activeSinceMs: number | null;
    }> = [];
    for (const [groupJid, state] of this.groups.entries()) {
      if (!state.active) continue;
      active.push({
        groupJid,
        pendingMessages: state.pendingMessages,
        pendingTaskCount: state.pendingTasks.length,
        runningTaskId: state.runningTaskId,
        activeSinceMs: state.activeStartedAt ? now - state.activeStartedAt : null,
      });
    }
    return active;
  }

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        activeStartedAt: null,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        timeoutTimer: null,
        killTimer: null,
        timedOut: false,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) {
      logger.debug(
        { groupJid },
        'enqueueMessageCheck during shutdown — message stays in DB, will recover on next start',
      );
      return;
    }
    const state = this.getGroup(groupJid);

    if (state.active) {
      // Safety net: force-clear stale active state
      if (state.activeStartedAt && Date.now() - state.activeStartedAt > STALE_ACTIVE_MS) {
        logger.warn({ groupJid, staleSinceMs: Date.now() - state.activeStartedAt }, 'Force-clearing stale active group');
        state.active = false;
        state.activeStartedAt = null;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        this.activeCount = Math.max(0, this.activeCount - 1);
      } else {
        state.pendingMessages = true;
        return;
      }
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;
    const state = this.getGroup(groupJid);

    if (state.runningTaskId === taskId) return;
    if (state.pendingTasks.some((t) => t.id === taskId)) return;

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) this.closeStdin(groupJid);
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      return;
    }

    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    timeoutMs?: number,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;

    // Reset per-run timeout flag; previous run's flag must not bleed in.
    state.timedOut = false;

    if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof proc.kill === 'function') {
      state.timeoutTimer = setTimeout(() => {
        state.timedOut = true;
        logger.warn(
          { groupJid, containerName, timeoutMs },
          'Runner exceeded hard timeout — sending SIGTERM',
        );
        try { proc.kill('SIGTERM'); } catch (err) {
          logger.warn({ groupJid, err }, 'SIGTERM failed');
        }
        // Grace period, then escalate to SIGKILL if still alive.
        state.killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            logger.warn(
              { groupJid, containerName, graceMs: TIMEOUT_KILL_GRACE_MS },
              'Runner did not exit after SIGTERM — escalating to SIGKILL',
            );
            try { proc.kill('SIGKILL'); } catch (err) {
              logger.warn({ groupJid, err }, 'SIGKILL failed');
            }
          }
        }, TIMEOUT_KILL_GRACE_MS);
      }, timeoutMs);

      // Clear timers as soon as the process exits — whether normal exit, our
      // SIGTERM, an unrelated SIGKILL, or anything else. Without this we'd
      // either fire SIGTERM at an already-dead pid (harmless but noisy) or
      // leave the kill timer pending and write to a stale state object.
      if (typeof proc.once === 'function') {
        proc.once('exit', () => this.clearTimeoutTimers(state));
      }
    }
  }

  private clearTimeoutTimers(state: GroupState): void {
    if (state.timeoutTimer) {
      clearTimeout(state.timeoutTimer);
      state.timeoutTimer = null;
    }
    if (state.killTimer) {
      clearTimeout(state.killTimer);
      state.killTimer = null;
    }
  }

  /**
   * Returns true if the most recent run for this group was forcibly killed
   * by the hard timeout. Read by message-loop to record status='timeout' on
   * the agent_runs row. Resets when the next registerProcess() is called.
   */
  wasTimeout(groupJid: string): boolean {
    return this.groups.get(groupJid)?.timedOut === true;
  }

  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) return false;
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;
    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  /**
   * Force-close a runner identified by its IPC folder, bypassing GroupState
   * lookups. Required for the thread-reply case: the queue tracks `active`
   * by chatJid (parent channel) for activeCount accounting, but
   * registerProcess() keys groupFolder by replyJid (thread JID). As a result,
   * `closeStdin(chatJid)` early-returns (no groupFolder on parent state),
   * and the runner hangs until IDLE_TIMEOUT (30 min) or STALE_ACTIVE_MS
   * (10 min) reaps it. Calling this with the thread folder writes the
   * `_close` sentinel directly to the right IPC dir.
   */
  closeStdinForFolder(groupFolder: string): void {
    if (!groupFolder) return;
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages');
      this.scheduleRetry(groupJid, state);
    } finally {
      this.clearTimeoutTimers(state);
      state.active = false;
      state.activeStartedAt = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.activeStartedAt = Date.now();
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      this.clearTimeoutTimers(state);
      state.active = false;
      state.activeStartedAt = null;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error({ groupJid }, 'Max retries exceeded');
      state.retryCount = 0;
      return;
    }
    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info({ groupJid, retryCount: state.retryCount, delayMs }, 'Retry scheduled');
    setTimeout(() => {
      if (!this.shuttingDown) this.enqueueMessageCheck(groupJid);
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) {
      this.maybeResolveShutdown();
      return;
    }
    const state = this.getGroup(groupJid);

    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error({ groupJid, taskId: task.id, err }, 'Error in drain task'),
      );
      return;
    }

    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error({ groupJid, err }, 'Error in drain messages'),
      );
      return;
    }

    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting task'),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error({ groupJid: nextJid, err }, 'Error in waiting drain'),
        );
      }
    }
  }

  private maybeResolveShutdown(): void {
    if (!this.shuttingDown || this.shutdownResolver === null) return;
    if (this.activeCount === 0) {
      const resolve = this.shutdownResolver;
      this.shutdownResolver = null;
      resolve();
    }
  }

  async shutdown(gracePeriodMs: number = 120000): Promise<void> {
    this.shuttingDown = true;
    logger.info({ activeCount: this.activeCount }, 'GroupQueue shutting down');
    if (this.activeCount === 0) return;

    // Signal every active runner to wrap up immediately. Without this the
    // SDK query loop keeps waiting on stdin until IDLE_TIMEOUT (30 min) —
    // way past our grace window — and any final assistant message it was
    // about to emit gets lost when SIGKILL hits at process.exit. Writing
    // `_close` to each group's IPC input dir makes the runner finish the
    // current turn, flush its final output via the streaming callback,
    // and exit cleanly inside the grace period.
    const signaled: string[] = [];
    for (const [groupJid, state] of this.groups.entries()) {
      if (!state.active || !state.groupFolder) continue;
      try {
        this.closeStdinForFolder(state.groupFolder);
        signaled.push(groupJid);
      } catch (err) {
        logger.warn(
          { groupJid, folder: state.groupFolder, err },
          'Failed to signal close on shutdown',
        );
      }
    }
    if (signaled.length > 0) {
      logger.info(
        { count: signaled.length },
        'Sent _close signal to active runners',
      );
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        this.shutdownResolver = resolve;
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, gracePeriodMs);
      }),
    ]);

    logger.info(
      { activeCount: this.activeCount, gracePeriodMs },
      'GroupQueue shutdown wait complete',
    );
  }
}
