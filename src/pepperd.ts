#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadConfig, requireBotToken, socketPath, type PepperConfig } from './config.js';
import { getMeta, openDb, setMeta, clearThread } from './db.js';
import { logger } from './logger.js';
import { initWorkspace } from './workspace.js';
import { firstTurnInput, withDateHeader } from './context.js';
import { TelegramGateway } from './chat/gateway.js';
import { TurnQueue } from './chat/queue.js';
import { ControlServer } from './control/server.js';
import { Scheduler } from './scheduler/scheduler.js';
import { anomalousRuns, listJobs } from './scheduler/jobs.js';
import { CodexEngine } from './engine/codex/adapter.js';
import { ContextExhaustedError, EngineAuthError, type Engine } from './engine/types.js';
import type { Job } from './db.js';

const MAIN_CHAT_KEY = 'main';
const META_MAIN_CHAT_ID = 'main_chat_id';

async function main(): Promise<void> {
  const configPath = resolve(process.argv[2] ?? process.env.PEPPER_CONFIG ?? 'pepper.config.json');
  const cfg = loadConfig(configPath);
  const token = requireBotToken();

  const ws = initWorkspace(cfg);
  if (!ws.skillsLinked) logger.warn({ detail: ws.skillsDetail }, 'skills are NOT linked — authored skills will be ignored');

  const db = openDb(cfg.dbPath);
  const engine: Engine = new CodexEngine({
    db,
    workspacePath: cfg.workspacePath,
    codexHome: cfg.codexHome,
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

  async function runOnMain(prompt: string, signal: AbortSignal): Promise<string> {
    const input = isNewThread(MAIN_CHAT_KEY)
      ? firstTurnInput(cfg, prompt)
      : withDateHeader(prompt, cfg.timezone);
    try {
      const res = await engine.runTurn(MAIN_CHAT_KEY, input, signal);
      return res.text;
    } catch (err) {
      if (err instanceof ContextExhaustedError) {
        // The thread outgrew its window. Start a fresh one with standing
        // context and tell the owner, rather than failing opaquely.
        logger.warn('context exhausted — resetting thread');
        await engine.resetThread(MAIN_CHAT_KEY);
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
    run: async (input, signal) => (await engine.runIsolated(firstTurnInput(cfg, input), signal)).text,
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
          await engine.resetThread(MAIN_CHAT_KEY);
          return 'Started a fresh thread. My memory and notes are reloaded from disk.';
        case 'cancel':
          return queue.cancel() ? 'Stopped it.' : 'Nothing was running.';
        case 'jobs':
          return renderJobs(db);
        case 'status':
          return await renderStatus(cfg, db, engine, startedAt, queue.depth, ws.skillsLinked, ws.skillsDetail);
        default:
          return `Unknown command: ${cmd}`;
      }
    },
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
