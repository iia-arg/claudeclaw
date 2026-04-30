/**
 * Voice extension — orchestrator-level TTS for agents that can't call agent-speak.
 *
 * Why this exists:
 *   The DeepSeek runtime (Chaynaya) has no Bash tools, so the agent cannot invoke
 *   the agent-speak CLI to synthesize audio itself. This extension catches a
 *   trailing `[озвучить]` marker on outbound text, strips it, and fires off a
 *   Fish Audio synthesis + Telegram sendAudio in parallel with normal text
 *   delivery. For sandbox/container groups the agent-speak Bash helper is still
 *   the recommended path; this hook is generic and only activates when:
 *     1. The text ends with `[озвучить]` (or `[speak]`)
 *     2. The group has a voice configured in voices.json
 *
 * Wiring:
 *   - Voice mapping: ~/.config/agent-speak/voices.json (shared with agent-speak)
 *   - Fish Audio key: FISH_AUDIO_API_KEY env (from .env via pass-sync-env)
 *   - Telegram token: TELEGRAM_BOT_TOKEN env (already present)
 *
 * Behavior:
 *   - Text version is always delivered (with the marker stripped).
 *   - Audio is delivered as a side-effect (fire-and-forget) so synthesis latency
 *     does not delay the text response.
 *   - All failures are logged but never break message delivery.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerExtension } from '../orchestrator/extensions.js';
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import type { HookResult, OutboundEnvelope } from '../orchestrator/types.js';
import {
  estimateFishAudioCost,
  logAuxRun,
} from '../cost-tracking/index.js';

// Match ANY occurrence of the voice marker (case-insensitive, with optional
// whitespace inside the brackets). We use the LAST match, then strip it and
// everything after it. This makes the trigger forgiving: even if the agent
// puts the marker mid-message followed by stage directions or extra text,
// the audio version corresponds to the body BEFORE the marker.
const VOICE_MARKER = /\[\s*(озвучить|speak)\s*\]/gi;
const MAX_TTS_CHARS = 3000;
const FISH_TTS_URL = 'https://api.fish.audio/v1/tts';
const FISH_MODEL = 's1';
const VOICE_CACHE_MS = 60_000;

let cachedVoices: Record<string, string> | null = null;
let voicesLoadedAt = 0;

function loadVoices(): Record<string, string> {
  const now = Date.now();
  if (cachedVoices && now - voicesLoadedAt < VOICE_CACHE_MS) {
    return cachedVoices;
  }
  const configPath =
    process.env.AGENT_SPEAK_CONFIG ||
    join(homedir(), '.config', 'agent-speak', 'voices.json');
  try {
    if (!existsSync(configPath)) {
      cachedVoices = {};
    } else {
      const raw = readFileSync(configPath, 'utf-8');
      cachedVoices = JSON.parse(raw);
    }
    voicesLoadedAt = now;
  } catch (err) {
    logger.error({ err, configPath }, 'voice: failed to load voices.json');
    cachedVoices = {};
  }
  return cachedVoices ?? {};
}

/**
 * Read a secret without touching process.env. ClaudeClaw deliberately keeps
 * secrets out of process.env (so they don't leak to child processes), so we
 * pull from the same `.env` file the core uses, with a `pass` fallback.
 */
function readSecret(envKey: string, passPath: string): string | null {
  const fromEnvFile = readEnvFile([envKey])[envKey];
  if (fromEnvFile && fromEnvFile.trim()) return fromEnvFile.trim();
  const fromProcEnv = process.env[envKey];
  if (fromProcEnv && fromProcEnv.trim()) return fromProcEnv.trim();
  try {
    return execSync(`pass show ${passPath}`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

function parseTelegramJid(
  jid: string,
): { chatId: string; threadId?: string } | null {
  if (!jid.startsWith('tg:')) return null;
  const rest = jid.slice(3);
  const parts = rest.split(':');
  if (parts.length === 0 || !parts[0]) return null;
  return parts.length >= 2
    ? { chatId: parts[0], threadId: parts[1] }
    : { chatId: parts[0] };
}

/**
 * Strip markdown so TTS reads natural prose, not symbols.
 * Conservative — keeps punctuation that influences intonation.
 */
function stripMarkdownForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks → drop
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1') // italics
    .replace(/_([^_\n]+)_/g, '$1') // underscore italics
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*>\s?/gm, '') // blockquotes
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function synthesizeAndSend(
  text: string,
  voiceId: string,
  chatJid: string,
  groupFolder: string | undefined,
): Promise<void> {
  const fishKey = readSecret('FISH_AUDIO_API_KEY', 'api/fish-audio-main');
  if (!fishKey) {
    logger.warn('voice: no Fish Audio API key — skipping synthesis');
    return;
  }
  const tgToken = readSecret(
    'TELEGRAM_BOT_TOKEN',
    'claudeclaw/telegram-bot-token',
  );
  if (!tgToken) {
    logger.warn('voice: no TELEGRAM_BOT_TOKEN — skipping synthesis');
    return;
  }
  const tg = parseTelegramJid(chatJid);
  if (!tg) {
    logger.warn(
      { jid: chatJid },
      'voice: not a Telegram JID — skipping synthesis',
    );
    return;
  }

  // 1) Synthesize via Fish Audio
  const ttsResp = await fetch(FISH_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${fishKey}`,
      'Content-Type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId,
      format: 'mp3',
    }),
  });
  if (!ttsResp.ok) {
    const body = await ttsResp.text().catch(() => '');
    logger.error(
      { status: ttsResp.status, body: body.slice(0, 200) },
      'voice: Fish Audio TTS failed',
    );
    return;
  }
  const audioBuf = Buffer.from(await ttsResp.arrayBuffer());

  // 2) Upload to Telegram
  const form = new FormData();
  form.append('chat_id', tg.chatId);
  if (tg.threadId) form.append('message_thread_id', tg.threadId);
  form.append(
    'audio',
    new Blob([audioBuf], { type: 'audio/mpeg' }),
    'voice.mp3',
  );

  const tgResp = await fetch(
    `https://api.telegram.org/bot${tgToken}/sendAudio`,
    { method: 'POST', body: form },
  );
  if (!tgResp.ok) {
    const body = await tgResp.text().catch(() => '');
    logger.error(
      { status: tgResp.status, body: body.slice(0, 200) },
      'voice: Telegram sendAudio failed',
    );
    return;
  }
  const cost = estimateFishAudioCost(text);
  logger.info(
    { chars: text.length, chatJid, costUsd: cost.toFixed(6) },
    'voice: audio delivered',
  );
  logAuxRun({
    service: 'fish-audio-tts',
    model: FISH_MODEL,
    groupFolder,
    chatJid,
    inputUnits: Buffer.byteLength(text, 'utf-8'),
    costUsd: cost,
    meta: { voiceId, chars: text.length },
  });
}

registerExtension({
  name: 'voice',
  envKeys: ['FISH_AUDIO_API_KEY'],
  hooks: {
    preRoute: async (
      envelope: OutboundEnvelope,
    ): Promise<HookResult<OutboundEnvelope>> => {
      // Use the LAST occurrence of the marker. Anything after it (stage
      // directions, fake transcripts, etc.) is dropped — the spoken audio is
      // exactly the body before the marker.
      const matches = [...envelope.text.matchAll(VOICE_MARKER)];
      if (matches.length === 0) {
        return { action: 'continue' };
      }
      const last = matches[matches.length - 1];
      if (last.index === undefined) return { action: 'continue' };

      const cleanText = envelope.text.slice(0, last.index).trim();

      // No real content before the marker — nothing useful to say or write.
      if (!cleanText) return { action: 'continue' };

      const groupFolder = envelope.groupFolder;
      // Without a group context we can't pick a voice; just deliver text.
      if (!groupFolder) {
        return {
          action: 'modify',
          envelope: { ...envelope, text: cleanText },
        };
      }

      const voices = loadVoices();
      const voiceId = voices[groupFolder];
      if (!voiceId) {
        logger.debug(
          { groupFolder },
          'voice: marker present but no voice configured for group — text only',
        );
        return {
          action: 'modify',
          envelope: { ...envelope, text: cleanText },
        };
      }

      const spokenText = stripMarkdownForTts(cleanText);

      if (!spokenText) {
        return {
          action: 'modify',
          envelope: { ...envelope, text: cleanText },
        };
      }

      if (spokenText.length > MAX_TTS_CHARS) {
        logger.warn(
          { groupFolder, chars: spokenText.length, max: MAX_TTS_CHARS },
          'voice: text exceeds TTS limit — delivering text only',
        );
        return {
          action: 'modify',
          envelope: { ...envelope, text: cleanText },
        };
      }

      // Fire-and-forget: do not block text delivery on audio synthesis.
      void synthesizeAndSend(
        spokenText,
        voiceId,
        envelope.chatJid,
        groupFolder,
      ).catch((err) =>
        logger.error({ err }, 'voice: synthesis pipeline failed'),
      );

      return {
        action: 'modify',
        envelope: { ...envelope, text: cleanText },
      };
    },
  },
});
