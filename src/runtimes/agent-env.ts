/**
 * Agent-runner environment contract.
 *
 * Single source of truth for the env vars that every Runtime backend MUST
 * expose to the spawned `node agent/runner/dist/index.js` process.
 *
 * **Why this exists:** the deleted sandbox-runner relied on a bind-mount
 * (`groupSessionsDir → /home/node/.claude`) as an INVISIBLE env-bridge for
 * the SDK's `CLAUDE_CONFIG_DIR`. When sandbox was removed (2026-05-06), this
 * convention was lost silently — host-runner had no equivalent for three
 * days, and DB-stored session IDs became unreachable. To prevent that class
 * of regression: any Runtime backend (host, container, deepseek, future)
 * that spawns the agent runner MUST call `buildAgentRunnerEnv()` and merge
 * its result into the spawned process env. Adding a new Runtime now
 * physically requires reading this contract.
 *
 * The function is pure (no fs / no spawn) and trivially unit-testable.
 */
import path from 'path';

/**
 * Logical name → host filesystem path. The agent runner falls back to
 * `/workspace/<logical-name>` (legacy container convention) if the
 * corresponding env var is missing — that fallback is wrong on host runtime,
 * so all relevant logical names MUST be present in the input.
 */
export interface HostPath {
  hostPath: string;
  logicalName: 'project' | 'group' | 'global' | 'ipc' | 'extra';
}

export interface BuildAgentRunnerEnvInput {
  /** Group folder name (used to build per-group CLAUDE_CONFIG_DIR) */
  groupFolder: string;
  /** Logical path mappings — at minimum `group` and `ipc` must be present */
  hostPaths: HostPath[];
  /** Secret values read from .env / pass — only the ones the agent needs */
  secrets: Record<string, string | undefined>;
  /** ClaudeClaw DATA_DIR (host filesystem path, used for sessions/ and ipc/) */
  dataDir: string;
  /** TZ env value (e.g. 'Europe/Moscow') */
  timezone: string;
}

/**
 * Build the env vars an agent runner needs. Returns a record that the caller
 * should merge into the spawned process env (typically: `{ ...process.env,
 * ...buildAgentRunnerEnv(...) }`).
 *
 * Guarantees on output:
 * - `TZ` is set to `input.timezone`
 * - `CLAUDE_CONFIG_DIR` is set to `<dataDir>/sessions/<groupFolder>/.claude`
 *   (this is the SDK's per-group session directory; without it, sessions
 *   stored in the ClaudeClaw DB become unreachable on resume)
 * - `CLAUDECLAW_<LOGICAL>_DIR` is set for each logical name present in
 *   `hostPaths` (group/ipc/project/global/extra)
 * - `CLAUDECLAW_EXT_TOOL_REQ_DIR` and `CLAUDECLAW_EXT_TOOL_RESP_DIR` are set
 *   to the shared extension-tool IPC bridge directories
 * - At most one of `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` is set
 *   (API key wins if both are present)
 * - Optional secrets (`HOMEASSISTANT_*`) only set if non-empty
 */
export function buildAgentRunnerEnv(
  input: BuildAgentRunnerEnvInput,
): Record<string, string> {
  const { groupFolder, hostPaths, secrets, dataDir, timezone } = input;
  const env: Record<string, string> = { TZ: timezone };

  // -------------------------------------------------------------------------
  // Logical path mapping (the runner uses these to resolve host-side paths
  // instead of falling back to /workspace/* container conventions).
  // -------------------------------------------------------------------------
  for (const p of hostPaths) {
    if (p.logicalName === 'group') env.CLAUDECLAW_GROUP_DIR = p.hostPath;
    else if (p.logicalName === 'ipc') env.CLAUDECLAW_IPC_DIR = p.hostPath;
    else if (p.logicalName === 'project')
      env.CLAUDECLAW_PROJECT_DIR = p.hostPath;
    else if (p.logicalName === 'global')
      env.CLAUDECLAW_GLOBAL_DIR = p.hostPath;
    else if (p.logicalName === 'extra')
      env.CLAUDECLAW_EXTRA_DIR = p.hostPath;
  }

  // -------------------------------------------------------------------------
  // Extension-tool IPC bridge — shared dirs across all groups, for cross-
  // process tool requests/responses initiated by extensions.
  // -------------------------------------------------------------------------
  env.CLAUDECLAW_EXT_TOOL_REQ_DIR = path.join(
    dataDir,
    'ipc',
    '_tool-requests',
  );
  env.CLAUDECLAW_EXT_TOOL_RESP_DIR = path.join(
    dataDir,
    'ipc',
    '_tool-responses',
  );

  // -------------------------------------------------------------------------
  // CRITICAL: per-group Claude SDK config dir.
  //
  // The SDK reads/writes session JSONLs at
  //   <CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/<uuid>.jsonl
  // Without per-group isolation, all groups would share ~/.claude/projects/
  // and DB-stored session IDs (which live under DATA_DIR/sessions/<folder>/)
  // would fail to resume with "No conversation found with session ID".
  //
  // Path MUST match groupSessionsDir in host-runner.ts buildHostPaths().
  // -------------------------------------------------------------------------
  env.CLAUDE_CONFIG_DIR = path.join(
    dataDir,
    'sessions',
    groupFolder,
    '.claude',
  );

  // -------------------------------------------------------------------------
  // Credentials. Mutually exclusive: ANTHROPIC_API_KEY wins over OAuth.
  //
  // Behaviour preserved from pre-extraction host-runner.ts: when no API key
  // is present, CLAUDE_CODE_OAUTH_TOKEN is ALWAYS set (possibly to ''). This
  // ensures the agent runner sees an explicit empty value rather than
  // inheriting some unrelated value from the parent process env.
  // -------------------------------------------------------------------------
  if (secrets.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  } else {
    env.CLAUDE_CODE_OAUTH_TOKEN =
      secrets.CLAUDE_CODE_OAUTH_TOKEN ||
      secrets.ANTHROPIC_AUTH_TOKEN ||
      '';
  }

  // -------------------------------------------------------------------------
  // Optional integration secrets. Only set if non-empty.
  // -------------------------------------------------------------------------
  if (secrets.HOMEASSISTANT_LLAT) {
    env.HOMEASSISTANT_LLAT = secrets.HOMEASSISTANT_LLAT;
  }
  if (secrets.HOMEASSISTANT_BASE_URL) {
    env.HOMEASSISTANT_BASE_URL = secrets.HOMEASSISTANT_BASE_URL;
  }

  return env;
}

/**
 * The set of secret env-var names this contract reads from `secrets`. Useful
 * for callers that read secrets from `.env` — pass this list to
 * `readEnvFile()` to ensure all relevant keys are loaded.
 */
export const AGENT_RUNNER_SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'HOMEASSISTANT_LLAT',
  'HOMEASSISTANT_BASE_URL',
] as const;
