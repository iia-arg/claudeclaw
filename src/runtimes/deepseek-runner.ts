/**
 * DeepSeek Runner for ClaudeClaw
 * Runs DeepSeek models via OpenAI-compatible API
 *
 * DeepSeek API: https://api-docs.deepseek.com/
 * - Endpoint: https://api.deepseek.com/chat/completions
 * - Models: deepseek-v4-pro (reasoning), deepseek-v4-flash (fast)
 * - OpenAI SDK compatible with base_url override
 */

import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { logger } from '../orchestrator/logger.js';
import { RegisteredGroup } from '../orchestrator/types.js';
import { resolveGroupFolderPath } from '../orchestrator/group-folder.js';
import { captionImagesInPrompt } from '../vision/caption.js';
import { ContainerInput, ContainerOutput } from './container-runner.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface DeepSeekConfig {
  model: string;
  enableReasoning: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
}

/**
 * Get DeepSeek API key from environment or pass store
 */
async function getDeepSeekApiKey(): Promise<string> {
  // Check environment first
  if (process.env.DEEPSEEK_API_KEY) {
    return process.env.DEEPSEEK_API_KEY;
  }

  // Fall back to pass store
  const { execSync } = await import('child_process');
  try {
    const key = execSync('pass show api/deepseek', { encoding: 'utf-8' }).trim();
    return key;
  } catch (err) {
    throw new Error('DeepSeek API key not found. Set DEEPSEEK_API_KEY or add to pass store at api/deepseek');
  }
}

/**
 * Load system prompt from group's CLAUDE.md
 */
function loadSystemPrompt(groupFolder: string): string {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');

  let systemPrompt = '';

  if (fs.existsSync(claudeMdPath)) {
    systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
  }

  return systemPrompt;
}

/**
 * Load conversation history from memory
 */
function loadConversationHistory(groupFolder: string, maxMessages: number = 20): DeepSeekMessage[] {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const historyPath = path.join(groupDir, 'memory', 'deepseek-history.json');

  if (!fs.existsSync(historyPath)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    // Return last N messages
    return (data.messages || []).slice(-maxMessages);
  } catch {
    return [];
  }
}

/**
 * Save conversation to history
 */
function saveConversationHistory(groupFolder: string, messages: DeepSeekMessage[]): void {
  const groupDir = resolveGroupFolderPath(groupFolder);
  const memoryDir = path.join(groupDir, 'memory');
  const historyPath = path.join(memoryDir, 'deepseek-history.json');

  fs.mkdirSync(memoryDir, { recursive: true });

  // Keep last 100 messages
  const trimmed = messages.slice(-100);
  fs.writeFileSync(historyPath, JSON.stringify({
    messages: trimmed,
    updatedAt: new Date().toISOString()
  }, null, 2));
}

/**
 * Call DeepSeek API
 */
async function callDeepSeek(
  messages: DeepSeekMessage[],
  config: DeepSeekConfig,
  apiKey: string,
): Promise<{ content: string; reasoning?: string; usage: { input: number; output: number } }> {
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: false,
  };

  // Enable reasoning mode for reasoner models
  if (config.enableReasoning) {
    requestBody.thinking = { type: 'enabled' };
    requestBody.reasoning_effort = config.reasoningEffort;
  }

  const response = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as {
    choices: Array<{
      message: {
        content: string;
        reasoning_content?: string;
      };
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
    };
  };

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error('No response from DeepSeek');
  }

  return {
    content: choice.message.content,
    reasoning: choice.message.reasoning_content,
    usage: {
      input: data.usage?.prompt_tokens || 0,
      output: data.usage?.completion_tokens || 0,
    },
  };
}

/**
 * Run DeepSeek agent for a group
 */
export async function runDeepSeekAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  _onProcess?: (proc: ChildProcess, processName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  try {
    const apiKey = await getDeepSeekApiKey();

    // Load system prompt
    const systemPrompt = loadSystemPrompt(input.groupFolder);

    // Load conversation history
    const history = loadConversationHistory(input.groupFolder);

    // Build messages array
    const messages: DeepSeekMessage[] = [];

    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Add history
    messages.push(...history);

    // Caption any inline `[Photo: <path>]` markers via vision so a text-only
    // model can reason about images. Failures inside the captioner never throw —
    // worst case the original placeholder is preserved.
    const enrichedPrompt = await captionImagesInPrompt(input.prompt);
    if (enrichedPrompt !== input.prompt) {
      logger.info(
        { group: group.name, originalChars: input.prompt.length, enrichedChars: enrichedPrompt.length },
        'DeepSeek: prompt enriched with image captions',
      );
    }

    // Add current user message (with captions, if any)
    messages.push({ role: 'user', content: enrichedPrompt });

    // Get config from agentConfig
    const agentConfig = input.agentConfig || {};
    const config: DeepSeekConfig = {
      model: (agentConfig as Record<string, unknown>).deepseekModel as string || 'deepseek-v4-pro',
      enableReasoning: (agentConfig as Record<string, unknown>).deepseekReasoning !== false,
      reasoningEffort: ((agentConfig as Record<string, unknown>).deepseekEffort as 'low' | 'medium' | 'high') || 'high',
    };

    logger.info({ group: group.name, model: config.model, reasoning: config.enableReasoning }, 'Calling DeepSeek API');

    // Call API
    const result = await callDeepSeek(messages, config, apiKey);

    logger.info({
      group: group.name,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      hasReasoning: !!result.reasoning,
    }, 'DeepSeek response received');

    // Save to history (without system prompt). Persist the *enriched* prompt
    // so future turns retain the image description instead of the raw path —
    // that way the agent can reference past photos in a continuing conversation.
    const newHistory = [...history,
      { role: 'user' as const, content: enrichedPrompt },
      { role: 'assistant' as const, content: result.content }
    ];
    saveConversationHistory(input.groupFolder, newHistory);

    const durationMs = Date.now() - startTime;

    const finalOutput: ContainerOutput = {
      status: 'success',
      result: result.content,
      usage: {
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
      },
      durationMs,
      turns: 1,
    };

    // Stream output to caller (so message gets routed to Telegram/etc.)
    // This is what Claude/Sandbox runners do — DeepSeek must do the same.
    if (onOutput) {
      await onOutput(finalOutput);
    }

    return finalOutput;

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, error: errorMessage }, 'DeepSeek agent error');

    return {
      status: 'error',
      result: null,
      error: errorMessage,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Check if DeepSeek runtime is available
 */
export async function ensureDeepSeekAvailable(): Promise<void> {
  try {
    await getDeepSeekApiKey();
    logger.info('DeepSeek runtime available');
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'DeepSeek runtime not available');
    throw err;
  }
}
