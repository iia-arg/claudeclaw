import fs from 'fs';
import os from 'os';
import path from 'path';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { logger } from '../orchestrator/logger.js';
import { registerChannel, ChannelOpts } from '../orchestrator/channel-registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../orchestrator/types.js';

const POLL_INTERVAL_MS = 60_000;
const CREDENTIALS_PATH = path.join(os.homedir(), '.gmail-mcp', 'credentials.json');
const KEYS_PATH = path.join(os.homedir(), '.gmail-mcp', 'gcp-oauth.keys.json');

interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function createOAuth2Client(): OAuth2Client | null {
  try {
    if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(CREDENTIALS_PATH)) return null;
    const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const { client_id, client_secret } = keys.installed || keys.web || {};
    if (!client_id || !client_secret) return null;
    const client = new OAuth2Client({ clientId: client_id, clientSecret: client_secret });
    client.setCredentials(creds);
    return client;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Gmail: failed to create OAuth2 client');
    return null;
  }
}

function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  return '';
}

export class GmailChannel implements Channel {
  name = 'gmail';
  private opts: GmailChannelOpts;
  private pollTimer: NodeJS.Timeout | null = null;
  private auth: OAuth2Client | null = null;
  private connected = false;

  constructor(opts: GmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.auth = createOAuth2Client();
    if (!this.auth) {
      logger.warn('Gmail: credentials not found, channel disabled');
      return;
    }
    this.connected = true;
    logger.info('Gmail channel connected, starting inbox poll');
    this.schedulePoll();
  }

  private schedulePoll(): void {
    this.pollTimer = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  private async poll(): Promise<void> {
    try {
      await this.checkInbox();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Gmail poll error');
    } finally {
      if (this.connected) this.schedulePoll();
    }
  }

  private async checkInbox(): Promise<void> {
    if (!this.auth) return;

    // Route Gmail notifications to the main group (is_main=1)
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
    if (!mainEntry) {
      logger.debug('Gmail: no main group registered, skipping poll');
      return;
    }
    const [mainJid] = mainEntry;

    const gmail = google.gmail({ version: 'v1', auth: this.auth });
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread category:primary',
      maxResults: 10,
    });

    const messages = listRes.data.messages || [];
    if (messages.length === 0) return;

    logger.info({ count: messages.length }, 'Gmail: new messages found');

    for (const msg of messages) {
      if (!msg.id) continue;
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const payload = full.data.payload;
        const headers = payload?.headers || [];
        const get = (name: string) => headers.find((h: any) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

        const from = get('From');
        const subject = get('Subject') || '(no subject)';
        const date = get('Date');
        const body = extractBody(payload).slice(0, 2000).trim();

        const content = `[Email from ${from}]\nSubject: ${subject}\nDate: ${date}\n\n${body}`;
        const timestamp = new Date().toISOString();

        this.opts.onChatMetadata(mainJid, timestamp, undefined, 'telegram', false);
        this.opts.onMessage(mainJid, {
          id: `gmail_${msg.id}`,
          chat_jid: mainJid,
          sender: from,
          sender_name: from,
          content,
          timestamp,
          is_from_me: false,
        });

        // Mark as read
        await gmail.users.messages.modify({
          userId: 'me',
          id: msg.id,
          requestBody: { removeLabelIds: ['UNREAD'] },
        });

        logger.info({ from, subject, id: msg.id }, 'Gmail message processed');
      } catch (err) {
        logger.warn({ err: (err as Error).message, id: msg.id }, 'Gmail: failed to process message');
      }
    }
  }

  async sendMessage(_jid: string, _text: string, _opts?: { replyTo?: { messageId: number } }): Promise<{ messageIds: string[] }> {
    // Gmail responses are handled via mcp__gmail__* tools by the agent itself
    logger.debug('Gmail channel: sendMessage is a no-op (agent uses MCP tools directly)');
    return { messageIds: [] };
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(_jid: string): boolean {
    return false; // Responses go via Telegram, not Gmail
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Gmail channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // not supported
  }
}

registerChannel('gmail', (opts: ChannelOpts) => {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    logger.warn('Gmail: ~/.gmail-mcp/credentials.json not found, channel not loaded');
    return null;
  }
  return new GmailChannel(opts);
});
