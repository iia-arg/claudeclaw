import { registerExtension } from '../orchestrator/extensions.js';
import { getDb } from '../orchestrator/db.js';
import { logger } from '../orchestrator/logger.js';

registerExtension({
  name: 'cost-tracking',
  dbSchema: [
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      trigger_type TEXT NOT NULL DEFAULT 'message',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      turns INTEGER DEFAULT 0,
      model TEXT,
      status TEXT NOT NULL,
      run_at TEXT NOT NULL
    )`,
    // Auxiliary service runs — small per-call costs from non-agent services
    // (TTS, vision-OCR, embeddings, etc.) that are still worth tracking.
    `CREATE TABLE IF NOT EXISTS aux_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,           -- 'fish-audio-tts' | 'openai-vision' | ...
      model TEXT,                      -- e.g. 's1', 'gpt-4o-mini'
      group_folder TEXT,               -- nullable, for cross-group services
      chat_jid TEXT,
      input_units INTEGER DEFAULT 0,   -- bytes for TTS, prompt_tokens for OpenAI
      output_units INTEGER DEFAULT 0,  -- 0 for TTS, completion_tokens for OpenAI
      cost_usd REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      meta TEXT,                       -- optional JSON for extras (file path, etc.)
      run_at TEXT NOT NULL
    )`,
  ],
});

// Anthropic pricing (USD per million tokens) — update as pricing changes
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  sonnet: { input: 3, output: 15, cacheRead: 0.3 },
  opus: { input: 15, output: 75, cacheRead: 0.3 },
  haiku: { input: 0.25, output: 1.25, cacheRead: 0.03 },
};

function estimateCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number {
  const key = (model || 'sonnet').toLowerCase();
  const tier = Object.entries(PRICING).find(([k]) => key.includes(k))?.[1] || PRICING.sonnet;
  return (
    (inputTokens / 1_000_000) * tier.input +
    (outputTokens / 1_000_000) * tier.output +
    (cacheReadTokens / 1_000_000) * tier.cacheRead
  );
}

export interface AgentRunRecord {
  groupFolder: string;
  chatJid: string;
  triggerType: 'message' | 'scheduled' | 'webhook';
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  turns: number;
  model?: string;
  status: 'success' | 'error' | 'timeout';
}

// ---------------------------------------------------------------------------
// Auxiliary service runs (TTS, vision OCR, etc.)
// ---------------------------------------------------------------------------

export interface AuxRunRecord {
  service: string;
  model?: string;
  groupFolder?: string;
  chatJid?: string;
  inputUnits?: number;
  outputUnits?: number;
  costUsd: number;
  status?: 'success' | 'error';
  meta?: Record<string, unknown>;
}

export function logAuxRun(record: AuxRunRecord): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO aux_runs (service, model, group_folder, chat_jid, input_units, output_units, cost_usd, status, meta, run_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.service,
        record.model || null,
        record.groupFolder || null,
        record.chatJid || null,
        record.inputUnits || 0,
        record.outputUnits || 0,
        record.costUsd,
        record.status || 'success',
        record.meta ? JSON.stringify(record.meta) : null,
        new Date().toISOString(),
      );
    logger.debug(
      { service: record.service, cost: record.costUsd.toFixed(6) },
      'Aux run logged',
    );
  } catch (err) {
    logger.warn({ err, service: record.service }, 'Failed to log aux run');
  }
}

// Pricing helpers exported for other modules
export const FISH_AUDIO_USD_PER_BYTE = 15 / 1_000_000; // $15 / 1M UTF-8 bytes
export const GPT_4O_MINI_INPUT_USD_PER_TOKEN = 0.15 / 1_000_000;
export const GPT_4O_MINI_OUTPUT_USD_PER_TOKEN = 0.6 / 1_000_000;

export function estimateFishAudioCost(text: string): number {
  return Buffer.byteLength(text, 'utf-8') * FISH_AUDIO_USD_PER_BYTE;
}

export function estimateGpt4oMiniCost(
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    inputTokens * GPT_4O_MINI_INPUT_USD_PER_TOKEN +
    outputTokens * GPT_4O_MINI_OUTPUT_USD_PER_TOKEN
  );
}

// ---------------------------------------------------------------------------

export function logAgentRun(record: AgentRunRecord): void {
  try {
    const cost = estimateCost(
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
    );
    getDb().prepare(
      `INSERT INTO agent_runs (group_folder, chat_jid, trigger_type, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, duration_ms, turns, model, status, run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.groupFolder,
      record.chatJid,
      record.triggerType,
      record.inputTokens,
      record.outputTokens,
      record.cacheCreationTokens,
      record.cacheReadTokens,
      cost,
      record.durationMs,
      record.turns,
      record.model || null,
      record.status,
      new Date().toISOString(),
    );
    logger.debug(
      { group: record.groupFolder, cost: cost.toFixed(4), tokens: record.inputTokens + record.outputTokens },
      'Agent run logged',
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to log agent run cost');
  }
}
