import { execFile } from 'child_process';
import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../orchestrator/config.js';

const execFileAsync = promisify(execFile);

/**
 * Local Whisper transcription via /usr/local/bin/transcribe-local-shared.
 * Returns transcribed text or null on failure (network down, ffmpeg missing, etc.).
 */
async function transcribeTelegramAudio(
  fileId: string,
  api: Api,
  botToken: string,
  language = 'ru',
): Promise<string | null> {
  const TRANSCRIBER = '/usr/local/bin/transcribe-local-shared';
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
  autoRegisterPrivateChat?: (jid: string, name: string) => void;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

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
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

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

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

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
          this.opts.autoRegisterPrivateChat(chatJid, chatName);
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

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const baseChatJid = `tg:${ctx.chat.id}`;
      const threadId = ctx.message?.message_thread_id;
      const topicJid = threadId ? `${baseChatJid}:${threadId}` : baseChatJid;
      const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      let groups = this.opts.registeredGroups();
      let group = groups[topicJid] || groups[baseChatJid];
      const chatJid = groups[topicJid] ? topicJid : baseChatJid;

      // Auto-register private chats if enabled
      if (!group && !isGroup && this.opts.autoRegisterPrivateChat) {
        const chatName = ctx.chat.first_name || ctx.chat.username || baseChatJid;
        logger.info({ chatJid: baseChatJid, chatName }, 'Auto-registering new private chat (non-text)');
        this.opts.autoRegisterPrivateChat(baseChatJid, chatName);
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

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      // Parse JID: tg:{chatId} or tg:{chatId}:{threadId}
      const parts = jid.replace(/^tg:/, '').split(':');
      const numericId = parts[0];
      const threadId = parts[1] ? parseInt(parts[1], 10) : undefined;
      const threadOptions = threadId ? { message_thread_id: threadId } : {};

      logger.debug({ jid, numericId, threadId, threadOptions }, 'Sending Telegram message');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, threadOptions);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            threadOptions,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
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
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_AUTO_REGISTER_PRIVATE']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }

  // Auto-register private chats if enabled via env var
  const autoRegisterEnabled = (process.env.TELEGRAM_AUTO_REGISTER_PRIVATE || envVars.TELEGRAM_AUTO_REGISTER_PRIVATE || 'false').toLowerCase() === 'true';

  const autoRegisterPrivateChat = autoRegisterEnabled && opts.registerGroup
    ? (jid: string, name: string) => {
        opts.registerGroup!(jid, {
          name,
          folder: 'telegram_main',
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          agentConfig: { unsandboxed: true },
        });
        logger.info({ jid, name }, 'Auto-registered private chat');
      }
    : undefined;

  return new TelegramChannel(token, { ...opts, autoRegisterPrivateChat });
});
