/**
 * MessageRouter — single outbound delivery service.
 * All output (agent responses, IPC messages, task results, extension output)
 * routes through here. Supports pre/post hooks for extensions.
 */
import {
  Channel,
  MessageRouter,
  OutboundEnvelope,
  OutboundPreHook,
} from './types.js';
import { formatOutbound } from './router.js';
import { logger } from './logger.js';
import { storeMessageDirect } from './db.js';
import { ASSISTANT_NAME } from './config.js';

function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

export function createMessageRouter(channels: Channel[]): MessageRouter {
  const preHooks: OutboundPreHook[] = [];
  const postHooks: ((envelope: OutboundEnvelope) => void)[] = [];

  return {
    addPreHook(hook: OutboundPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: OutboundEnvelope) => void): void {
      postHooks.push(hook);
    },

    async route(envelope: OutboundEnvelope): Promise<void> {
      let current = envelope;

      // Run pre-hooks sequentially
      for (const hook of preHooks) {
        try {
          const result = await hook(current);
          if (result.action === 'drop') {
            logger.debug(
              { jid: current.chatJid, reason: result.reason },
              'Outbound message dropped by pre-hook',
            );
            return;
          }
          if (result.action === 'modify') {
            current = result.envelope;
          }
        } catch (err) {
          logger.error({ err }, 'Outbound pre-hook error (continuing)');
        }
      }

      // Format (strip internal tags)
      const formatted = formatOutbound(current.text);
      if (!formatted) return;

      // Find channel and deliver
      const channel = channels.find(
        (c) => c.ownsJid(current.chatJid) && c.isConnected(),
      );
      if (!channel) {
        logger.warn(
          { jid: current.chatJid },
          'No connected channel for JID — message not delivered',
        );
        return;
      }

      const sendResult = await channel.sendMessage(current.chatJid, formatted, {
        replyTo: current.replyTo,
      });

      // Record outgoing message(s) in DB so delivery is provable. Each
      // platform-assigned message id becomes a row with is_from_me=1 and
      // is_bot_message=1. Channels that do not return ids (or fail mid-send)
      // produce an empty array — we silently skip persistence in that case.
      const messageIds = sendResult?.messageIds ?? [];
      if (messageIds.length > 0) {
        const sentAt = new Date().toISOString();
        for (const messageId of messageIds) {
          try {
            storeMessageDirect({
              id: messageId,
              chat_jid: current.chatJid,
              sender: 'bot',
              sender_name: ASSISTANT_NAME,
              content: formatted,
              timestamp: sentAt,
              is_from_me: true,
              is_bot_message: true,
            });
          } catch (err) {
            logger.warn(
              { jid: current.chatJid, messageId, err },
              'Failed to persist outgoing message',
            );
          }
        }
      } else {
        logger.warn(
          { jid: current.chatJid, channel: channel.name },
          'Channel returned no message ids — outgoing not persisted',
        );
      }

      // Fire post-hooks (observe only, errors don't affect delivery)
      for (const hook of postHooks) {
        try {
          hook(current);
        } catch (err) {
          logger.error({ err }, 'Outbound post-hook error');
        }
      }
    },

    async send(jid: string, text: string): Promise<void> {
      return this.route({
        chatJid: jid,
        text,
        triggerType: 'extension',
      });
    },
  };
}
