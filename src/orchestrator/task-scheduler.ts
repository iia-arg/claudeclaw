import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import {
  ASSISTANT_NAME,
  DEFAULT_RUNTIME,
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from '../runtimes/container-runner.js';
import { runHostAgent } from '../runtimes/host-runner.js';
import { runDeepSeekAgent } from '../runtimes/deepseek-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { writeExtensionToolsManifest } from './extension-tool-bridge.js';
import { GroupQueue, resolveRunTimeoutMs } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { MessageRouter, RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    // If next_run is missing (first-time backfill), anchor to now instead —
    // otherwise we'd start from epoch 0 and loop millions of times.
    const anchor = task.next_run
      ? new Date(task.next_run).getTime()
      : now;
    let next = anchor + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
    timeoutMs?: number,
  ) => void;
  router: MessageRouter;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  // Prefer the registered group keyed by this task's exact chat_jid.
  // Multiple JIDs can share a folder (e.g. tg-topic + bx24-portal both on
  // `zhizn_yupiter`), and each JID may carry distinct agentConfig
  // (allowedDomains, runtime, model). A blind folder-match would pick
  // whichever Object.values iteration order returned first and execute
  // the task under the wrong channel's settings. Fall back to folder
  // lookup only if the JID isn't registered (legacy tasks where chat_jid
  // was never recorded against a registered group).
  const group =
    groups[task.chat_jid] ??
    Object.values(groups).find((g) => g.folder === task.group_folder);

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Refresh extension-tools manifest so agent-runner sees current tool list
  writeExtensionToolsManifest(task.group_folder);

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    // Match message-loop's runtime selection: per-group override, then DEFAULT_RUNTIME.
    // Without this, scheduled tasks always tried Docker even when the instance
    // is configured for sandbox/deepseek via .env RUNTIME.
    const runtime = group.runtime || DEFAULT_RUNTIME;
    const runner =
      runtime === 'deepseek'
        ? runDeepSeekAgent
        : runtime === 'host'
          ? runHostAgent
          : runContainerAgent;

    const output = await runner(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        agentConfig: group.agentConfig,
      },
      (proc, containerName) =>
        deps.onProcess(
          task.chat_jid,
          proc,
          containerName,
          task.group_folder,
          resolveRunTimeoutMs(runtime, group.agentConfig),
        ),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          // Forward result to user via outbound router
          await deps.router.route({
            chatJid: task.chat_jid,
            text: streamedOutput.result,
            triggerType: 'task-result',
            groupFolder: task.group_folder,
          });
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

/**
 * Normalize a stored timestamp to UTC ISO with explicit `Z` suffix.
 * Returns null if the input cannot be parsed.
 *
 * Why this matters: getDueTasks does a STRING comparison
 * `next_run <= ?` where `?` is `new Date().toISOString()` (Z-form).
 * If next_run was inserted as `2026-05-04T20:00:00+03:00` (offset-form),
 * the lex compare fails — the task hangs in 'active' forever despite
 * the wall clock having passed. We saw this with rows added by manual
 * SQL / migration paths that bypass the IPC handler's normalization.
 */
function normalizeToUtcZ(ts: string | null | undefined): string | null {
  if (!ts) return null;
  if (/Z$/.test(ts)) return ts;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Repair active scheduled tasks whose `next_run` is stored in a
 * non-canonical (non-Z) timestamp form. See normalizeToUtcZ above for
 * background. Called once at scheduler startup.
 */
export function normalizeNonUtcNextRuns(): number {
  const tasks = getAllTasks().filter(
    (t) =>
      t.status === 'active' && t.next_run != null && !/Z$/.test(t.next_run),
  );
  if (tasks.length === 0) return 0;

  let fixed = 0;
  for (const t of tasks) {
    const normalized = normalizeToUtcZ(t.next_run);
    if (!normalized) {
      logger.warn(
        { taskId: t.id, nextRun: t.next_run },
        'Cannot parse next_run for normalization; pausing task',
      );
      // Pause to stop scheduler-tick churn on a row we can't compare.
      updateTask(t.id, { status: 'paused' });
      continue;
    }
    if (normalized === t.next_run) continue;
    updateTask(t.id, { next_run: normalized });
    fixed++;
    logger.info(
      { taskId: t.id, before: t.next_run, after: normalized },
      'Normalized next_run to UTC-Z form',
    );
  }
  return fixed;
}

/**
 * Backfill `next_run` for any active recurring task (cron/interval) where it is
 * NULL. This catches tasks inserted directly into the DB (migrations, manual
 * SQL) which never went through the IPC schedule_task path that computes
 * next_run upfront. Without this, getDueTasks (which filters
 * `next_run IS NOT NULL`) would silently skip them forever.
 *
 * Called at scheduler startup and is cheap enough to run on every tick as a
 * safety net.
 */
export function backfillMissingNextRuns(): number {
  const tasks = getAllTasks().filter(
    (t) =>
      t.status === 'active' &&
      t.next_run == null &&
      (t.schedule_type === 'cron' || t.schedule_type === 'interval'),
  );
  if (tasks.length === 0) return 0;

  let fixed = 0;
  for (const t of tasks) {
    try {
      const next = computeNextRun(t);
      if (next) {
        updateTask(t.id, { next_run: next });
        fixed++;
        logger.info(
          {
            taskId: t.id,
            scheduleType: t.schedule_type,
            scheduleValue: t.schedule_value,
            nextRun: next,
          },
          'Backfilled missing next_run on recurring task',
        );
      }
    } catch (err) {
      logger.warn(
        {
          taskId: t.id,
          scheduleType: t.schedule_type,
          scheduleValue: t.schedule_value,
          err,
        },
        'Failed to backfill next_run; task remains inert',
      );
    }
  }
  return fixed;
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  // Repair tasks whose next_run is stored with a numeric offset (`+03:00`)
  // rather than UTC `Z`. Lexicographic SQL compare against `new Date().toISOString()`
  // (always Z-form) silently breaks for offset-form rows.
  const renormalized = normalizeNonUtcNextRuns();
  if (renormalized > 0) {
    logger.info(
      { count: renormalized },
      'Normalized non-UTC next_run timestamps on startup',
    );
  }

  // Repair any recurring tasks that were inserted with NULL next_run
  // (e.g. migrations / manual SQL). Without this they would never fire.
  const fixed = backfillMissingNextRuns();
  if (fixed > 0) {
    logger.info({ count: fixed }, 'Backfilled NULL next_run on startup');
  }

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
