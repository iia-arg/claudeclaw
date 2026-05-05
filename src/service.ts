/**
 * ClaudeClaw Service — Background orchestrator entry point.
 * Run by launchd (macOS) or systemd (Linux) as a persistent service.
 *
 * This is the process that polls for messages, spawns agents, and routes responses.
 * Start with: node dist/service.js
 * Dev mode:   npx tsx src/service.ts
 *
 * The working directory IS the instance — all state (store/, groups/, .env)
 * lives in cwd. Multiple instances = multiple directories.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadExtensions } from './orchestrator/extension-loader.js';

/**
 * PID-lock: refuse to start if another service.js is already running for this cwd.
 *
 * Background: ClaudeClaw uses cwd as the instance identifier. Two parallel
 * service.js processes on the same cwd cause split-brain — both poll the same
 * Telegram bot token (race on getUpdates offset), both write the same DB,
 * answers come from a random one each time. Worst observed case: 3 parallel
 * service.js after a self-restart-via-`systemd-run --on-active=N` trick where
 * the transient unit survived `systemctl restart` and re-spawned the service
 * while systemd's own Restart=always was also bringing it up.
 *
 * This lock blocks ALL such cases at the application layer, regardless of how
 * service.js was launched (systemd, transient unit, hand-run, cron…).
 *
 * Stale-lock recovery: if the lockfile points to a PID that no longer exists,
 * take over the lock. If the PID exists but we can't signal it (EPERM), refuse
 * to start — better safe than sorry.
 */
function acquirePidLock(): void {
  const lockPath = path.join(process.cwd(), '.claudeclaw.pid');
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const oldPid = Number.parseInt(raw, 10);
    if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
      try {
        process.kill(oldPid, 0); // probe; throws ESRCH if dead
        console.error(
          `[claudeclaw] Another service.js is already running with PID ${oldPid} ` +
            `(lockfile: ${lockPath}). Refusing to start a duplicate. Exiting.`,
        );
        process.exit(2);
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err?.code === 'EPERM') {
          console.error(
            `[claudeclaw] PID ${oldPid} from lockfile ${lockPath} is alive but ` +
              `unsignalable (EPERM). Refusing to start. Exiting.`,
          );
          process.exit(2);
        }
        // ESRCH or other — process is dead, stale lock, fall through and take over
        console.warn(
          `[claudeclaw] Stale lockfile ${lockPath} (PID ${oldPid} dead). Taking over.`,
        );
      }
    }
  } catch {
    // No lockfile or unreadable — first start, fall through
  }
  fs.writeFileSync(lockPath, String(process.pid), { mode: 0o644 });

  // PID-lock cleanup ONLY runs synchronously on actual process exit.
  // We do NOT install signal handlers here — those are owned by the
  // orchestrator's master shutdown (src/orchestrator/message-loop.ts),
  // which performs the full async drain (channel polling abort,
  // group-queue close, DB flush) and then calls process.exit(0).
  //
  // Why no SIGTERM/SIGINT/SIGHUP/SIGQUIT handlers here:
  // Earlier this file installed handlers that called process.exit(0)
  // synchronously. They fired BEFORE message-loop's async shutdown could
  // run, so all in-flight agent runs and child MCP servers were killed
  // ungracefully. systemd then waited TimeoutStopSec for the cgroup to
  // drain and SIGKILL'd ~10 stragglers. Removing those handlers lets
  // message-loop's shutdown() actually run.
  //
  // 'exit' is a synchronous Node hook that fires on any clean exit
  // (process.exit(), normal completion, uncaught exception that bubbles
  // out of the event loop). It runs AFTER all async work completes,
  // which is exactly when we want to release the lock.
  process.on('exit', () => {
    try {
      const cur = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      if (cur === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
  });
}

async function start(): Promise<void> {
  // Load built-in channels (self-registering on import)
  // Slack, Telegram, WhatsApp are now installable extensions
  await import('./channels/index.js');

  // Load built-in extensions (always present in core)
  await import('./cost-tracking/index.js');
  await import('./webhook/index.js');
  await import('./voice/index.js');

  // Load installable extensions from extensions/ directory
  await loadExtensions();

  // Start the orchestrator
  const { main } = await import('./orchestrator/message-loop.js');
  await main();
}

acquirePidLock();
start().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
