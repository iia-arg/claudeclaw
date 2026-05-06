/**
 * A2A Bus — inter-instance push transport over shared filesystem.
 *
 * Problem: each ClaudeClaw instance owns its own Telegram bot token. Bots can
 * only deliver messages to chats where THAT bot is authorized. So when an
 * agent on instance A calls `send_message(target_chat_jid=X)` and X is owned
 * by instance B, the local Telegram channel either silently fails (Bot API
 * 403) or, worse, posts under the wrong bot identity.
 *
 * Solution: each instance writes its JID inventory to a shared registry, and
 * each instance owns an inbox directory under shared/. When the outbound
 * router detects a target JID belongs to another instance, it drops a JSON
 * payload into the target's inbox; the target instance's `fs.watch` picks it
 * up, validates, and ingests it as an incoming message from `a2a:<sender>`.
 *
 * Layout (root configurable via A2A_SHARED_DIR, default
 * /home/claude/my-assistant/shared):
 *
 *   instance-registry/
 *     claudeclaw.json         { instance, inbox_dir, groups[], updated_at }
 *     ostrov.json
 *     lyudmila.json
 *   a2a-inbox/
 *     claudeclaw/             ← claudeclaw watches this
 *       <msg_id>.json
 *       errors/
 *     ostrov/
 *     lyudmila/
 *
 * Authorization model: anyone who can write to a shared inbox dir can deliver
 * a message. Inboxes live under /home/claude/my-assistant/shared which is
 * owned by `claude:claude` and not exposed externally — same trust boundary
 * as everything else on this host.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { logger as defaultLogger } from './logger.js';
import { MessageIngestion, OutboundEnvelope, RegisteredGroup } from './types.js';

const SHARED_ROOT =
  process.env.A2A_SHARED_DIR || '/home/claude/my-assistant/shared';
const REGISTRY_DIR = path.join(SHARED_ROOT, 'instance-registry');
const INBOX_ROOT = path.join(SHARED_ROOT, 'a2a-inbox');

const REGISTRY_REFRESH_MS = 30_000;
const SWEEP_INTERVAL_MS = 30_000;
const PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HOPS = 4;
const PAYLOAD_VERSION = 1;

export interface A2aPayload {
  v: typeof PAYLOAD_VERSION;
  msg_id: string;
  from_instance: string;
  from_folder?: string;
  from_sender_name?: string;
  to_chat_jid: string;
  text: string;
  hops: number;
  ts: string;
}

export interface A2aDropOptions {
  text: string;
  from_folder?: string;
  from_sender_name?: string;
  hops?: number;
}

export interface A2aBusHandle {
  /** True iff jid is registered in another (running) instance, not this one. */
  isRemote(jid: string): boolean;
  /** Drop a payload into the target instance's inbox. Resolves to delivery success. */
  dropTo(jid: string, opts: A2aDropOptions): Promise<boolean>;
  /** Convenience for outbound-router fallback wiring. */
  outboundFallback(envelope: OutboundEnvelope): Promise<boolean>;
  /** Force a re-read of all registry files (call after registerGroup). */
  refresh(): void;
  shutdown(): void;
}

export interface A2aBusDeps {
  /** Instance identifier — defaults to basename(cwd). */
  instance: string;
  registeredGroups: () => Record<string, RegisteredGroup>;
  ingestion: MessageIngestion;
  logger?: typeof defaultLogger;
}

interface RemoteEntry {
  instance: string;
  inbox_dir: string;
  folder: string;
}

export function startA2aBus(deps: A2aBusDeps): A2aBusHandle {
  const log = deps.logger || defaultLogger;
  const instance = deps.instance;
  const myInbox = path.join(INBOX_ROOT, instance);
  const myErrors = path.join(myInbox, 'errors');
  const myRegistryFile = path.join(REGISTRY_DIR, `${instance}.json`);

  fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  fs.mkdirSync(myInbox, { recursive: true });
  fs.mkdirSync(myErrors, { recursive: true });

  let remoteMap = new Map<string, RemoteEntry>();
  let shuttingDown = false;

  function writeMyRegistry(): void {
    const groups = Object.entries(deps.registeredGroups()).map(([jid, g]) => ({
      chat_jid: jid,
      folder: g.folder,
      name: g.name,
      isMain: !!g.isMain,
    }));
    const payload = {
      instance,
      inbox_dir: myInbox,
      groups,
      updated_at: new Date().toISOString(),
    };
    const tmp = `${myRegistryFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, myRegistryFile);
  }

  function refreshRemoteMap(): void {
    const next = new Map<string, RemoteEntry>();
    let files: string[] = [];
    try {
      files = fs.readdirSync(REGISTRY_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      // no registry dir — first run anywhere
    }
    for (const f of files) {
      const otherInstance = f.replace(/\.json$/, '');
      if (otherInstance === instance) continue;
      const fullPath = path.join(REGISTRY_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')) as {
          inbox_dir?: string;
          groups?: Array<{ chat_jid?: string; folder?: string }>;
        };
        if (!data.inbox_dir || !Array.isArray(data.groups)) continue;
        for (const g of data.groups) {
          if (typeof g.chat_jid !== 'string') continue;
          // Local registration wins: don't overwrite a JID we already know.
          if (next.has(g.chat_jid)) continue;
          next.set(g.chat_jid, {
            instance: otherInstance,
            inbox_dir: data.inbox_dir,
            folder: g.folder || '',
          });
        }
      } catch (err) {
        log.warn({ err, file: fullPath }, 'a2a-bus: skipping bad registry file');
      }
    }
    remoteMap = next;
  }

  function dropOwnedJids(): void {
    // Remove from remoteMap any JID that we ourselves have registered locally
    // (local always wins). This handles the case where two instances both
    // claim the same JID — local instance does NOT mark it as remote.
    const local = deps.registeredGroups();
    for (const jid of Object.keys(local)) {
      remoteMap.delete(jid);
    }
  }

  function refresh(): void {
    try {
      writeMyRegistry();
      refreshRemoteMap();
      dropOwnedJids();
    } catch (err) {
      log.error({ err }, 'a2a-bus: refresh failed');
    }
  }

  // Bootstrap
  refresh();

  const refreshTimer = setInterval(refresh, REGISTRY_REFRESH_MS);
  refreshTimer.unref();

  // Watch own inbox for new files (push semantics).
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(myInbox, { persistent: true }, (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      const filePath = path.join(myInbox, filename);
      // Tiny debounce: writer uses tmp+rename, but we still pause briefly
      // to avoid racing partial reads on slow filesystems.
      setTimeout(() => {
        processInboxFile(filePath).catch((err) =>
          log.error({ err, filePath }, 'a2a-bus: processInboxFile errored'),
        );
      }, 25);
    });
  } catch (err) {
    log.error({ err, dir: myInbox }, 'a2a-bus: failed to watch inbox');
  }

  // Initial sweep + periodic safety-net sweep (covers fs.watch flakiness).
  setTimeout(() => {
    sweepInbox().catch((err) =>
      log.error({ err }, 'a2a-bus: initial sweep failed'),
    );
  }, 500);
  const sweepTimer = setInterval(() => {
    sweepInbox().catch((err) =>
      log.error({ err }, 'a2a-bus: periodic sweep failed'),
    );
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  async function sweepInbox(): Promise<void> {
    if (shuttingDown) return;
    let files: string[] = [];
    try {
      files = fs.readdirSync(myInbox).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      await processInboxFile(path.join(myInbox, f));
    }
  }

  async function moveToErrors(filePath: string): Promise<void> {
    try {
      const dest = path.join(myErrors, path.basename(filePath));
      fs.renameSync(filePath, dest);
    } catch {
      // best effort
    }
  }

  async function processInboxFile(filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // already consumed by another tick
      return;
    }
    let payload: A2aPayload;
    try {
      payload = JSON.parse(raw) as A2aPayload;
      if (payload.v !== PAYLOAD_VERSION) {
        throw new Error(`unsupported version ${payload.v}`);
      }
      if (
        !payload.from_instance ||
        !payload.to_chat_jid ||
        typeof payload.text !== 'string'
      ) {
        throw new Error('payload missing required fields');
      }
    } catch (err) {
      log.warn({ err, file: filePath }, 'a2a-bus: bad payload, moving to errors/');
      await moveToErrors(filePath);
      return;
    }

    const tsMs = Date.parse(payload.ts);
    if (Number.isFinite(tsMs) && Date.now() - tsMs > PAYLOAD_TTL_MS) {
      log.warn(
        { file: filePath, age_ms: Date.now() - tsMs },
        'a2a-bus: payload TTL expired, dropping',
      );
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      return;
    }

    if ((payload.hops ?? 0) > MAX_HOPS) {
      log.warn({ payload }, 'a2a-bus: max hops exceeded, dropping');
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      return;
    }

    const groups = deps.registeredGroups();
    const target = groups[payload.to_chat_jid];
    if (!target) {
      log.warn(
        { jid: payload.to_chat_jid, from: payload.from_instance },
        'a2a-bus: target JID not registered locally, moving to errors/',
      );
      await moveToErrors(filePath);
      return;
    }

    const senderTag = `a2a:${payload.from_instance}`;
    const senderName = payload.from_sender_name || `Забава (${payload.from_instance})`;

    try {
      await deps.ingestion.ingest({
        groupFolder: target.folder,
        chatJid: payload.to_chat_jid,
        sender: senderTag,
        senderName,
        triggerType: 'extension',
        prompt: payload.text,
        bypassTrigger: true,
        meta: {
          a2a: true,
          from_instance: payload.from_instance,
          from_folder: payload.from_folder,
          msg_id: payload.msg_id,
          hops: payload.hops ?? 0,
        },
      });
      log.info(
        {
          jid: payload.to_chat_jid,
          from: payload.from_instance,
          msg_id: payload.msg_id,
        },
        'a2a-bus: incoming ingested',
      );
    } catch (err) {
      log.error({ err, payload }, 'a2a-bus: ingestion threw, moving to errors/');
      await moveToErrors(filePath);
      return;
    }

    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore — already gone */
    }
  }

  async function dropTo(
    jid: string,
    opts: A2aDropOptions,
  ): Promise<boolean> {
    const target = remoteMap.get(jid);
    if (!target) return false;

    const msgId = `a2a-${Date.now()}-${crypto
      .randomBytes(4)
      .toString('hex')}`;
    const payload: A2aPayload = {
      v: PAYLOAD_VERSION,
      msg_id: msgId,
      from_instance: instance,
      from_folder: opts.from_folder,
      from_sender_name: opts.from_sender_name,
      to_chat_jid: jid,
      text: opts.text,
      hops: (opts.hops ?? 0) + 1,
      ts: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(target.inbox_dir, { recursive: true });
    } catch {
      /* may not own this path; rename will fail too and we'll log below */
    }
    const tmp = path.join(target.inbox_dir, `${msgId}.tmp`);
    const finalPath = path.join(target.inbox_dir, `${msgId}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, finalPath);
      log.info(
        {
          msg_id: msgId,
          target_jid: jid,
          target_instance: target.instance,
          hops: payload.hops,
        },
        'a2a-bus: dropped to remote inbox',
      );
      return true;
    } catch (err) {
      log.error(
        { err, msg_id: msgId, target_jid: jid, inbox_dir: target.inbox_dir },
        'a2a-bus: drop failed',
      );
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return false;
    }
  }

  async function outboundFallback(
    envelope: OutboundEnvelope,
  ): Promise<boolean> {
    if (!remoteMap.has(envelope.chatJid)) return false;
    const fromHops =
      typeof envelope.meta?.hops === 'number' ? envelope.meta.hops : 0;
    return dropTo(envelope.chatJid, {
      text: envelope.text,
      from_folder: envelope.groupFolder,
      hops: fromHops,
    });
  }

  function shutdown(): void {
    shuttingDown = true;
    clearInterval(refreshTimer);
    clearInterval(sweepTimer);
    if (watcher) {
      try {
        watcher.close();
      } catch {
        /* ignore */
      }
    }
    try {
      fs.unlinkSync(myRegistryFile);
    } catch {
      /* ignore — startup will recreate */
    }
  }

  return {
    isRemote(jid: string): boolean {
      return remoteMap.has(jid);
    },
    dropTo,
    outboundFallback,
    refresh,
    shutdown,
  };
}
