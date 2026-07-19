import { Bot, type Context } from 'grammy';
import { logger } from '../logger.js';
import { renderReply } from './format.js';

export interface GatewayDeps {
  token: string;
  /** Numeric Telegram user IDs allowed to talk to the bot. */
  ownerIds: number[];
  /** Handle a normal (non-command) message. Returns the reply, or '' for none. */
  onMessage: (chatId: number, text: string) => Promise<string>;
  /** Handle a slash command out-of-band. */
  onCommand: (chatId: number, command: string) => Promise<string>;
  /** Called with the first owner chat we see, so proactive sends have a target. */
  onOwnerChat: (chatId: number) => void;
}

const COMMANDS = ['new', 'status', 'jobs', 'cancel', 'soul', 'todos'] as const;

/**
 * Telegram in, replies out. Long-polling, so the box needs no inbound port and
 * no public endpoint — which is why the security group can deny all ingress.
 */
export class TelegramGateway {
  private readonly bot: Bot;

  constructor(private readonly deps: GatewayDeps) {
    this.bot = new Bot(deps.token);

    // Allowlist first, before anything else touches the message. A stranger's
    // text should never reach the model, the queue, or the logs' message body.
    this.bot.use(async (ctx, next) => {
      const uid = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (!uid || !this.deps.ownerIds.includes(uid)) {
        logger.warn({ uid, chatId }, 'dropped message from non-owner');
        return;
      }
      if (ctx.chat?.type !== 'private') {
        logger.warn({ uid, chatId, type: ctx.chat?.type }, 'dropped non-private chat message');
        return;
      }
      if (chatId) this.deps.onOwnerChat(chatId);
      await next();
    });

    // Slash commands bypass the turn queue entirely. If /cancel queued behind
    // the turn it is meant to cancel, it could never do its job.
    for (const cmd of COMMANDS) {
      this.bot.command(cmd, async (ctx) => {
        const chatId = ctx.chat.id;
        try {
          const text = await this.deps.onCommand(chatId, cmd);
          await this.reply(ctx, text);
        } catch (e) {
          logger.error({ err: e, cmd }, 'command failed');
          await this.reply(ctx, `Command failed: ${(e as Error).message}`);
        }
      });
    }

    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) {
        await this.reply(ctx, `Unknown command. Try: ${COMMANDS.map((c) => '/' + c).join(' ')}`);
        return;
      }
      try {
        await ctx.replyWithChatAction('typing').catch(() => {});
        const reply = await this.deps.onMessage(ctx.chat.id, text);
        if (reply) await this.reply(ctx, reply);
      } catch (e) {
        const err = e as Error;
        logger.error({ err: err.message }, 'message handling failed');
        await this.reply(
          ctx,
          err.name === 'AbortError' ? 'That took too long, so I stopped it.' : `Something went wrong: ${err.message}`,
        );
      }
    });

    this.bot.catch((err) => logger.error({ err: err.message }, 'grammY error'));
  }

  private async reply(ctx: Context, markdown: string): Promise<void> {
    const { chunks, html } = renderReply(markdown);
    for (const chunk of chunks) {
      try {
        await ctx.reply(chunk, html ? { parse_mode: 'HTML' } : {});
      } catch (e) {
        // Telegram rejects the whole message on bad markup; deliver it as plain
        // text rather than losing the answer.
        logger.warn({ err: (e as Error).message }, 'HTML reply rejected, retrying as plain text');
        await ctx.reply(chunk.replace(/<[^>]+>/g, '')).catch((e2) => logger.error({ err: String(e2) }, 'reply failed'));
      }
    }
  }

  /** Proactive message (job results, failures, pepperctl send). */
  async sendTo(chatId: number, markdown: string): Promise<void> {
    const { chunks, html } = renderReply(markdown);
    for (const chunk of chunks) {
      try {
        await this.bot.api.sendMessage(chatId, chunk, html ? { parse_mode: 'HTML' } : {});
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'HTML send rejected, retrying as plain text');
        await this.bot.api
          .sendMessage(chatId, chunk.replace(/<[^>]+>/g, ''))
          .catch((e2) => logger.error({ err: String(e2) }, 'send failed'));
      }
    }
  }

  async start(): Promise<void> {
    const me = await this.bot.api.getMe();
    logger.info({ bot: me.username }, 'telegram gateway starting (long-polling)');
    // Deliberately not awaited: bot.start() resolves only when polling stops.
    void this.bot.start({ drop_pending_updates: true, onStart: () => logger.info('polling') });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
