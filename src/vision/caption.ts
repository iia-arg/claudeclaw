/**
 * Image captioning preprocessor for text-only runtimes.
 *
 * Why this exists:
 *   The DeepSeek runner and other text-only runtimes can't see images. The
 *   Telegram channel saves photos to disk and inserts a placeholder of the form
 *   `[Photo: /absolute/path/to/file.jpg]` into the message text. Without
 *   preprocessing the agent literally sees that path string and answers "I see
 *   only a path".
 *
 *   This module finds those placeholders, runs each image through OpenAI's
 *   gpt-4o-mini vision (cheap, fast, multilingual OCR), and rewrites the
 *   placeholder into a structured Russian-language description that the agent
 *   can reason about.
 *
 * Output format (replaces the original `[Photo: ...]` token):
 *   [Изображение]
 *   ОПИСАНИЕ: <1-2 sentence visual summary>
 *   ТЕКСТ_НА_ИЗОБРАЖЕНИИ: <verbatim text in original language(s), or "нет">
 *   ПЕРЕВОД: <Russian translation if original is not Russian>
 *   [/Изображение]
 *
 * Caching: SHA-256 of the file bytes → description, in-memory. The same image
 * sent twice (or referenced from history) is captioned once.
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import {
  estimateGpt4oMiniCost,
  logAuxRun,
} from '../cost-tracking/index.js';

const PHOTO_MARKER = /\[Photo:\s*([^\]]+)\]/g;
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const VISION_MODEL = 'gpt-4o-mini';
const MAX_FILE_BYTES = 18 * 1024 * 1024; // OpenAI hard limit ~20MB; leave headroom
const VISION_TIMEOUT_MS = 30_000;

const VISION_PROMPT = [
  'Опиши изображение для другого AI-агента, который не имеет доступа к самому файлу.',
  'Отвечай строго в формате:',
  'ОПИСАНИЕ: <1-2 предложения о содержимом изображения>',
  'ТЕКСТ_НА_ИЗОБРАЖЕНИИ: <дословная транскрипция всего видимого текста, на любом языке, включая иероглифы; или "нет" если текста нет>',
  'ПЕРЕВОД: <русский перевод текста, если оригинал не на русском; пропусти эту строку если текст уже на русском или его нет>',
  '',
  'Не добавляй ничего, кроме этих строк. Не используй markdown.',
].join('\n');

const captionCache = new Map<string, string>();

function getOpenAiKey(): string | null {
  // ClaudeClaw deliberately doesn't load .env into process.env (to keep secrets
  // out of child process environments), so we read straight from the .env file
  // first, then fall back to process.env, then to `pass`.
  const fromEnvFile = readEnvFile(['OPENAI_API_KEY'])['OPENAI_API_KEY'];
  if (fromEnvFile && fromEnvFile.trim()) return fromEnvFile.trim();
  const fromProcEnv = process.env.OPENAI_API_KEY;
  if (fromProcEnv && fromProcEnv.trim()) return fromProcEnv.trim();
  try {
    return execSync('pass show lightrag/openai-api-key', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

function fileSha256(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

async function captionOne(filePath: string): Promise<string> {
  if (!existsSync(filePath)) {
    return `[Изображение недоступно — файл не найден: ${filePath}]`;
  }
  const stats = statSync(filePath);
  if (stats.size > MAX_FILE_BYTES) {
    return `[Изображение слишком большое для обработки: ${(stats.size / 1024 / 1024).toFixed(1)} MB]`;
  }

  const hash = fileSha256(filePath);
  const cached = captionCache.get(hash);
  if (cached) return cached;

  const apiKey = getOpenAiKey();
  if (!apiKey) {
    logger.warn('vision: OPENAI_API_KEY missing — skipping caption');
    return `[Изображение: ${filePath}] (vision-обработчик недоступен)`;
  }

  const buf = readFileSync(filePath);
  const base64 = buf.toString('base64');
  const dataUrl = `data:${mimeFromPath(filePath)};base64,${base64}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);

  try {
    const resp = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 700,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: VISION_PROMPT },
              { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logger.error(
        { status: resp.status, body: body.slice(0, 300), filePath },
        'vision: OpenAI vision request failed',
      );
      return `[Изображение: ${filePath}] (ошибка vision API: ${resp.status})`;
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return `[Изображение: ${filePath}] (пустой ответ vision API)`;
    }

    const wrapped = `[Изображение]\n${text}\n[/Изображение]`;
    captionCache.set(hash, wrapped);
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    const cost = estimateGpt4oMiniCost(inputTokens, outputTokens);
    logger.info(
      {
        filePath,
        sizeBytes: stats.size,
        descChars: text.length,
        inputTokens,
        outputTokens,
        costUsd: cost.toFixed(6),
      },
      'vision: image captioned',
    );
    logAuxRun({
      service: 'openai-vision',
      model: VISION_MODEL,
      inputUnits: inputTokens,
      outputUnits: outputTokens,
      costUsd: cost,
      meta: { filePath, sizeBytes: stats.size, descChars: text.length },
    });
    return wrapped;
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      logger.warn({ filePath }, 'vision: OpenAI request timed out');
      return `[Изображение: ${filePath}] (vision API timeout)`;
    }
    logger.error({ err, filePath }, 'vision: caption failed');
    return `[Изображение: ${filePath}] (vision-обработчик упал: ${err?.message || 'unknown'})`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find every `[Photo: <path>]` placeholder in the prompt and replace it with
 * a vision-captioned block. Operates on a single string and returns a new
 * string with all replacements done in parallel.
 *
 * Failures inside individual captions are logged but never throw — the prompt
 * always returns in a usable shape.
 */
export async function captionImagesInPrompt(prompt: string): Promise<string> {
  if (!prompt || !PHOTO_MARKER.test(prompt)) {
    PHOTO_MARKER.lastIndex = 0;
    return prompt;
  }
  PHOTO_MARKER.lastIndex = 0;

  const matches: Array<{ full: string; path: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = PHOTO_MARKER.exec(prompt)) !== null) {
    matches.push({ full: m[0], path: m[1].trim(), index: m.index });
  }
  PHOTO_MARKER.lastIndex = 0;

  if (matches.length === 0) return prompt;

  // Caption all images in parallel
  const captions = await Promise.all(matches.map((x) => captionOne(x.path)));

  // Splice into the original string from the end so indices stay valid
  let result = prompt;
  for (let i = matches.length - 1; i >= 0; i--) {
    const { full, index } = matches[i];
    result =
      result.slice(0, index) + captions[i] + result.slice(index + full.length);
  }
  return result;
}
