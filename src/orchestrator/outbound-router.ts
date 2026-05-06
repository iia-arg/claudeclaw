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
  let a2aFallback:
    | ((envelope: OutboundEnvelope) => Promise<boolean>)
    | null = null;

  return {
    addPreHook(hook: OutboundPreHook): void {
      preHooks.push(hook);
    },

    addPostHook(hook: (envelope: OutboundEnvelope) => void): void {
      postHooks.push(hook);
    },

    setA2aFallback(
      fallback: (envelope: OutboundEnvelope) => Promise<boolean>,
    ): void {
      a2aFallback = fallback;
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

      // A2A inter-instance bus: try first, before local channel lookup. If
      // the target JID belongs to a sibling instance the bus drops a JSON
      // payload into their inbox and we treat the message as delivered.
      if (a2aFallback) {
        try {
          const formattedEnvelope: OutboundEnvelope = {
            ...current,
            text: formatted,
          };
          const handled = await a2aFallback(formattedEnvelope);
          if (handled) {
            for (const hook of postHooks) {
              try {
                hook(formattedEnvelope);
              } catch (err) {
                logger.error({ err }, 'Outbound post-hook error (a2a path)');
              }
            }
            return;
          }
        } catch (err) {
          logger.error(
            { err, jid: current.chatJid },
            'A2A fallback errored, falling through to local channel',
          );
        }
      }

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
        // For cross-group A2A delivery (one local group sending to another
        // local group via send_message(target_chat_jid=…)), persist with
        // is_bot_message=0 so the receiving group's message-loop sees the
        // row and triggers its agent. Telegram bot polling does NOT echo
        // our own outbound back as updates, so without this row the
        // recipient's loop has nothing to consume. For all other cases
        // (own stream output, task-results, extensions) keep the default
        // anti-loop bot mark.
        const persistAsBotMessage = !current.crossGroup;
        const persistSender = current.crossGroup
          ? `a2a:${ASSISTANT_NAME}`
          : 'bot';
        for (const messageId of messageIds) {
          try {
            storeMessageDirect({
              id: messageId,
              chat_jid: current.chatJid,
              sender: persistSender,
              sender_name: ASSISTANT_NAME,
              content: formatted,
              timestamp: sentAt,
              is_from_me: true,
              is_bot_message: persistAsBotMessage,
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
