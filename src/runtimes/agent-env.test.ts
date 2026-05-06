/**
 * Unit tests for the agent-runner env contract.
 *
 * Specifically guards against the regression that broke ClaudeClaw on
 * 2026-05-06 (commit a7f3537): host-runner forgot to set CLAUDE_CONFIG_DIR
 * after sandbox-runtime removal, so DB-stored session IDs became unreachable.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';

import {
  AGENT_RUNNER_SECRET_KEYS,
  buildAgentRunnerEnv,
  type HostPath,
} from './agent-env.js';

const DATA_DIR = '/tmp/cc-data';
const TZ = 'Europe/Moscow';

const fullPaths: HostPath[] = [
  { hostPath: '/host/groups/telegram_main', logicalName: 'group' },
  { hostPath: '/host/data/ipc/telegram_main', logicalName: 'ipc' },
  { hostPath: '/host/project', logicalName: 'project' },
  { hostPath: '/host/groups/global', logicalName: 'global' },
  { hostPath: '/host/extra-mount', logicalName: 'extra' },
];

describe('buildAgentRunnerEnv', () => {
  describe('CLAUDE_CONFIG_DIR (the regression-2026-05-06 guard)', () => {
    it('always sets CLAUDE_CONFIG_DIR to <dataDir>/sessions/<groupFolder>/.claude', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'telegram_main',
        hostPaths: fullPaths,
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });

      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(DATA_DIR, 'sessions', 'telegram_main', '.claude'),
      );
    });

    it('CLAUDE_CONFIG_DIR is per-group (different folder → different path)', () => {
      const a = buildAgentRunnerEnv({
        groupFolder: 'group_a',
        hostPaths: fullPaths,
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      const b = buildAgentRunnerEnv({
        groupFolder: 'group_b',
        hostPaths: fullPaths,
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });

      expect(a.CLAUDE_CONFIG_DIR).not.toBe(b.CLAUDE_CONFIG_DIR);
      expect(a.CLAUDE_CONFIG_DIR).toMatch(/sessions\/group_a\/\.claude$/);
      expect(b.CLAUDE_CONFIG_DIR).toMatch(/sessions\/group_b\/\.claude$/);
    });

    it('CLAUDE_CONFIG_DIR is set even when secrets and hostPaths are empty', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'minimal',
        hostPaths: [],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDE_CONFIG_DIR).toBe(
        path.join(DATA_DIR, 'sessions', 'minimal', '.claude'),
      );
    });
  });

  describe('TZ', () => {
    it('always sets TZ from input', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: 'America/Los_Angeles',
      });
      expect(env.TZ).toBe('America/Los_Angeles');
    });
  });

  describe('logical path mapping', () => {
    it('maps each logical name to its CLAUDECLAW_*_DIR env var', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: fullPaths,
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDECLAW_GROUP_DIR).toBe('/host/groups/telegram_main');
      expect(env.CLAUDECLAW_IPC_DIR).toBe('/host/data/ipc/telegram_main');
      expect(env.CLAUDECLAW_PROJECT_DIR).toBe('/host/project');
      expect(env.CLAUDECLAW_GLOBAL_DIR).toBe('/host/groups/global');
      expect(env.CLAUDECLAW_EXTRA_DIR).toBe('/host/extra-mount');
    });

    it('omits env vars for logical names not in input', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [
          { hostPath: '/host/g', logicalName: 'group' },
          { hostPath: '/host/ipc', logicalName: 'ipc' },
        ],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDECLAW_GROUP_DIR).toBe('/host/g');
      expect(env.CLAUDECLAW_IPC_DIR).toBe('/host/ipc');
      expect(env.CLAUDECLAW_PROJECT_DIR).toBeUndefined();
      expect(env.CLAUDECLAW_GLOBAL_DIR).toBeUndefined();
      expect(env.CLAUDECLAW_EXTRA_DIR).toBeUndefined();
    });

    it('last hostPath wins if duplicated logical name (e.g. multiple extras)', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [
          { hostPath: '/host/extra-1', logicalName: 'extra' },
          { hostPath: '/host/extra-2', logicalName: 'extra' },
        ],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDECLAW_EXTRA_DIR).toBe('/host/extra-2');
    });
  });

  describe('extension-tool IPC bridge', () => {
    it('sets the shared tool req/resp dirs based on dataDir', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: {},
        dataDir: '/cc/data',
        timezone: TZ,
      });
      expect(env.CLAUDECLAW_EXT_TOOL_REQ_DIR).toBe(
        '/cc/data/ipc/_tool-requests',
      );
      expect(env.CLAUDECLAW_EXT_TOOL_RESP_DIR).toBe(
        '/cc/data/ipc/_tool-responses',
      );
    });
  });

  describe('credentials (mutually exclusive ANTHROPIC_API_KEY vs OAuth)', () => {
    it('uses ANTHROPIC_API_KEY when present, omits CLAUDE_CODE_OAUTH_TOKEN', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: {
          ANTHROPIC_API_KEY: 'sk-ant-xxx',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-yyy',
        },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    });

    it('uses CLAUDE_CODE_OAUTH_TOKEN when no API key', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-yyy' },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-yyy');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('falls back to ANTHROPIC_AUTH_TOKEN if CLAUDE_CODE_OAUTH_TOKEN missing', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: { ANTHROPIC_AUTH_TOKEN: 'auth-zzz' },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('auth-zzz');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('sets CLAUDE_CODE_OAUTH_TOKEN to empty string when no creds at all (preserves pre-extraction behaviour)', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });
  });

  describe('optional integration secrets', () => {
    it('sets HOMEASSISTANT_LLAT only if non-empty', () => {
      const withVal = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: { HOMEASSISTANT_LLAT: 'eyJ...' },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(withVal.HOMEASSISTANT_LLAT).toBe('eyJ...');

      const without = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(without.HOMEASSISTANT_LLAT).toBeUndefined();
    });

    it('sets HOMEASSISTANT_BASE_URL only if non-empty', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: { HOMEASSISTANT_BASE_URL: 'http://1.2.3.4:8123' },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.HOMEASSISTANT_BASE_URL).toBe('http://1.2.3.4:8123');
    });

    it('skips empty-string secrets', () => {
      const env = buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets: { HOMEASSISTANT_LLAT: '', HOMEASSISTANT_BASE_URL: '' },
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(env.HOMEASSISTANT_LLAT).toBeUndefined();
      expect(env.HOMEASSISTANT_BASE_URL).toBeUndefined();
    });
  });

  describe('AGENT_RUNNER_SECRET_KEYS', () => {
    it('lists all secret keys the contract reads', () => {
      // If you add a new secret in buildAgentRunnerEnv, add it here too —
      // otherwise host-runner.ts won't preload it from .env.
      expect(AGENT_RUNNER_SECRET_KEYS).toEqual([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'HOMEASSISTANT_LLAT',
        'HOMEASSISTANT_BASE_URL',
      ]);
    });
  });

  describe('purity', () => {
    it('does not mutate the input secrets object', () => {
      const secrets = { ANTHROPIC_API_KEY: 'sk-x' };
      const before = { ...secrets };
      buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths: [],
        secrets,
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(secrets).toEqual(before);
    });

    it('does not mutate the input hostPaths array', () => {
      const hostPaths: HostPath[] = [
        { hostPath: '/x', logicalName: 'group' },
      ];
      const before = JSON.stringify(hostPaths);
      buildAgentRunnerEnv({
        groupFolder: 'g',
        hostPaths,
        secrets: {},
        dataDir: DATA_DIR,
        timezone: TZ,
      });
      expect(JSON.stringify(hostPaths)).toBe(before);
    });
  });
});
