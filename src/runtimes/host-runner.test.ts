/**
 * Unit tests for host-runner.
 *
 * The most important test class is the env-passing assertion: this is the
 * regression guard for the 2026-05-06 incident, where host-runner forgot
 * to set CLAUDE_CONFIG_DIR after sandbox-runtime removal and DB-stored
 * session IDs became unreachable. The test mocks `child_process.spawn` and
 * inspects the `env` argument it received.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import path from 'path';

const TEST_DATA_DIR = '/tmp/cc-host-test-data';
const TEST_GROUPS_DIR = '/tmp/cc-host-test-groups';
const TEST_TZ = 'America/Los_Angeles';

// vi.hoisted() lifts these alongside the vi.mock() calls so the factories
// can reference them. Top-level const cannot be referenced from a hoisted
// vi.mock() factory.
const hoisted = vi.hoisted(() => {
  return {
    DATA_DIR: '/tmp/cc-host-test-data',
    GROUPS_DIR: '/tmp/cc-host-test-groups',
    TIMEZONE: 'America/Los_Angeles',
    readEnvFileMock: vi.fn(
      (_keys: string[]) => ({}) as Record<string, string>,
    ),
    spawnMock: vi.fn(),
  };
});

vi.mock('../orchestrator/config.js', () => ({
  CODE_ROOT: '/tmp/cc-host-test-code',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000,
  DATA_DIR: hoisted.DATA_DIR,
  GROUPS_DIR: hoisted.GROUPS_DIR,
  IDLE_TIMEOUT: 1800000,
  TIMEZONE: hoisted.TIMEZONE,
}));

vi.mock('../orchestrator/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../orchestrator/group-folder.js', async () => {
  const p = await vi.importActual<typeof import('path')>('path');
  return {
    resolveGroupFolderPath: (folder: string) =>
      p.join(hoisted.GROUPS_DIR, folder),
    resolveGroupIpcPath: (folder: string) =>
      p.join(hoisted.DATA_DIR, 'ipc', folder),
  };
});

vi.mock('../orchestrator/mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

vi.mock('../orchestrator/env.js', () => ({
  readEnvFile: (keys: string[]) => hoisted.readEnvFileMock(keys),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      cpSync: vi.fn(),
      unlinkSync: vi.fn(),
    },
  };
});

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    killed: boolean;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.killed = false;
  proc.pid = 54321;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      hoisted.spawnMock(...args);
      return fakeProc;
    },
  };
});

import { runHostAgent } from './host-runner.js';
import type { RegisteredGroup } from '../orchestrator/types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'telegram_main',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'telegram_main',
  chatJid: 'test@g.us',
  isMain: true,
};

function lastSpawnEnv(): Record<string, string> {
  expect(hoisted.spawnMock).toHaveBeenCalled();
  const call = hoisted.spawnMock.mock.calls[hoisted.spawnMock.mock.calls.length - 1];
  const opts = call[2] as { env: Record<string, string> };
  return opts.env;
}

/**
 * Drive the spawned fake-process through to a successful exit so the
 * runHostAgent promise resolves, allowing the test to await it.
 */
function completeFakeProcess(output = '{"status":"success","result":null}') {
  fakeProc.stdout.push(`---CLAUDECLAW_OUTPUT_START---\n${output}\n---CLAUDECLAW_OUTPUT_END---\n`);
  // emit close in a microtask so listeners attached after spawn see it
  setImmediate(() => fakeProc.emit('close', 0));
}

describe('runHostAgent — env contract', () => {
  beforeEach(() => {
    hoisted.spawnMock.mockClear();
    hoisted.readEnvFileMock.mockReset();
    hoisted.readEnvFileMock.mockReturnValue({});
    fakeProc = createFakeProcess();
  });

  describe('CLAUDE_CONFIG_DIR (regression-2026-05-06 guard)', () => {
    it('is set to <DATA_DIR>/sessions/<folder>/.claude on the spawned process env', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(TEST_DATA_DIR, 'sessions', 'telegram_main', '.claude'),
      );
    });

    it('changes per group.folder', async () => {
      const otherGroup: RegisteredGroup = {
        ...testGroup,
        folder: 'zhizn_server',
      };
      const promise = runHostAgent(
        otherGroup,
        { ...testInput, groupFolder: 'zhizn_server', isMain: false },
        () => {},
      );
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(TEST_DATA_DIR, 'sessions', 'zhizn_server', '.claude'),
      );
    });
  });

  describe('CLAUDECLAW_*_DIR path env vars', () => {
    it('sets GROUP_DIR + IPC_DIR for non-main groups', async () => {
      const promise = runHostAgent(
        { ...testGroup, folder: 'sub' },
        { ...testInput, groupFolder: 'sub', isMain: false },
        () => {},
      );
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDECLAW_GROUP_DIR).toBe(
        path.join(TEST_GROUPS_DIR, 'sub'),
      );
      expect(env.CLAUDECLAW_IPC_DIR).toBe(
        path.join(TEST_DATA_DIR, 'ipc', 'sub'),
      );
    });

    it('sets PROJECT_DIR + GROUP_DIR for main group', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDECLAW_PROJECT_DIR).toBe(process.cwd());
      expect(env.CLAUDECLAW_GROUP_DIR).toBe(
        path.join(TEST_GROUPS_DIR, 'telegram_main'),
      );
    });

    it('sets the extension-tool IPC bridge dirs', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDECLAW_EXT_TOOL_REQ_DIR).toBe(
        path.join(TEST_DATA_DIR, 'ipc', '_tool-requests'),
      );
      expect(env.CLAUDECLAW_EXT_TOOL_RESP_DIR).toBe(
        path.join(TEST_DATA_DIR, 'ipc', '_tool-responses'),
      );
    });
  });

  describe('TZ', () => {
    it('forwards the configured TIMEZONE', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.TZ).toBe(TEST_TZ);
    });
  });

  describe('credentials', () => {
    it('reads all AGENT_RUNNER_SECRET_KEYS from .env', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      expect(hoisted.readEnvFileMock).toHaveBeenCalledTimes(1);
      const keysAsked = hoisted.readEnvFileMock.mock.calls[0][0];
      expect(keysAsked).toEqual(
        expect.arrayContaining([
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN',
          'HOMEASSISTANT_LLAT',
          'HOMEASSISTANT_BASE_URL',
        ]),
      );
    });

    it('forwards ANTHROPIC_API_KEY when present in .env', async () => {
      hoisted.readEnvFileMock.mockReturnValue({ ANTHROPIC_API_KEY: 'sk-ant-test' });
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    });

    it('forwards CLAUDE_CODE_OAUTH_TOKEN when no API key present', async () => {
      hoisted.readEnvFileMock.mockReturnValue({
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-tok',
      });
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-test-tok');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  describe('process.env preservation', () => {
    it('inherits parent process.env (e.g. PATH) and overlays agent env', async () => {
      const originalPath = process.env.PATH;
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      const env = lastSpawnEnv();
      // PATH inherited from parent
      expect(env.PATH).toBe(originalPath);
      // Agent-specific overlay still present
      expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
    });
  });

  describe('spawn invocation', () => {
    it('spawns node with the agent runner path and pipe stdio', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      completeFakeProcess();
      await promise;

      expect(hoisted.spawnMock).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = hoisted.spawnMock.mock.calls[0] as [
        string,
        string[],
        { stdio: unknown },
      ];
      expect(cmd).toBe('node');
      expect(args[0]).toMatch(/agent\/runner\/dist\/index\.js$/);
      expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    });
  });

  describe('exit code propagation', () => {
    it('non-zero exit code resolves with status=error', async () => {
      const promise = runHostAgent(testGroup, testInput, () => {});
      // No success output; just emit a non-zero close
      setImmediate(() => fakeProc.emit('close', 1));
      const result = await promise;
      expect(result.status).toBe('error');
      expect(result.error).toMatch(/exited with code 1/);
    });
  });
});
