import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';
import { markdownToTelegramHtml } from './telegram-html.js';

const execFileAsync = promisify(execFile);

/**
 * Local Whisper transcription. Path is configurable via WHISPER_TRANSCRIBER
 * env var; defaults to /usr/local/bin/transcribe-local-shared. Returns
 * transcribed text or null on failure (transcriber missing, network down,
 * ffmpeg missing, etc.).
 */
async function transcribeTelegramAudio(
  fileId: string,
  api: Api,
  botToken: string,
  language = 'ru',
): Promise<string | null> {
  const TRANSCRIBER =
    process.env.WHISPER_TRANSCRIBER || '/usr/local/bin/transcribe-local-shared';
  if (!fs.existsSync(TRANSCRIBER)) return null;
  let tmpdir: string | null = null;
  try {
    const fileInfo = await api.getFile(fileId);
    if (!fileInfo.file_path) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;

    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-voice-'));
    const ext = path.extname(fileInfo.file_path) || '.ogg';
    const inputPath = path.join(tmpdir, `audio${ext}`);
    const wavPath = path.join(tmpdir, 'audio.wav');

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    fs.writeFileSync(inputPath, Buffer.from(await resp.arrayBuffer()));

    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', wavPath],
      { timeout: 60_000 },
    );

    const { stdout } = await execFileAsync(
      TRANSCRIBER,
      [wavPath, language],
      { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout.trim() || null;
  } catch (err) {
    logger.warn({ err: (err as Error).message, fileId }, 'Voice transcription failed');
    return null;
  } finally {
    if (tmpdir) {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
    }
  }
}
import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { GROUPS_DIR } from '../orchestrator/config.js';
import { registerChannel, ChannelOpts } from '../orchestrator/channel-registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';

/**
 * Download a Telegram photo to the group images directory.
 * Returns the saved file path, or null on failure.
 */
async function downloadTelegramPhoto(
  fileId: string,
  api: Api,
  botToken: string,
  groupFolder: string,
  msgId: string,
): Promise<string | null> {
  try {
    const fileInfo = await api.getFile(fileId);
    if (!fileInfo.file_path) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;

    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    const ext = path.extname(fileInfo.file_path) || '.jpg';
    const filename = `${Date.now()}_${msgId}${ext}`;
    const destPath = path.join(imagesDir, filename);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));

    logger.info({ destPath, groupFolder }, 'Telegram photo saved');
    return destPath;
  } catch (err) {
    logger.warn({ err: (err as Error).message, fileId }, 'Photo download failed');
    return null;
  }
}

/**
 * Download a Telegram document/file to the group inbox directory.
 * Returns the saved file path, or null on failure.
 */
async function downloadTelegramDocument(
  fileId: string,
  fileName: string,
  api: Api,
  botToken: string,
  groupFolder: string,
): Promise<string | null> {
  try {
    const fileInfo = await api.getFile(fileId);
    if (!fileInfo.file_path) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;

    const inboxDir = path.join(GROUPS_DIR, groupFolder, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Sanitize filename, keep original name for usability
    const safeName = fileName.replace(/[^a-zA-Z0-9._\-а-яА-ЯёЁ ]/g, '_');
    const destPath = path.join(inboxDir, `${Date.now()}_${safeName}`);

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
    fs.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));

    logger.info({ destPath, groupFolder, fileName }, 'Telegram document saved');
    return destPath;
  } catch (err) {
    logger.warn({ err: (err as Error).message, fileId, fileName }, 'Document download failed');
    return null;
  }
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  autoRegisterPrivateChat?: (jid: string, name: string, userId: number | undefined) => void;
}

// --- DM whitelist (gate for auto-register-private and ongoing DM access) ---
//
// Used by claudeclaw-ostrov instance to restrict @zabava_ostrov_bot DMs to
// a managed list of Telegram user_ids. Source of truth for the file is
// claudeclaw-claudeclaw (Забава, главный чат Александра). When env var
// TELEGRAM_DM_WHITELIST_FILE is set, every private message is gated; without
// the env var, behaviour is legacy (no whitelist).
//
// Fail-closed semantics: if the file is configured but unreadable/invalid,
// all DMs are dropped (we do NOT silently fall back to "allow all").

interface DmWhitelistUser {
  user_id: number | null;
  username?: string;
  name?: string;
  status?: string;
  notes?: string;
}

interface DmWhitelistTemplate {
  runtime?: 'container' | 'host' | 'deepseek';
  session_scope?: 'folder' | 'jid';
  agentConfig?: Record<string, unknown>;
}

interface DmWhitelistData {
  version?: number;
  users?: DmWhitelistUser[];
  policy?: Record<string, unknown>;
  guest_agent_config_template?: DmWhitelistTemplate;
}

let dmWhitelistFilePath: string | null = null;
let dmWhitelistCache: { data: DmWhitelistData; mtimeMs: number } | null = null;

function loadDmWhitelist(): DmWhitelistData | null {
  if (!dmWhitelistFilePath) return null;
  try {
    const stat = fs.statSync(dmWhitelistFilePath);
    if (dmWhitelistCache && dmWhitelistCache.mtimeMs === stat.mtimeMs) {
      return dmWhitelistCache.data;
    }
    const raw = fs.readFileSync(dmWhitelistFilePath, 'utf-8');
    const data = JSON.parse(raw) as DmWhitelistData;
    dmWhitelistCache = { data, mtimeMs: stat.mtimeMs };
    logger.info(
      { path: dmWhitelistFilePath, users: data.users?.length ?? 0, hasTemplate: !!data.guest_agent_config_template },
      'DM whitelist loaded',
    );
    return data;
  } catch (err) {
    logger.error(
      { err: (err as Error).message, path: dmWhitelistFilePath },
      'Failed to load DM whitelist — failing closed (all DMs will be ignored until fixed)',
    );
    return null;
  }
}

function isUserDmWhitelisted(userId: number | undefined): boolean {
  if (!dmWhitelistFilePath) return true; // legacy: no whitelist configured → allow all
  if (typeof userId !== 'number') return false;
  const data = loadDmWhitelist();
  if (!data || !Array.isArray(data.users)) return false; // fail-closed
  return data.users.some((u) => typeof u.user_id === 'number' && u.user_id === userId);
}

// Anti-spam for unauthorized-DM notifications: at most one notify per user_id
// per NOTIFY_TTL_MS window. Without this, a single attacker spamming the bot
// would flood the admin's DM.
const NOTIFY_TTL_MS = 60 * 60 * 1000; // 1 hour
const notifyCooldown = new Map<number, number>();

function shouldNotifyForUser(userId: number): boolean {
  const now = Date.now();
  const last = notifyCooldown.get(userId);
  if (last && now - last < NOTIFY_TTL_MS) return false;
  notifyCooldown.set(userId, now);
  // Opportunistic GC of stale entries
  if (notifyCooldown.size > 1000) {
    for (const [uid, ts] of notifyCooldown.entries()) {
      if (now - ts > NOTIFY_TTL_MS) notifyCooldown.delete(uid);
    }
  }
  return true;
}

/**
 * Notify the admin that a non-whitelisted user attempted to DM this bot.
 * Forwards the original triggering message (so admin sees verbatim content)
 * and sends a metadata summary right after. Anti-spam: at most once per user
 * per hour.
 *
 * Reads policy.notify_admin_chat_id from the loaded whitelist. If absent or
 * not a positive number — silently skip (logging only).
 */
async function notifyUnauthorizedDm(
  ctx: any,
  kind: 'text' | 'non-text',
): Promise<void> {
  try {
    const fromId = ctx.from?.id;
    if (typeof fromId !== 'number') return;
    if (!shouldNotifyForUser(fromId)) return;

    const data = loadDmWhitelist();
    const policy = (data?.policy ?? {}) as Record<string, unknown>;
    const adminChatId = policy.notify_admin_chat_id;
    if (typeof adminChatId !== 'number' || adminChatId === 0) return;

    const username = ctx.from?.username ? `@${ctx.from.username}` : '(no username)';
    const firstName = ctx.from?.first_name ?? '';
    const lastName = ctx.from?.last_name ?? '';
    const fullName = `${firstName} ${lastName}`.trim() || '(no name)';
    const lang = ctx.from?.language_code ?? '?';
    const me = await ctx.api.getMe().catch(() => null);
    const botLabel = me ? `@${me.username}` : '(this bot)';

    // 1. Forward the original message so admin sees actual content
    try {
      await ctx.api.forwardMessage(adminChatId, ctx.chat.id, ctx.message.message_id);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, fromId, adminChatId },
        'Forward of unauthorized DM failed (continuing with text summary)',
      );
    }

    // 2. Send metadata summary
    const summary =
      `🚨 *Unauthorized DM* в ${botLabel}\n` +
      `\n` +
      `*От:* ${fullName} (${username})\n` +
      `*user_id:* \`${fromId}\`\n` +
      `*lang:* ${lang}\n` +
      `*kind:* ${kind}\n` +
      `\n` +
      `Решение по whitelist'у — у тебя. Файл: \`${dmWhitelistFilePath ?? '(unknown)'}\`.\n` +
      `Следующее уведомление от этого user_id — не раньше чем через час.`;
    await sendTelegramMessage(ctx.api, adminChatId, summary);

    logger.info(
      { fromId, username: ctx.from?.username, kind, adminChatId },
      'Unauthorized DM notification sent to admin',
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message },
      'notifyUnauthorizedDm threw — swallowing to keep gate silent',
    );
  }
}

/**
 * Prepend `@${ASSISTANT_NAME}` to content when (a) the bot was @-mentioned
 * via Telegram entities, or (b) the message is a reply to one of our own
 * messages. Used by both message:text and channel_post:text handlers.
 */
function applyTriggerFromMentionsAndReply(
  content: string,
  entities: ReadonlyArray<{ type: string; offset: number; length: number }> | undefined,
  replyTo: { from?: { id?: number } } | undefined,
  botUsername: string | undefined,
  botUserId: number | undefined,
): string {
  if (botUsername && entities) {
    const isBotMentioned = entities.some((entity) => {
      if (entity.type !== 'mention') return false;
      const mentionText = content
        .substring(entity.offset, entity.offset + entity.length)
        .toLowerCase();
      return mentionText === `@${botUsername}`;
    });
    if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }
  }
  if (
    replyTo &&
    botUserId &&
    replyTo.from?.id === botUserId &&
    !TRIGGER_PATTERN.test(content)
  ) {
    content = `@${ASSISTANT_NAME} ${content}`;
  }
  return content;
}

/**
 * Send a message via Telegram, converting markdown → HTML first.
 *
 * Why HTML and not the bot API's 'Markdown'/'MarkdownV2' modes:
 *   - 'Markdown' (V1) only supports *single-star* bold, but Claude emits
 *     **double-star** by CommonMark default → every reply with bold became
 *     a 400 'can't parse entities' and silently fell back to plain text.
 *   - 'MarkdownV2' supports CommonMark bold but requires escaping a long
 *     punctuation set in plain text, which is impossible to get right
 *     consistently from LLM output.
 *   - 'HTML' has a small fixed tag whitelist and only `<`, `>`, `&` need
 *     escaping in regular text — robust and deterministic.
 *
 * The plain-text fallback stays as a safety net (defence in depth — if
 * the converter ever produces a malformed tag, the user still gets
 * the message body, just unstyled).
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: {
    message_thread_id?: number;
    reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
  } = {},
): Promise<number | undefined> {
  const html = markdownToTelegramHtml(text);
  try {
    const sent = await api.sendMessage(chatId, html, {
      ...options,
      parse_mode: 'HTML',
    });
    return sent?.message_id;
  } catch (err) {
    // Last-resort fallback: send the original markdown as plain text. Logs
    // at warn so we still notice if the converter produces broken HTML.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'HTML send failed, falling back to plain text',
    );
    const sent = await api.sendMessage(chatId, text, options);
    return sent?.message_id;
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private inboundPaused = false;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: <code>tg:${chatId}</code>\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'HTML' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      // DM whitelist gate: when TELEGRAM_DM_WHITELIST_FILE is configured, every
      // private message must come from a whitelisted user_id. Group chats are
      // not affected (group access is controlled by Telegram membership +
      // manual /register).
      if (ctx.chat.type === 'private' && dmWhitelistFilePath) {
        const fromId = ctx.from?.id;
        if (!isUserDmWhitelisted(fromId)) {
          logger.warn(
            { fromId, username: ctx.from?.username, name: ctx.from?.first_name },
            'DM from non-whitelisted Telegram user — ignoring (text)',
          );
          // Fire-and-forget — gate stays silent to the unauthorized user
          void notifyUnauthorizedDm(ctx, 'text');
          return;
        }
      }

      const baseChatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message.message_thread_id;
      // For forum topics, use tg:{chatId}:{threadId} as JID; fall back to base JID
      const chatJid = threadId
        ? `${baseChatJid}:${threadId}`
        : baseChatJid;

      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // @bot_username mention + reply-to-bot both translate into TRIGGER_PATTERN.
      content = applyTriggerFromMentionsAndReply(
        content,
        ctx.message.entities,
        (ctx.message as any).reply_to_message,
        ctx.me?.username?.toLowerCase(),
        ctx.me?.id,
      );

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Try topic JID first, then fall back to base chat JID
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid] || groups[baseChatJid];
      const effectiveJid = groups[chatJid] ? chatJid : baseChatJid;

      if (!group) {
        // Auto-register private chats if enabled
        if (!isGroup && this.opts.autoRegisterPrivateChat) {
          logger.info({ chatJid, chatName }, 'Auto-registering new private chat');
          this.opts.autoRegisterPrivateChat(chatJid, chatName, ctx.from?.id);
          // Re-check after registration
          const updatedGroups = this.opts.registeredGroups();
          if (!updatedGroups[chatJid]) {
            logger.warn({ chatJid }, 'Auto-registration failed, skipping message');
            return;
          }
        } else {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Telegram chat',
          );
          return;
        }
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(effectiveJid, {
        id: msgId,
        chat_jid: effectiveJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid: effectiveJid, chatName, sender: senderName, threadId },
        'Telegram message stored',
      );
    });

    // Channel posts: bot is admin of a Telegram channel and receives posts.
    // Channels: no threads (chatJid == baseChatJid), author via `sender_chat`,
    // never auto-register. All handlers funnel through `storeChannelPost`,
    // which owns the self-post filter, group resolution, metadata, onMessage.
    const storeChannelPost = (ctx: any, content: string): void => {
      // Skip our own posts (sendMessage echoes back as channel_post with from=bot).
      if (ctx.channelPost?.from?.id === ctx.me?.id) return;

      const chatJid = `tg:${ctx.chat.id}`;
      const chatName = (ctx.chat as any).title || chatJid;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'channel_post from unregistered Telegram channel');
        return;
      }

      const timestamp = new Date(ctx.channelPost.date * 1000).toISOString();
      const senderName = ctx.channelPost.sender_chat?.title || chatName || 'Channel';
      const sender =
        ctx.channelPost.sender_chat?.id?.toString() || ctx.chat.id.toString();

      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', false);
      this.opts.onMessage(chatJid, {
        id: ctx.channelPost.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
      logger.info({ chatJid, chatName, sender: senderName }, 'Telegram channel_post stored');
    };

    // Build "[Placeholder] caption" for non-text channel posts.
    const withCaption = (ctx: any, placeholder: string): string =>
      ctx.channelPost.caption ? `${placeholder} ${ctx.channelPost.caption}` : placeholder;

    this.bot.on('channel_post:text', (ctx) => {
      if (ctx.channelPost.text.startsWith('/')) return;
      storeChannelPost(
        ctx,
        applyTriggerFromMentionsAndReply(
          ctx.channelPost.text,
          ctx.channelPost.entities,
          (ctx.channelPost as any).reply_to_message,
          ctx.me?.username?.toLowerCase(),
          ctx.me?.id,
        ),
      );
    });

    this.bot.on('channel_post:photo', async (ctx) => {
      const group = this.opts.registeredGroups()[`tg:${ctx.chat.id}`];
      if (!group) return;
      const best = ctx.channelPost.photo[ctx.channelPost.photo.length - 1];
      const filePath = best?.file_id
        ? await downloadTelegramPhoto(best.file_id, this.bot!.api, this.botToken, group.folder, ctx.channelPost.message_id.toString())
        : null;
      storeChannelPost(ctx, withCaption(ctx, filePath ? `[Photo: ${filePath}]` : '[Photo]'));
    });

    this.bot.on('channel_post:video', (ctx) => storeChannelPost(ctx, withCaption(ctx, '[Video]')));

    this.bot.on('channel_post:document', async (ctx) => {
      const doc = ctx.channelPost.document;
      const name = doc?.file_name || 'file';
      const group = this.opts.registeredGroups()[`tg:${ctx.chat.id}`];
      const filePath = doc?.file_id && group
        ? await downloadTelegramDocument(doc.file_id, name, this.bot!.api, this.botToken, group.folder)
        : null;
      storeChannelPost(
        ctx,
        withCaption(ctx, filePath ? `[Document: ${name} saved to ${filePath}]` : `[Document: ${name}]`),
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const baseChatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message?.message_thread_id;
      const topicJid = threadId ? `${baseChatJid}:${threadId}` : baseChatJid;
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      // DM whitelist gate (same policy as text handler)
      if (!isGroup && dmWhitelistFilePath) {
        const fromId = ctx.from?.id;
        if (!isUserDmWhitelisted(fromId)) {
          logger.warn(
            { fromId, username: ctx.from?.username, name: ctx.from?.first_name },
            'DM from non-whitelisted Telegram user — ignoring (non-text)',
          );
          // Fire-and-forget — gate stays silent to the unauthorized user
          void notifyUnauthorizedDm(ctx, 'non-text');
          return;
        }
      }

      let groups = this.opts.registeredGroups();
      let group = groups[topicJid] || groups[baseChatJid];
      const chatJid = groups[topicJid] ? topicJid : baseChatJid;

      // Auto-register private chats if enabled
      if (!group && !isGroup && this.opts.autoRegisterPrivateChat) {
        const chatName = ctx.chat.first_name || ctx.chat.username || baseChatJid;
        logger.info({ chatJid: baseChatJid, chatName }, 'Auto-registering new private chat (non-text)');
        this.opts.autoRegisterPrivateChat(baseChatJid, chatName, ctx.from?.id);
        groups = this.opts.registeredGroups();
        group = groups[baseChatJid];
      }
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      // Resolve group with topic awareness — a chat can have multiple
      // registered topics under the same chat_id, each with its own folder.
      // Prefer a topic-specific match, fall back to the chat-level group.
      const baseChatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message?.message_thread_id;
      const topicJid = threadId ? `${baseChatJid}:${threadId}` : baseChatJid;
      const groups = this.opts.registeredGroups();
      const group = groups[topicJid] || groups[baseChatJid];
      if (!group) return;

      // Pick the highest resolution photo
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      const msgId = ctx.message.message_id.toString();

      const filePath = best?.file_id
        ? await downloadTelegramPhoto(best.file_id, this.bot!.api, this.botToken, group.folder, msgId)
        : null;

      const placeholder = filePath
        ? `[Photo: ${filePath}]`
        : '[Photo]';
      storeNonText(ctx, placeholder);
    });
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const fileId = ctx.message.voice?.file_id;
      const transcript = fileId
        ? await transcribeTelegramAudio(fileId, this.bot!.api, this.botToken)
        : null;
      const placeholder = transcript
        ? `[Voice transcript]: ${transcript}`
        : '[Voice message — transcription unavailable]';
      storeNonText(ctx, placeholder);
    });
    this.bot.on('message:audio', async (ctx) => {
      const fileId = ctx.message.audio?.file_id;
      const transcript = fileId
        ? await transcribeTelegramAudio(fileId, this.bot!.api, this.botToken)
        : null;
      const placeholder = transcript
        ? `[Audio transcript]: ${transcript}`
        : '[Audio]';
      storeNonText(ctx, placeholder);
    });
    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const name = doc?.file_name || 'file';
      const fileId = doc?.file_id;

      // Determine group folder for this JID
      const baseChatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message?.message_thread_id;
      const topicJid = threadId ? `${baseChatJid}:${threadId}` : baseChatJid;
      const groups = this.opts.registeredGroups();
      const group = groups[topicJid] || groups[baseChatJid];

      let filePath: string | null = null;
      if (fileId && group) {
        filePath = await downloadTelegramDocument(fileId, name, this.bot!.api, this.botToken, group.folder);
      }

      const placeholder = filePath
        ? `[Document: ${name} saved to ${filePath}]`
        : `[Document: ${name}]`;
      storeNonText(ctx, placeholder);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    opts?: { replyTo?: { messageId: number } },
  ): Promise<{ messageIds: string[] }> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return { messageIds: [] };
    }

    const messageIds: string[] = [];
    try {
      // Parse JID: tg:{chatId} or tg:{chatId}:{threadId}
      // threadId here = forum-topic id (only set for forum supergroups, e.g. !жизнь).
      // It is NOT the trigger message id — visual reply uses opts.replyTo instead.
      const parts = jid.replace(/^tg:/, '').split(':');
      const numericId = parts[0];
      const threadId = parts[1] ? parseInt(parts[1], 10) : undefined;
      const sendOptions: {
        message_thread_id?: number;
        reply_parameters?: { message_id: number; allow_sending_without_reply?: boolean };
      } = {};
      if (threadId) sendOptions.message_thread_id = threadId;
      if (opts?.replyTo?.messageId) {
        sendOptions.reply_parameters = {
          message_id: opts.replyTo.messageId,
          allow_sending_without_reply: true,
        };
      }

      logger.debug({ jid, numericId, threadId, sendOptions }, 'Sending Telegram message');

      // Telegram has a 4096 character limit per message — split if needed.
      // Only the FIRST chunk should carry reply_parameters (replying to the same
      // message multiple times produces visual clutter).
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        const id = await sendTelegramMessage(this.bot.api, numericId, text, sendOptions);
        if (id !== undefined) messageIds.push(String(id));
      } else {
        const firstChunkOptions = sendOptions;
        const restOptions = { ...sendOptions };
        delete restOptions.reply_parameters;
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          const id = await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            i === 0 ? firstChunkOptions : restOptions,
          );
          if (id !== undefined) messageIds.push(String(id));
        }
      }
      logger.info(
        { jid, length: text.length, messageIds },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
    return { messageIds };
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  /**
   * Stop the long-poll loop (so getUpdates aborts and no new incoming
   * messages enter the orchestrator) WITHOUT tearing down the api object.
   * `isConnected()` continues to report true, so the outbound router can
   * still deliver the final replies that agents finish during the
   * shutdown drain. Idempotent — safe to call before disconnect().
   */
  async pauseInbound(): Promise<void> {
    if (this.bot && !this.inboundPaused) {
      this.inboundPaused = true;
      try {
        await this.bot.stop();
      } catch (err) {
        logger.warn({ err }, 'bot.stop() raised during pauseInbound');
      }
      logger.info('Telegram inbound paused (api still live for outbound drain)');
    }
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      // If pauseInbound() already stopped the poller, bot.stop() is a
      // safe no-op the second time.
      if (!this.inboundPaused) {
        try {
          await this.bot.stop();
        } catch (err) {
          logger.warn({ err }, 'bot.stop() raised during disconnect');
        }
      }
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const parts = jid.replace(/^tg:/, '').split(':');
      const numericId = parts[0];
      const threadId = parts[1] ? parseInt(parts[1], 10) : undefined;
      await this.bot.api.sendChatAction(
        numericId,
        'typing',
        threadId ? { message_thread_id: threadId } : {},
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_AUTO_REGISTER_PRIVATE',
    'TELEGRAM_DM_WHITELIST_FILE',
  ]);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  // DM whitelist file path (optional). When set, gates every private message
  // and applies guest_agent_config_template on auto-register-private.
  const whitelistPath =
    process.env.TELEGRAM_DM_WHITELIST_FILE ||
    envVars.TELEGRAM_DM_WHITELIST_FILE ||
    '';
  if (whitelistPath) {
    dmWhitelistFilePath = whitelistPath;
    const initial = loadDmWhitelist();
    if (!initial) {
      logger.error(
        { whitelistPath },
        'Telegram: DM whitelist file unreadable at startup — DMs will fail-closed until fixed',
      );
    }
  }

  // Auto-register private chats if enabled via env var
  const autoRegisterEnabled = (process.env.TELEGRAM_AUTO_REGISTER_PRIVATE || envVars.TELEGRAM_AUTO_REGISTER_PRIVATE || 'false').toLowerCase() === 'true';

  const autoRegisterPrivateChat = autoRegisterEnabled && opts.registerGroup
    ? (jid: string, name: string, userId: number | undefined) => {
        // When a whitelist is configured we expect a guest_agent_config_template
        // to apply a character system prompt + tight tool allowlist for guest
        // bots like @zabava_ostrov_bot. Without the template we keep an empty
        // agentConfig — the whitelist alone is the access gate (used by trusted-
        // only bots like мамин where every user is family).
        //
        // Sandbox runtime no longer exists (removed 2026-05-06). All groups now
        // run runtime=host by default; isolation is behavioural via systemPrompt
        // (preamble) + tool restrictions, not OS-level sandbox.
        let agentConfig: Record<string, unknown> = {};
        let runtime: 'container' | 'host' | 'deepseek' | undefined;
        let sessionScope: 'folder' | 'jid' | undefined;

        if (dmWhitelistFilePath) {
          const wl = loadDmWhitelist();
          const tpl = wl?.guest_agent_config_template;
          if (tpl) {
            if (!tpl.agentConfig) {
              logger.error(
                { jid, name, userId },
                'guest_agent_config_template present but missing agentConfig — refusing to auto-register (fail-closed)',
              );
              return;
            }
            agentConfig = tpl.agentConfig;
            runtime = tpl.runtime;
            sessionScope = tpl.session_scope;
          }
        }

        const group: RegisteredGroup = {
          name,
          folder: 'telegram_main',
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          agentConfig: agentConfig as RegisteredGroup['agentConfig'],
        };
        if (runtime) group.runtime = runtime;
        if (sessionScope) group.sessionScope = sessionScope;

        opts.registerGroup!(jid, group);
        logger.info(
          { jid, name, userId, runtime: runtime ?? 'default', sessionScope: sessionScope ?? 'folder', guestTemplate: !!dmWhitelistFilePath },
          'Auto-registered private chat',
        );
      }
    : undefined;

  return new TelegramChannel(token, { ...opts, autoRegisterPrivateChat });
});
