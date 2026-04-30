import { readEnvFile } from '../orchestrator/env.js';
import { logger } from '../orchestrator/logger.js';
import { registerChannel, ChannelOpts } from '../orchestrator/channel-registry.js';
import { GROUPS_DIR } from '../orchestrator/config.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../orchestrator/types.js';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);
// Local Whisper transcription helper. Override via WHISPER_TRANSCRIBER env.
const TRANSCRIBER =
  process.env.WHISPER_TRANSCRIBER || '/usr/local/bin/transcribe-local-shared';

const MAX_VOICE_BYTES = 10_000_000; // ~10 МБ — хватает на 5-10 мин речи в OGG/Opus или MP3 (защита от часовых записей)
const MAX_FILE_BYTES = 50_000_000; // ~50 МБ — лимит для не-аудио вложений
const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней — потом чистим

type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'oversized'; sizeBytes: number }
  | { ok: false; reason: 'failed' };

// Authentication mode: legacy webhook (REST URL with embedded secret) or OAuth (refreshable bearer).
// OAuth is the supported path; webhook remains as a deprecated fallback for installs that haven't migrated yet.
type BxAuth =
  | { mode: 'webhook'; webhookUrl: string }
  | {
      mode: 'oauth';
      clientEndpoint: string; // e.g. "https://<portal>/rest/" — note trailing slash
      accessToken: string;
      refreshToken: string;
      clientId: string;
      clientSecret: string;
    };

// OAuth refresh endpoint is portal-independent; client_endpoint in the response may update if Bitrix migrates the portal.
const OAUTH_REFRESH_URL = 'https://oauth.bitrix.info/oauth/token';

const POLL_INTERVAL_MS = 15_000;
// How often to scan im.recent.list for new group chats (every N polls)
const GROUP_DISCOVER_EVERY = 4;

// JID helpers
const jidForUser = (userId: string) => `bx24:${userId}`;
const jidForChat = (chatId: string | number) => `bx24:chat${chatId}`;
const dialogIdForJid = (jid: string): string => {
  if (jid.startsWith('bx24:chat')) return `chat${jid.replace('bx24:chat', '')}`;
  return jid.replace('bx24:', '');
};

export class Bitrix24Channel implements Channel {
  name = 'bitrix24';

  private auth: BxAuth;
  private allowedUserId: string;  // our main user (Alexander)
  private botUserId: string;      // our own bot user ID (to skip own messages)
  private extraAllowedUserIds: Set<string>; // authorized team members who can message the bot directly
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  };
  private pollTimer: NodeJS.Timeout | null = null;
  // lastMessageId per dialog JID
  private lastMessageIds: Map<string, number> = new Map();
  // known group chat IDs (chatId as string, e.g. "182364")
  private knownGroupChatIds: Set<string> = new Set();
  private pollCount = 0;
  // Inflight refresh promise — coalesce concurrent 401s so only one refresh fires.
  private refreshInflight: Promise<boolean> | null = null;

  constructor(
    auth: BxAuth,
    allowedUserId: string,
    botUserId: string,
    opts: {
      onMessage: OnInboundMessage;
      onChatMetadata: OnChatMetadata;
      registeredGroups: () => Record<string, RegisteredGroup>;
    },
    extraAllowedUserIds: string[] = [],
  ) {
    this.auth = auth;
    this.allowedUserId = allowedUserId;
    this.botUserId = botUserId;
    this.extraAllowedUserIds = new Set(extraAllowedUserIds);
    this.opts = opts;
  }

  private buildUrl(method: string): string {
    if (this.auth.mode === 'webhook') {
      return `${this.auth.webhookUrl}${method}`;
    }
    // OAuth: client_endpoint always ends with trailing slash; auth goes as query param
    return `${this.auth.clientEndpoint}${method}?auth=${encodeURIComponent(this.auth.accessToken)}`;
  }

  private async b24(method: string, params: Record<string, unknown> = {}, retried = false): Promise<any> {
    const url = this.buildUrl(method);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data: any = await resp.json().catch(() => ({}));

    // OAuth-only: refresh on expired_token / invalid_token then retry once.
    if (
      this.auth.mode === 'oauth' &&
      !retried &&
      (data?.error === 'expired_token' ||
        data?.error === 'invalid_token' ||
        resp.status === 401)
    ) {
      logger.info({ method, error: data?.error }, 'Bitrix24: access token expired, refreshing');
      const ok = await this.ensureRefreshed();
      if (ok) return this.b24(method, params, true);
    }
    return data;
  }

  /** Coalesce concurrent refresh calls so only one round-trip hits the OAuth server. */
  private ensureRefreshed(): Promise<boolean> {
    if (this.refreshInflight) return this.refreshInflight;
    this.refreshInflight = this.refreshOAuth().finally(() => {
      this.refreshInflight = null;
    });
    return this.refreshInflight;
  }

  private async refreshOAuth(): Promise<boolean> {
    if (this.auth.mode !== 'oauth') return false;
    try {
      const qs = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.auth.clientId,
        client_secret: this.auth.clientSecret,
        refresh_token: this.auth.refreshToken,
      });
      const resp = await fetch(`${OAUTH_REFRESH_URL}?${qs.toString()}`, { method: 'GET' });
      const data: any = await resp.json().catch(() => ({}));
      if (!data?.access_token || !data?.refresh_token) {
        logger.error(
          { status: resp.status, error: data?.error, errorDescription: data?.error_description },
          'Bitrix24: OAuth refresh failed (no tokens in response)',
        );
        return false;
      }
      this.auth.accessToken = data.access_token;
      this.auth.refreshToken = data.refresh_token;
      if (typeof data.client_endpoint === 'string' && data.client_endpoint) {
        this.auth.clientEndpoint = data.client_endpoint;
      }
      logger.info({ expiresIn: data.expires_in }, 'Bitrix24: OAuth tokens refreshed');
      // Best-effort persistence so subsequent service restarts pick up the new tokens.
      await this.persistOAuthTokens();
      return true;
    } catch (err) {
      logger.error({ err }, 'Bitrix24: OAuth refresh threw');
      return false;
    }
  }

  /** Write refreshed tokens back to pass-store. Best-effort: failure logs WARN but doesn't block. */
  private async persistOAuthTokens(): Promise<void> {
    if (this.auth.mode !== 'oauth') return;
    const writeOne = (entry: string, value: string) =>
      new Promise<{ ok: boolean; stderr: string }>((resolve) => {
        const child = spawn('pass', ['insert', '-m', '-f', entry], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Inherit env so GPG_AGENT_INFO / HOME flow through.
          env: process.env,
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.on('error', (err) => {
          resolve({ ok: false, stderr: String(err) });
        });
        child.on('exit', (code) => {
          resolve({ ok: code === 0, stderr });
        });
        // `pass insert -m` reads multi-line content from stdin until EOF.
        child.stdin.write(value + '\n');
        child.stdin.end();
      });

    const accessRes = await writeOne('bitrix24/oauth-access-token', this.auth.accessToken);
    const refreshRes = await writeOne('bitrix24/oauth-refresh-token', this.auth.refreshToken);
    if (accessRes.ok && refreshRes.ok) {
      logger.info('Bitrix24: refreshed OAuth tokens persisted to pass-store');
    } else {
      logger.warn(
        {
          accessOk: accessRes.ok,
          refreshOk: refreshRes.ok,
          accessErr: accessRes.stderr.slice(0, 200),
          refreshErr: refreshRes.stderr.slice(0, 200),
        },
        'Bitrix24: failed to persist refreshed tokens to pass-store (in-memory copy still valid for this session)',
      );
    }
  }

  async connect(): Promise<void> {
    // Seed lastMessageId for personal dialog
    try {
      const data = await this.b24('im.dialog.messages.get', {
        DIALOG_ID: this.allowedUserId,
        LIMIT: 1,
      });
      const messages: any[] = data?.result?.messages || [];
      if (messages.length > 0) {
        const jid = jidForUser(this.allowedUserId);
        this.lastMessageIds.set(jid, parseInt(messages[0].id, 10));
      }
    } catch (err) {
      logger.warn({ err }, 'Bitrix24: failed to seed lastMessageId');
    }

    // Seed lastMessageIds for extra authorized users' personal dialogs
    for (const userId of this.extraAllowedUserIds) {
      try {
        const data = await this.b24('im.dialog.messages.get', { DIALOG_ID: userId, LIMIT: 1 });
        const messages: any[] = data?.result?.messages || [];
        if (messages.length > 0) {
          const jid = jidForUser(userId);
          this.lastMessageIds.set(jid, parseInt(messages[0].id, 10));
        }
      } catch {}
    }

    // Discover existing group chats on startup (don't intro on startup)
    await this.discoverGroupChats(false);

    // Cleanup stale inbox files (>30 days) from all registered groups
    try { this.cleanInboxes(); } catch (err) { logger.warn({ err }, 'Bitrix24: cleanInboxes failed'); }

    logger.info(
      { allowedUserId: this.allowedUserId, extraUsers: [...this.extraAllowedUserIds], groups: [...this.knownGroupChatIds] },
      'Bitrix24 channel connected, starting poll',
    );
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  private async discoverGroupChats(sendIntro: boolean): Promise<void> {
    try {
      const data = await this.b24('im.recent.list', { LIMIT: 50 });
      const items: any[] = data?.result?.items || [];
      for (const item of items) {
        if (item.type !== 'chat') continue;
        const chatId = String(item.chat_id || item.id);
        if (this.knownGroupChatIds.has(chatId)) continue;

        // New group found
        this.knownGroupChatIds.add(chatId);
        const jid = jidForChat(chatId);
        const title = item.title || `Группа ${chatId}`;

        // Seed lastMessageId for this group
        try {
          const msgData = await this.b24('im.dialog.messages.get', {
            DIALOG_ID: `chat${chatId}`,
            LIMIT: 1,
          });
          const msgs: any[] = msgData?.result?.messages || [];
          if (msgs.length > 0) {
            this.lastMessageIds.set(jid, parseInt(msgs[0].id, 10));
          }
        } catch {}

        logger.info({ chatId, title, jid }, 'Bitrix24: new group chat discovered');

        if (sendIntro) {
          await this.introduceInGroup(chatId, title, jid);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Bitrix24: failed to discover group chats');
    }
  }

  private async introduceInGroup(chatId: string, title: string, jid: string): Promise<void> {
    try {
      // Get group members
      const membersData = await this.b24('im.chat.user.list', { CHAT_ID: chatId });
      const memberIds: number[] = membersData?.result || [];

      // Get user names
      const names: string[] = [];
      if (memberIds.length > 0) {
        const usersData = await this.b24('user.get', {
          ID: memberIds,
          select: ['ID', 'NAME', 'LAST_NAME'],
        });
        const users: any[] = usersData?.result || [];
        for (const u of users) {
          if (String(u.ID) === this.botUserId) continue; // skip myself
          if (String(u.ID) === this.allowedUserId) continue; // skip Alexander (mentioned separately)
          const name = [u.NAME, u.LAST_NAME].filter(Boolean).join(' ');
          if (name) names.push(name);
        }
      }

      const colleaguesLine = names.length > 0
        ? `Вижу, что здесь: ${names.join(', ')} — рада познакомиться!`
        : '';

      const intro = `Всем привет! 👋 Меня зовут Забава — я персональный ИИ-ассистент Александра.

Буду помогать всей команде: отвечать на вопросы, помогать с задачами и информацией.${colleaguesLine ? '\n\n' + colleaguesLine : ''}

Пишите — всегда на связи! 🤝`;

      await this.b24('im.message.add', {
        DIALOG_ID: `chat${chatId}`,
        MESSAGE: intro,
      });

      logger.info({ chatId, title }, 'Bitrix24: intro message sent to group');

      // Notify the orchestrator about this chat
      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(jid, timestamp, title, 'bitrix24', false);
    } catch (err) {
      logger.warn({ err, chatId }, 'Bitrix24: failed to send intro to group');
    }
  }

  private async getFileInfo(fileId: string): Promise<{ name: string; contentType: string; downloadUrl: string; size: number } | null> {
    try {
      const fileData = await this.b24('disk.file.get', { id: fileId });
      const r = fileData?.result;
      if (!r) return null;
      return { name: r.NAME || '', contentType: r.CONTENT_TYPE || '', downloadUrl: r.DOWNLOAD_URL || '', size: Number(r.SIZE) || 0 };
    } catch (err) {
      logger.warn({ err, fileId }, 'Bitrix24: failed to get file info');
      return null;
    }
  }

  private isAudioFile(name: string, contentType: string): boolean {
    if (contentType.startsWith('audio/')) return true;
    const ext = path.extname(name).toLowerCase();
    return ['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.opus', '.flac', '.wma'].includes(ext);
  }

  private isPdfFile(name: string, contentType: string): boolean {
    if (contentType === 'application/pdf') return true;
    return path.extname(name).toLowerCase() === '.pdf';
  }

  private sanitizeFilename(name: string): string {
    const base = path.basename(name).replace(/[\/\\]/g, '_').replace(/\.\.+/g, '_');
    const cleaned = base.replace(/[\x00-\x1f]/g, '').trim();
    if (!cleaned) return 'file';
    return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
  }

  private async saveFileToInbox(
    groupFolder: string,
    msgId: number,
    fileInfo: { name: string; downloadUrl: string; size: number },
  ): Promise<{ relPath: string; absPath: string } | null> {
    const inboxDir = path.join(GROUPS_DIR, groupFolder, 'inbox');
    try {
      fs.mkdirSync(inboxDir, { recursive: true });
      const safeName = this.sanitizeFilename(fileInfo.name);
      const fileName = `${msgId}_${safeName}`;
      const absPath = path.join(inboxDir, fileName);
      const curlResult = await execFileAsync(
        'curl',
        ['-sL', '--max-filesize', String(MAX_FILE_BYTES), '-w', '%{http_code}', '-o', absPath, fileInfo.downloadUrl],
        { timeout: 120_000 },
      );
      const httpCode = curlResult.stdout.trim();
      const stat = fs.statSync(absPath);
      if (httpCode !== '200' || stat.size === 0) {
        try { fs.unlinkSync(absPath); } catch {}
        logger.warn({ groupFolder, msgId, name: fileInfo.name, httpCode, size: stat.size }, 'Bitrix24: failed to download file');
        return null;
      }
      return { relPath: `./inbox/${fileName}`, absPath };
    } catch (err) {
      logger.warn({ err, groupFolder, msgId, name: fileInfo.name }, 'Bitrix24: error saving file to inbox');
      return null;
    }
  }

  private cleanInboxes(): void {
    const groups = this.opts.registeredGroups();
    const cutoff = Date.now() - INBOX_TTL_MS;
    let removed = 0;
    for (const g of Object.values(groups)) {
      const inboxDir = path.join(GROUPS_DIR, g.folder, 'inbox');
      if (!fs.existsSync(inboxDir)) continue;
      try {
        for (const entry of fs.readdirSync(inboxDir)) {
          const p = path.join(inboxDir, entry);
          try {
            const st = fs.statSync(p);
            if (st.isFile() && st.mtimeMs < cutoff) {
              fs.unlinkSync(p);
              removed++;
            }
          } catch {}
        }
      } catch {}
    }
    if (removed > 0) logger.info({ removed }, 'Bitrix24: cleaned old inbox files');
  }

  private async extractPdfText(fileId: string, fileInfo: { name: string; downloadUrl: string }): Promise<string | null> {
    let tmpDir: string | null = null;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx24-pdf-'));
      const pdfPath = path.join(tmpDir, 'doc.pdf');
      const curlResult = await execFileAsync(
        'curl',
        ['-sL', '-w', '%{http_code}', '-o', pdfPath, fileInfo.downloadUrl],
        { timeout: 60_000 },
      );
      if (curlResult.stdout.trim() !== '200') return null;
      const { stdout } = await execFileAsync('pdftotext', [pdfPath, '-'], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
      const text = stdout.trim();
      if (!text) return null;
      return `[PDF документ: ${fileInfo.name}]\n${text}`;
    } catch (err) {
      logger.warn({ err, fileId }, 'Bitrix24: PDF text extraction failed');
      return null;
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  private async transcribeVoice(fileId: string, prefetchedInfo?: { downloadUrl: string; size: number }): Promise<TranscribeResult> {
    if (!fs.existsSync(TRANSCRIBER)) {
      logger.warn('Bitrix24: transcribe-local-shared not found, skipping voice transcription');
      return { ok: false, reason: 'failed' };
    }
    let tmpDir: string | null = null;
    try {
      // Use pre-fetched info if available, otherwise call disk.file.get
      // (disk.file.get DOWNLOAD_URL is a signed REST URL that works without browser session)
      let downloadUrl: string = prefetchedInfo?.downloadUrl || '';
      let declaredSize: number = prefetchedInfo?.size ?? 0;
      if (!downloadUrl) {
        const fileData = await this.b24('disk.file.get', { id: fileId });
        downloadUrl = fileData?.result?.DOWNLOAD_URL || '';
        declaredSize = Number(fileData?.result?.SIZE) || 0;
      }

      if (!downloadUrl) {
        logger.warn({ fileId }, 'Bitrix24: no download URL for voice file');
        return { ok: false, reason: 'failed' };
      }

      // Size guard: skip oversized files before download to avoid wasting bandwidth/CPU
      if (declaredSize > MAX_VOICE_BYTES) {
        logger.warn(
          { fileId, sizeBytes: declaredSize, limitBytes: MAX_VOICE_BYTES },
          'Bitrix24: voice file too large, skipping transcription',
        );
        return { ok: false, reason: 'oversized', sizeBytes: declaredSize };
      }

      // Download audio to temp file — no extension so ffmpeg auto-detects format
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx24-voice-'));
      const inputPath = path.join(tmpDir, `audio`);
      const wavPath = path.join(tmpDir, 'audio.wav');

      // Use curl for download — follows redirects reliably (fetch has issues with Bitrix signed URLs).
      // Cap downloaded bytes via curl --max-filesize so a missing/lying SIZE field can't sneak past our guard.
      const curlResult = await execFileAsync(
        'curl',
        ['-sL', '--max-filesize', String(MAX_VOICE_BYTES), '-w', '%{http_code}', '-o', inputPath, downloadUrl],
        { timeout: 30_000 },
      );
      const httpCode = curlResult.stdout.trim();
      const fileSize = fs.existsSync(inputPath) ? fs.statSync(inputPath).size : 0;
      if (httpCode !== '200' || fileSize === 0) {
        logger.warn({ fileId, httpCode, fileSize }, 'Bitrix24: failed to download voice file');
        return { ok: false, reason: 'failed' };
      }
      if (fileSize > MAX_VOICE_BYTES) {
        logger.warn(
          { fileId, sizeBytes: fileSize, limitBytes: MAX_VOICE_BYTES },
          'Bitrix24: voice file too large after download, skipping transcription',
        );
        return { ok: false, reason: 'oversized', sizeBytes: fileSize };
      }
      logger.info({ fileId, size: fileSize }, 'Bitrix24: audio downloaded');

      // Convert to 16kHz mono WAV
      await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', wavPath], {
        timeout: 30_000,
      });

      // Transcribe with shared local Whisper
      const { stdout } = await execFileAsync(TRANSCRIBER, [wavPath, 'ru'], {
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const transcript = stdout.trim();
      logger.info({ fileId, transcript: transcript.slice(0, 80) }, 'Bitrix24: voice transcribed');
      if (!transcript) return { ok: false, reason: 'failed' };
      return { ok: true, text: transcript };
    } catch (err) {
      logger.warn({ err, fileId }, 'Bitrix24: voice transcription failed');
      return { ok: false, reason: 'failed' };
    } finally {
      if (tmpDir) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  private async pollDialog(dialogId: string, jid: string, isGroup: boolean): Promise<void> {
    try {
      const data = await this.b24('im.dialog.messages.get', {
        DIALOG_ID: dialogId,
        LIMIT: 20,
      });
      const result = data?.result;
      const messages: any[] = (result?.messages || []).reverse(); // oldest first
      const users: any[] = result?.users || [];

      const lastId = this.lastMessageIds.get(jid) ?? 0;

      for (const msg of messages) {
        const msgId = parseInt(msg.id, 10);
        if (msgId <= lastId) continue;

        const authorId = String(msg.author_id);

        // Skip own bot messages
        if (authorId === this.botUserId) {
          this.lastMessageIds.set(jid, Math.max(this.lastMessageIds.get(jid) ?? 0, msgId));
          continue;
        }

        // For personal dialog: only accept messages from allowed user or extra authorized users
        if (!isGroup && authorId !== this.allowedUserId && !this.extraAllowedUserIds.has(authorId)) {
          this.lastMessageIds.set(jid, Math.max(this.lastMessageIds.get(jid) ?? 0, msgId));
          continue;
        }

        this.lastMessageIds.set(jid, Math.max(this.lastMessageIds.get(jid) ?? 0, msgId));

        // Extra authorized users: route their personal messages to Alexander's main JID
        const isExtraUser = !isGroup && this.extraAllowedUserIds.has(authorId);
        const routingJid = isExtraUser ? jidForUser(this.allowedUserId) : jid;

        const timestamp = new Date().toISOString();
        const chatTitle = isGroup ? `Группа bx24:${dialogId}` : 'Битрикс24';
        this.opts.onChatMetadata(routingJid, timestamp, chatTitle, 'bitrix24', false);

        const groups = this.opts.registeredGroups();
        if (!groups[routingJid]) {
          logger.debug({ jid, routingJid }, 'Bitrix24: message from unregistered JID, skipping');
          continue;
        }

        // Resolve sender name
        const userInfo = users.find((u: any) => String(u.id) === authorId);
        const senderName = userInfo
          ? [userInfo.first_name, userInfo.last_name].filter(Boolean).join(' ') || userInfo.name
          : authorId === this.allowedUserId ? 'Александр' : `User ${authorId}`;

        // Handle file attachments via FILE_ID param — check type before processing
        let text = msg.text || '';
        const fileIds: string[] = msg.params?.FILE_ID || [];
        if (!text && fileIds.length > 0) {
          const fileId = String(fileIds[0]);
          const fileInfo = await this.getFileInfo(fileId);
          const fileName = fileInfo?.name || '';
          const contentType = fileInfo?.contentType || '';

          if (this.isAudioFile(fileName, contentType)) {
            logger.info({ msgId, fileId, fileName }, 'Bitrix24: voice/audio message detected, transcribing...');
            const result = await this.transcribeVoice(fileId, fileInfo ? { downloadUrl: fileInfo.downloadUrl, size: fileInfo.size } : undefined);
            if (result.ok) {
              text = `[Голосовое сообщение]: ${result.text}`;
            } else if (result.reason === 'oversized') {
              const sizeKb = Math.round(result.sizeBytes / 1024);
              text = `[Голосовое сообщение пропущено: извините, парни, слишком длинная голосовуха (${sizeKb} КБ — лимит ${Math.round(MAX_VOICE_BYTES / 1024)} КБ). Напишите текстом или разбейте на короткие сообщения.]`;
            } else {
              text = '[Голосовое сообщение: не удалось расшифровать]';
            }
          } else {
            const sizeBytes = fileInfo?.size || 0;
            const sizeKb = sizeBytes ? Math.round(sizeBytes / 1024) : null;
            const sizePart = sizeKb !== null ? `, ${sizeKb} КБ` : '';
            const displayName = fileName || fileId;
            if (sizeBytes > MAX_FILE_BYTES) {
              const sizeMb = Math.round(sizeBytes / 1024 / 1024);
              text = `[Прислан файл: ${displayName} (${sizeMb} МБ) — пропущен, слишком большой (лимит ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} МБ)]`;
              logger.warn({ msgId, fileId, fileName, sizeBytes }, 'Bitrix24: file exceeds size limit, not saved');
            } else if (fileInfo?.downloadUrl) {
              const saved = await this.saveFileToInbox(groups[routingJid].folder, msgId, {
                name: fileName,
                downloadUrl: fileInfo.downloadUrl,
                size: sizeBytes,
              });
              if (saved) {
                logger.info({ msgId, fileId, fileName, path: saved.relPath }, 'Bitrix24: file saved to group inbox');
                text = `[Прислан файл: ${displayName}${sizePart}, путь: ${saved.relPath}]`;
              } else {
                text = `[Прислан файл: ${displayName}${sizePart} — не удалось сохранить]`;
              }
            } else {
              text = `[Прислан файл: ${displayName}${sizePart}]`;
            }
          }
        }

        if (!text) continue;

        // Prefix extra user messages so agent knows who wrote
        const finalText = isExtraUser ? `[Личное сообщение от ${senderName}]: ${text}` : text;

        logger.info({ msgId, jid: routingJid, text: finalText.slice(0, 80) }, 'Bitrix24 message stored');

        this.opts.onMessage(routingJid, {
          id: String(msg.id),
          chat_jid: routingJid,
          sender: authorId,
          sender_name: senderName,
          content: finalText,
          timestamp,
          is_from_me: false,
        });
      }
    } catch (err) {
      logger.warn({ err, dialogId }, 'Bitrix24 poll dialog error');
    }
  }

  private async poll(): Promise<void> {
    this.pollCount++;

    // Periodically discover new groups
    if (this.pollCount % GROUP_DISCOVER_EVERY === 0) {
      await this.discoverGroupChats(true);
    }

    // Poll personal dialog (Alexander)
    await this.pollDialog(this.allowedUserId, jidForUser(this.allowedUserId), false);

    // Poll extra authorized users' personal dialogs
    for (const userId of this.extraAllowedUserIds) {
      await this.pollDialog(userId, jidForUser(userId), false);
    }

    // Poll all known group chats
    for (const chatId of this.knownGroupChatIds) {
      await this.pollDialog(`chat${chatId}`, jidForChat(chatId), true);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const dialogId = dialogIdForJid(jid);
    try {
      const plain = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
      await this.b24('im.message.add', {
        DIALOG_ID: dialogId,
        MESSAGE: plain,
      });
      logger.info({ jid, dialogId, length: text.length }, 'Bitrix24 message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Bitrix24: failed to send message');
    }
  }

  isConnected(): boolean {
    return this.pollTimer !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('bx24:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Bitrix24 channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Bitrix24 has no simple typing indicator API
  }
}

registerChannel('bitrix24', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'BITRIX24_WEBHOOK',
    'BITRIX24_CLIENT_ENDPOINT',
    'BITRIX24_ACCESS_TOKEN',
    'BITRIX24_REFRESH_TOKEN',
    'BITRIX24_CLIENT_ID',
    'BITRIX24_CLIENT_SECRET',
    'BITRIX24_ALLOWED_USER_ID',
    'BITRIX24_BOT_USER_ID',
    'BITRIX24_EXTRA_USER_IDS',
  ]);
  const pick = (k: string) => process.env[k] || envVars[k] || '';

  const allowedUserId = pick('BITRIX24_ALLOWED_USER_ID') || '226';
  const botUserId = pick('BITRIX24_BOT_USER_ID') || '3273';
  // Default: board of directors + direct team (Bitrix24 user IDs)
  const DEFAULT_EXTRA_USER_IDS = '218,753,5,220,662,2419,2693,73,2581,54,1760,65,926,274,2514,2555,1680,1657,3236,2018,13,777,2475,56,219,2360,58,1266,1889,1232,690,64,3130';
  const extraUserIdsRaw = pick('BITRIX24_EXTRA_USER_IDS') || DEFAULT_EXTRA_USER_IDS;
  const extraAllowedUserIds = extraUserIdsRaw
    ? extraUserIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  // OAuth path is preferred. All OAuth env vars must be present together.
  const oauthEndpoint = pick('BITRIX24_CLIENT_ENDPOINT');
  const accessToken = pick('BITRIX24_ACCESS_TOKEN');
  const refreshToken = pick('BITRIX24_REFRESH_TOKEN');
  const clientId = pick('BITRIX24_CLIENT_ID');
  const clientSecret = pick('BITRIX24_CLIENT_SECRET');
  const oauthReady =
    oauthEndpoint && accessToken && refreshToken && clientId && clientSecret;

  let auth: BxAuth | null = null;
  if (oauthReady) {
    // Normalize: client_endpoint must end with a trailing slash so `${endpoint}${method}` is well-formed.
    const ep = oauthEndpoint.endsWith('/') ? oauthEndpoint : oauthEndpoint + '/';
    auth = {
      mode: 'oauth',
      clientEndpoint: ep,
      accessToken,
      refreshToken,
      clientId,
      clientSecret,
    };
    logger.info({ endpoint: ep }, 'Bitrix24: OAuth mode (published-app credentials)');
  } else {
    const webhook = pick('BITRIX24_WEBHOOK');
    if (webhook) {
      auth = { mode: 'webhook', webhookUrl: webhook };
      logger.warn(
        'Bitrix24: using legacy webhook auth — consider migrating to OAuth (set BITRIX24_CLIENT_ENDPOINT/ACCESS_TOKEN/REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET)',
      );
    }
  }

  if (!auth) {
    logger.info('Bitrix24: no credentials configured (OAuth or webhook), channel disabled');
    return null;
  }

  return new Bitrix24Channel(auth, allowedUserId, botUserId, opts, extraAllowedUserIds);
});
