import { Bot, type Context } from 'grammy';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { logger } from '../logger.js';
import { renderReply } from './format.js';
import { parseTodoCallback, type TodoGatewayHooks } from './todo-buttons.js';

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
  /** Tap-to-done todo buttons. */
  todos?: TodoGatewayHooks;
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
    // (Runs for callback queries too — ctx.from is the tapper.)
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

    // Todo button taps. A callback_query is NOT a chat message: it is resolved
    // here, deterministically, straight against the todo store — never through
    // the turn queue or the Engine. That is what makes rapid taps race-free.
    this.bot.on('callback_query:data', (ctx) => this.onTodoTap(ctx));

    // Slash commands bypass the turn queue entirely. If /cancel queued behind
    // the turn it is meant to cancel, it could never do its job.
    for (const cmd of COMMANDS) {
      this.bot.command(cmd, async (ctx) => {
        const chatId = ctx.chat.id;
        try {
          if (cmd === 'todos' && this.deps.todos) {
            const { text, keyboard } = this.deps.todos.renderList();
            await this.reply(ctx, text, keyboard);
            return;
          }
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

  /** Resolve a todo button tap: mark done, ack, and refresh the message. */
  private async onTodoTap(ctx: Context): Promise<void> {
    const data = ctx.callbackQuery?.data ?? '';
    const parsed = parseTodoCallback(data);
    if (!parsed || !this.deps.todos) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const label = this.deps.todos.markDone(parsed.id);
    await ctx.answerCallbackQuery(label ? `${label} done ✓` : `T${parsed.id} is already closed`).catch(() => {});
    try {
      if (parsed.mode === 'list') {
        // Managed list: re-render text + buttons so done rows disappear.
        const { text, keyboard } = this.deps.todos.renderList();
        const { chunks, html } = renderReply(text);
        await ctx.editMessageText(chunks[0] ?? text, {
          ...(html ? { parse_mode: 'HTML' } : {}),
          reply_markup: keyboard,
        });
      } else {
        // Annotated (model-authored) message: leave the text, drop the button
        // for the now-closed todo by re-deriving buttons from the same text.
        const current = ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message
          ? (ctx.callbackQuery.message.text ?? '')
          : '';
        await ctx.editMessageReplyMarkup({ reply_markup: this.deps.todos.annotate(current) });
      }
    } catch (e) {
      // Benign: Telegram rejects a no-op edit, and two fast taps can race to
      // edit the same message.
      if (!/not modified/i.test((e as Error).message)) {
        logger.warn({ err: (e as Error).message }, 'todo button edit failed');
      }
    }
  }

  private async reply(ctx: Context, markdown: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    const { chunks, html } = renderReply(markdown);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      // An explicit keyboard (the /todos list) wins; otherwise auto-annotate the
      // last chunk with buttons for any open todos it mentions.
      const kb = isLast ? (keyboard !== undefined ? keyboard : this.deps.todos?.annotate(markdown)) : undefined;
      const opts = { ...(html ? { parse_mode: 'HTML' as const } : {}), ...(kb ? { reply_markup: kb } : {}) };
      try {
        await ctx.reply(chunks[i]!, opts);
      } catch (e) {
        // Telegram rejects the whole message on bad markup; deliver it as plain
        // text rather than losing the answer (keeping any buttons).
        logger.warn({ err: (e as Error).message }, 'HTML reply rejected, retrying as plain text');
        await ctx
          .reply(chunks[i]!.replace(/<[^>]+>/g, ''), kb ? { reply_markup: kb } : {})
          .catch((e2) => logger.error({ err: String(e2) }, 'reply failed'));
      }
    }
  }

  /** Proactive message (job results, failures, pepperctl send). */
  async sendTo(chatId: number, markdown: string): Promise<void> {
    const { chunks, html } = renderReply(markdown);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const kb = isLast ? this.deps.todos?.annotate(markdown) : undefined;
      const opts = { ...(html ? { parse_mode: 'HTML' as const } : {}), ...(kb ? { reply_markup: kb } : {}) };
      try {
        await this.bot.api.sendMessage(chatId, chunks[i]!, opts);
      } catch (e) {
        logger.warn({ err: (e as Error).message }, 'HTML send rejected, retrying as plain text');
        await this.bot.api
          .sendMessage(chatId, chunks[i]!.replace(/<[^>]+>/g, ''), kb ? { reply_markup: kb } : {})
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
