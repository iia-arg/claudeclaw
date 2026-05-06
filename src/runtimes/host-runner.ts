/**
 * Host runtime for ClaudeClaw.
 *
 * Spawns the pre-compiled agent runner directly on the host (no container,
 * no sandbox). This is the replacement for the previous sandbox-runner —
 * @anthropic-ai/sandbox-runtime was removed because its hard-coded BPF
 * blocklist on AF_UNIX broke libreoffice / dconf / GTK and the office toolkit
 * the agents rely on. Isolation is now enforced via behavioral policy
 * (preamble + per-group systemPrompt) rather than OS-level sandboxing.
 *
 * Notes:
 * - No network or filesystem isolation at OS level.
 * - Agent runner pre-compiled at agent/runner/dist/index.js.
 * - Host paths exposed via CLAUDECLAW_*_DIR env vars (the runner used to
 *   resolve container paths like /workspace/group; now it follows env vars).
 * - Orphan cleanup via PID files in data/host-pids/.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../orchestrator/env.js';
import {
  CODE_ROOT,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from '../orchestrator/config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../orchestrator/group-folder.js';
import { logger } from '../orchestrator/logger.js';
import { validateAdditionalMounts } from '../orchestrator/mount-security.js';
import { RegisteredGroup } from '../orchestrator/types.js';
import type { ContainerInput, ContainerOutput } from './container-runner.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CLAUDECLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CLAUDECLAW_OUTPUT_END---';

const HOST_PID_DIR = path.join(DATA_DIR, 'host-pids');

// ---------------------------------------------------------------------------
// Path resolution (mirrors container-runner.ts buildVolumeMounts but only
// records host→logical-name mapping for env-var injection)
// ---------------------------------------------------------------------------

interface HostPath {
  hostPath: string;
  logicalName: 'project' | 'group' | 'global' | 'ipc' | 'extra';
}

function buildHostPaths(group: RegisteredGroup, isMain: boolean): HostPath[] {
  const paths: HostPath[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    paths.push({ hostPath: projectRoot, logicalName: 'project' });
    paths.push({ hostPath: groupDir, logicalName: 'group' });
  } else {
    paths.push({ hostPath: groupDir, logicalName: 'group' });
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      paths.push({ hostPath: globalDir, logicalName: 'global' });
    }
  }

  // Per-group IPC namespace
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  paths.push({ hostPath: groupIpcDir, logicalName: 'ipc' });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Ensure settings.json exists
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from agent/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'agent', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Additional mounts validated against external allowlist (kept for parity
  // with container-runner — host runner doesn't enforce them at OS level
  // but still records them for the runner to see).
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    for (const vm of validatedMounts) {
      paths.push({ hostPath: vm.hostPath, logicalName: 'extra' });
    }
  }

  return paths;
}

// ---------------------------------------------------------------------------
// Orphan cleanup
// ---------------------------------------------------------------------------

export function cleanupHostOrphans(): void {
  if (!fs.existsSync(HOST_PID_DIR)) return;

  const pidFiles = fs
    .readdirSync(HOST_PID_DIR)
    .filter((f) => f.endsWith('.pid'));
  const killed: string[] = [];

  for (const file of pidFiles) {
    const pidPath = path.join(HOST_PID_DIR, file);
    try {
      const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
      if (isNaN(pid)) {
        fs.unlinkSync(pidPath);
        continue;
      }
      try {
        process.kill(pid, 0); // existence check
        process.kill(pid, 'SIGTERM');
        killed.push(file.replace('.pid', ''));
      } catch {
        // Process already dead
      }
      fs.unlinkSync(pidPath);
    } catch {
      try {
        fs.unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }
  }

  if (killed.length > 0) {
    logger.info(
      { count: killed.length, names: killed },
      'Stopped orphaned host agent processes',
    );
  }
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runHostAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const groupDir = resolveGroupFolderPath(input.groupFolder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `claudeclaw-host-${safeName}-${Date.now()}`;

  const hostPaths = buildHostPaths(group, input.isMain);

  const agentRunnerPath = path.join(
    CODE_ROOT,
    'agent',
    'runner',
    'dist',
    'index.js',
  );

  logger.info(
    {
      group: group.name,
      processName,
      pathCount: hostPaths.length,
      isMain: input.isMain,
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    // Map logical names to host paths via env vars (the runner falls back
    // to /workspace/* container paths if these env vars are missing).
    const pathEnv: Record<string, string> = {};
    for (const p of hostPaths) {
      if (p.logicalName === 'group') pathEnv.CLAUDECLAW_GROUP_DIR = p.hostPath;
      else if (p.logicalName === 'ipc') pathEnv.CLAUDECLAW_IPC_DIR = p.hostPath;
      else if (p.logicalName === 'project')
        pathEnv.CLAUDECLAW_PROJECT_DIR = p.hostPath;
      else if (p.logicalName === 'global')
        pathEnv.CLAUDECLAW_GLOBAL_DIR = p.hostPath;
      else if (p.logicalName === 'extra')
        pathEnv.CLAUDECLAW_EXTRA_DIR = p.hostPath;
    }
    // Shared dirs for the extension-tool bridge (request/response IPC).
    pathEnv.CLAUDECLAW_EXT_TOOL_REQ_DIR = path.join(
      DATA_DIR,
      'ipc',
      '_tool-requests',
    );
    pathEnv.CLAUDECLAW_EXT_TOOL_RESP_DIR = path.join(
      DATA_DIR,
      'ipc',
      '_tool-responses',
    );

    // Per-group Claude SDK config dir — isolates sessions/projects per group.
    // Mirrors what the deleted sandbox-runner achieved via the
    // /home/node/.claude bind-mount: the SDK reads/writes session JSONLs
    // under <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl.
    // Without this, all groups would share ~/.claude/projects/ and any
    // sessionId stored in the DB that lives under DATA_DIR/sessions/<folder>/
    // would fail to resume with "No conversation found with session ID".
    // Path matches groupSessionsDir constructed in buildHostPaths().
    pathEnv.CLAUDE_CONFIG_DIR = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      '.claude',
    );

    // Real credentials passed directly (no proxy on host).
    const secrets = readEnvFile([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'HOMEASSISTANT_LLAT',
      'HOMEASSISTANT_BASE_URL',
    ]);

    const child = spawn('node', [agentRunnerPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TZ: TIMEZONE,
        ...(secrets.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: secrets.ANTHROPIC_API_KEY }
          : {
              CLAUDE_CODE_OAUTH_TOKEN:
                secrets.CLAUDE_CODE_OAUTH_TOKEN ||
                secrets.ANTHROPIC_AUTH_TOKEN ||
                '',
            }),
        ...(secrets.HOMEASSISTANT_LLAT
          ? { HOMEASSISTANT_LLAT: secrets.HOMEASSISTANT_LLAT }
          : {}),
        ...(secrets.HOMEASSISTANT_BASE_URL
          ? { HOMEASSISTANT_BASE_URL: secrets.HOMEASSISTANT_BASE_URL }
          : {}),
        ...pathEnv,
      },
    });

    // Write PID file for orphan cleanup
    fs.mkdirSync(HOST_PID_DIR, { recursive: true });
    const pidFile = path.join(HOST_PID_DIR, `${processName}.pid`);
    if (child.pid) {
      fs.writeFileSync(pidFile, String(child.pid));
    }

    onProcess(child, processName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let hadStreamingOutput = false;
    let newSessionId: string | undefined;

    child.stdin!.write(JSON.stringify(input));
    child.stdin!.end();

    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processName },
        'Host agent timeout, killing',
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // Streaming output parsing
    let parseBuffer = '';
    let outputChain = Promise.resolve();

    child.stdout!.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Host agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while (
          (startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1
        ) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse host agent output chunk',
            );
          }
        }
      }
    });

    child.stderr!.on('data', (data) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split('\n')) {
        if (line) logger.debug({ host: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Host agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    child.on('close', (code) => {
      clearTimeout(timeout);
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }

      const duration = Date.now() - startTime;

      if (timedOut) {
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, processName, duration, code },
            'Host agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }
        logger.error(
          { group: group.name, processName, duration, code },
          'Host agent timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr },
          'Host agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Host agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Host agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy mode: parse last output marker pair
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }
        resolve(JSON.parse(jsonLine));
      } catch (err) {
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse host agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* ignore */
      }
      resolve({
        status: 'error',
        result: null,
        error: `Host agent spawn error: ${err.message}`,
      });
    });
  });
}
