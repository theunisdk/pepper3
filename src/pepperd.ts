#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig, requireBotToken, socketPath, type PepperConfig } from './config.js';
import { getMeta, openDb, setMeta, clearThread } from './db.js';
import { logger } from './logger.js';
import { initWorkspace } from './workspace.js';
import { firstTurnInput, withDateHeader } from './context.js';
import { decideRotation, NUDGE_NOTICE, ROTATE_NOTICE } from './chat/rotation.js';
import { TelegramGateway } from './chat/gateway.js';
import { TurnQueue } from './chat/queue.js';
import { ControlServer } from './control/server.js';
import { Scheduler } from './scheduler/scheduler.js';
import { anomalousRuns, listJobs } from './scheduler/jobs.js';
import { CodexEngine } from './engine/codex/adapter.js';
import { ContextExhaustedError, EngineAuthError, type Engine, type TurnInput } from './engine/types.js';
import type { Job } from './db.js';
import { listTodos, renderTodoList } from './todos.js';
import { todoHooks } from './chat/todo-buttons.js';
import { createTranscriber } from './chat/transcribe.js';
import { createAttachmentProcessor } from './chat/attachments.js';

const MAIN_CHAT_KEY = 'main';
const META_MAIN_CHAT_ID = 'main_chat_id';
const META_THREAD_TOKENS = 'main_thread_tokens';
const META_THREAD_NUDGED = 'main_thread_nudged';

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? process.env.PEPPER_CONFIG ?? 'pepper.config.json');
  const cfg = loadConfig(configPath);
  const token = requireBotToken();

  const ws = initWorkspace(cfg, configPath);
  if (!ws.skillsLinked) logger.warn({ detail: ws.skillsDetail }, 'skills are NOT linked — authored skills will be ignored');

  const db = openDb(cfg.dbPath);
  const engine: Engine = new CodexEngine({
    db,
    workspacePath: cfg.workspacePath,
    codexHome: cfg.codexHome,
    configPath,
    gwsConfigDir: cfg.gwsConfigDir,
    ...(cfg.model ? { model: cfg.model } : {}),
    ...(cfg.sandboxWritableRoots.length ? { additionalDirectories: cfg.sandboxWritableRoots } : {}),
  });

  const health = await engine.health();
  if (!health.authenticated) {
    // Not fatal: Telegram should still answer, if only to say what's wrong.
    logger.error({ detail: health.detail }, 'engine is NOT authenticated — turns will fail until you log in');
  } else {
    logger.info({ authMode: health.authMode, detail: health.detail }, 'engine authenticated');
  }

  const startedAt = Date.now();
  let mainChatId: number | null = Number(getMeta(db, META_MAIN_CHAT_ID)) || null;

  // --- turn execution ------------------------------------------------------
  // Whether a thread is new decides whether standing context is injected. A new
  // thread gets MEMORY.md + notes; an existing one just gets the date header.
  const isNewThread = (chatKey: string) => !getMetaThread(chatKey);
  const getMetaThread = (chatKey: string) => {
    const row = db.prepare('SELECT thread_id FROM threads WHERE chat_key = ?').get(chatKey) as
      | { thread_id: string }
      | undefined;
    return row?.thread_id;
  };

  // Thread-hygiene bookkeeping lives in meta so it survives restarts and is
  // cleared whenever the thread itself is reset.
  const clearThreadHygiene = () => {
    setMeta(db, META_THREAD_TOKENS, '0');
    setMeta(db, META_THREAD_NUDGED, '0');
  };

  async function resetMainThread(): Promise<void> {
    await engine.resetThread(MAIN_CHAT_KEY);
    clearThreadHygiene();
  }

  async function runOnMain(turnInput: TurnInput, signal: AbortSignal): Promise<string> {
    // TODO(images): turnInput.images is not yet threaded into engine.runTurn — a later task wires it up.
    const prompt = turnInput.text;
    const input = isNewThread(MAIN_CHAT_KEY)
      ? firstTurnInput(cfg, prompt)
      : withDateHeader(prompt, cfg.timezone);
    try {
      const res = await engine.runTurn(MAIN_CHAT_KEY, input, signal);

      // Daemon-owned thread hygiene: nudge once as the thread gets long,
      // rotate outright before it gets pathological. Rotation is cheap —
      // standing context re-injects durable memory on the fresh thread.
      if (res.inputTokens !== undefined) setMeta(db, META_THREAD_TOKENS, String(res.inputTokens));
      const nudged = getMeta(db, META_THREAD_NUDGED) === '1';
      const decision = decideRotation(res.inputTokens, nudged, cfg.threadNudgeTokens, cfg.threadRotateTokens);
      if (decision === 'rotate') {
        logger.info({ inputTokens: res.inputTokens }, 'rotating main thread (token threshold)');
        await resetMainThread();
        return res.text + ROTATE_NOTICE;
      }
      if (decision === 'nudge') {
        setMeta(db, META_THREAD_NUDGED, '1');
        return res.text + NUDGE_NOTICE;
      }
      return res.text;
    } catch (err) {
      if (err instanceof ContextExhaustedError) {
        // The safety net below the rotation policy: if a turn still dies on
        // context length, reset and retry with standing context.
        logger.warn('context exhausted — resetting thread');
        await resetMainThread();
        const res = await engine.runTurn(MAIN_CHAT_KEY, firstTurnInput(cfg, prompt), signal);
        return `_(Started a fresh thread — the old one got too long. My notes and memory carried over.)_\n\n${res.text}`;
      }
      if (err instanceof EngineAuthError) {
        return `I can't reach the model: my Codex login needs renewing.\n\n\`codex login --device-auth\` on the box (CODEX_HOME=${cfg.codexHome}).\n\nDetails: ${err.message}`;
      }
      throw err;
    }
  }

  const queue = new TurnQueue({ timeoutMs: cfg.turnTimeoutMs, run: runOnMain });
  // Isolated jobs get their own slot so a long report doesn't block chat.
  const isolatedQueue = new TurnQueue({
    timeoutMs: cfg.turnTimeoutMs,
    // TODO(images): input.images is not yet threaded into engine.runIsolated — a later task wires it up.
    run: async (input, signal) => (await engine.runIsolated(firstTurnInput(cfg, input.text), signal)).text,
  });

  // --- telegram ------------------------------------------------------------
  const gateway = new TelegramGateway({
    token,
    ownerIds: cfg.ownerTelegramIds,
    onOwnerChat: (chatId) => {
      if (mainChatId === null) {
        mainChatId = chatId;
        setMeta(db, META_MAIN_CHAT_ID, String(chatId));
        logger.info({ chatId }, 'main chat established');
      }
    },
    onMessage: (_chatId, text) => queue.submit(text),
    onCommand: async (_chatId, cmd) => {
      switch (cmd) {
        case 'new':
          await resetMainThread();
          return 'Started a fresh thread. My memory and notes are reloaded from disk.';
        case 'cancel':
          return queue.cancel() ? 'Stopped it.' : 'Nothing was running.';
        case 'jobs':
          return renderJobs(db);
        case 'status':
          return await renderStatus(cfg, db, engine, startedAt, queue.depth, ws.skillsLinked, ws.skillsDetail);
        case 'soul': {
          const soulPath = join(cfg.workspacePath, 'SOUL.md');
          if (!existsSync(soulPath)) return 'No SOUL.md yet — restart pepperd to create it from the template.';
          return readFileSync(soulPath, 'utf8');
        }
        case 'todos':
          return renderTodoList(listTodos(db, {}));
        default:
          return `Unknown command: ${cmd}`;
      }
    },
    // A tap resolves straight against the store — no Engine, no turn queue.
    todos: todoHooks(db),
    ...(cfg.whisperBin && cfg.whisperModel
      ? { transcribe: createTranscriber({ whisperBin: cfg.whisperBin, whisperModel: cfg.whisperModel }) }
      : {}),
    attachments: createAttachmentProcessor({ workspacePath: cfg.workspacePath, pdfMaxImagePages: cfg.pdfMaxImagePages }),
    attachmentMaxBytes: cfg.attachmentMaxBytes,
  });

  const notify = async (text: string): Promise<void> => {
    if (mainChatId === null) {
      logger.warn({ text: text.slice(0, 80) }, 'nothing to notify — no main chat yet; message the bot once');
      return;
    }
    await gateway.sendTo(mainChatId, text);
  };

  // --- scheduler -----------------------------------------------------------
  const scheduler = new Scheduler({
    db,
    graceMs: cfg.cronGraceMs,
    notify,
    runJob: async (job: Job) => {
      if (job.mode === 'isolated') {
        const text = await isolatedQueue.submit(job.prompt);
        if (text) await notify(text);
        return `isolated: ${text.slice(0, 200)}`;
      }
      // main mode: the prompt lands on the owner's real thread, so their reply
      // continues the same conversation. That is what makes "ask me daily"
      // work without the question and answer ending up in different contexts.
      const text = await queue.submit(job.prompt);
      if (text) await notify(text);
      return `main: ${text.slice(0, 200)}`;
    },
  });

  // --- control socket ------------------------------------------------------
  const control = new ControlServer(socketPath(cfg), {
    db,
    cfg,
    send: notify,
    status: () => renderStatus(cfg, db, engine, startedAt, queue.depth, ws.skillsLinked, ws.skillsDetail),
  });

  await control.start();
  await scheduler.start();
  await gateway.start();
  logger.info({ workspace: cfg.workspacePath, tz: cfg.timezone }, 'pepperd ready');

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    scheduler.stop();
    await gateway.stop().catch(() => {});
    await control.stop().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function renderJobs(db: ReturnType<typeof openDb>): string {
  const jobs = listJobs(db);
  if (jobs.length === 0) return 'No scheduled jobs. Ask me to add one, e.g. "remind me every weekday at 16:30 to …".';
  return jobs
    .map((j) => `• *${j.name}* — ${j.kind === 'at' ? `once at ${j.schedule}` : j.schedule} (${j.mode})\n  next: ${j.next_run ? new Date(j.next_run).toISOString() : 'never'}`)
    .join('\n');
}

async function renderStatus(
  cfg: PepperConfig,
  db: ReturnType<typeof openDb>,
  engine: Engine,
  startedAt: number,
  depth: number,
  skillsLinked: boolean,
  skillsDetail: string,
): Promise<string> {
  const health = await engine.health();
  const jobs = listJobs(db).slice(0, 3);
  const anomalies = anomalousRuns(db, startedAt - 7 * 86_400_000);

  const lines = [
    `*Pepper*  ·  up ${humanDuration(Date.now() - startedAt)}`,
    `Engine: ${health.authenticated ? '✅' : '❌'} ${health.authMode}${health.detail ? ` — ${health.detail}` : ''}`,
    `Queue: ${depth} waiting`,
    `Skills: ${skillsLinked ? '✅ linked' : `❌ ${skillsDetail}`}`,
    `Workspace: \`${cfg.workspacePath}\``,
    `Main thread: ~${Math.round(Number(getMeta(db, 'main_thread_tokens') ?? 0) / 1000)}k tokens (nudge ${Math.round(cfg.threadNudgeTokens / 1000)}k / rotate ${Math.round(cfg.threadRotateTokens / 1000)}k)`,
  ];

  lines.push('', jobs.length ? '*Next jobs*' : '_No scheduled jobs._');
  for (const j of jobs) lines.push(`• ${j.name} → ${j.next_run ? new Date(j.next_run).toISOString() : 'never'}`);

  if (anomalies.length) {
    lines.push('', '*Recent problems*');
    for (const a of anomalies.slice(0, 5)) {
      lines.push(`• ${a.name} @ ${new Date(a.scheduled_for).toISOString()} — ${a.status}${a.late ? ' (late)' : ''}`);
    }
  }
  return lines.join('\n');
}

function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

main().catch((err) => {
  logger.fatal({ err: err instanceof Error ? err.message : String(err) }, 'pepperd failed to start');
  process.exit(1);
});
