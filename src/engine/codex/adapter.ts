import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import type Database from 'better-sqlite3';
import { clearThread, getThreadId, setThreadId } from '../../db.js';
import { logger } from '../../logger.js';
import {
  ContextExhaustedError,
  EngineAuthError,
  ThreadResumeError,
  type Engine,
  type EngineHealth,
  type EngineResult,
} from '../types.js';
import { checkAuth, isAuthError } from './auth.js';
import { agentEnv } from './env.js';

export interface CodexEngineOptions {
  db: Database.Database;
  workspacePath: string;
  codexHome: string;
  model?: string;
  /** Absolute path of pepper.config.json — exported to agent shells for pepperctl. */
  configPath?: string;
  /** Extra writable roots inside the sandbox (e.g. the gws token directory). */
  additionalDirectories?: string[];
}

const CONTEXT_PATTERNS = [/context.{0,20}(window|length|limit).{0,20}exceed/i, /context_window_exceeded/i, /too many tokens/i];
const TRANSIENT_PATTERNS = [/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i, /\b(429|500|502|503|504)\b/, /timed? ?out/i];

/** The sandbox/approval posture for every thread. Pure so tests can see it. */
export function buildThreadOptions(
  opts: Pick<CodexEngineOptions, 'workspacePath' | 'model' | 'additionalDirectories'>,
): ThreadOptions {
  const threadOptions: ThreadOptions = {
    workingDirectory: opts.workspacePath,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write',
    // Unattended by definition: there is no human at a prompt to approve a
    // tool call at 03:00. The box is single-owner and the workspace (plus any
    // configured writable roots) is the blast radius.
    approvalPolicy: 'never',
    networkAccessEnabled: true,
  };
  if (opts.model) threadOptions.model = opts.model;
  if (opts.additionalDirectories?.length) threadOptions.additionalDirectories = opts.additionalDirectories;
  return threadOptions;
}

/**
 * Wraps the Codex SDK. Everything Codex-specific lives behind the Engine
 * interface: thread bookkeeping, sandbox posture, and — critically — the rule
 * that only `finalResponse` escapes. Intermediate items (command executions,
 * reasoning, file changes) are logged and dropped, which is what makes "no
 * debug output in chat" a property of the code rather than of the prompt.
 */
export class CodexEngine implements Engine {
  private readonly codex: Codex;
  private readonly db: Database.Database;
  private readonly threadOptions: ThreadOptions;
  private readonly codexHome: string;

  constructor(opts: CodexEngineOptions) {
    this.db = opts.db;
    this.codexHome = opts.codexHome;

    const { env, stripped } = agentEnv(opts.codexHome, opts.workspacePath, opts.configPath);
    if (stripped.length > 0) {
      logger.warn(
        { stripped },
        'Removed API-key environment variables before starting Codex. Pepper runs on your ChatGPT ' +
          'subscription; these would have switched it to per-token API billing.',
      );
    }

    this.codex = new Codex({
      // No apiKey: with the billing vars stripped, the SDK falls back to the
      // cached "Sign in with ChatGPT" credentials in CODEX_HOME. That is the point.
      env: env as Record<string, string>,
    });

    this.threadOptions = buildThreadOptions(opts);
  }

  async health(): Promise<EngineHealth> {
    return checkAuth(this.codexHome);
  }

  async resetThread(chatKey: string): Promise<void> {
    clearThread(this.db, chatKey);
    logger.info({ chatKey }, 'thread reset');
  }

  async runTurn(chatKey: string, input: string, signal?: AbortSignal): Promise<EngineResult> {
    const existing = getThreadId(this.db, chatKey);

    if (existing) {
      try {
        return await this.execute(this.codex.resumeThread(existing, this.threadOptions), input, chatKey, signal);
      } catch (err) {
        if (err instanceof ThreadResumeError && !err.transient) {
          // The thread is unrecoverable. Drop it and start clean; the caller
          // re-injects standing context, so durable knowledge survives.
          logger.warn({ chatKey, err: err.message }, 'thread unrecoverable, starting a new one');
          clearThread(this.db, chatKey);
          return await this.execute(this.codex.startThread(this.threadOptions), input, chatKey, signal);
        }
        throw err;
      }
    }

    return await this.execute(this.codex.startThread(this.threadOptions), input, chatKey, signal);
  }

  async runIsolated(input: string, signal?: AbortSignal): Promise<EngineResult> {
    // No chatKey: the thread is deliberately not persisted, so a daily report
    // can't bloat the main conversation's context.
    return await this.execute(this.codex.startThread(this.threadOptions), input, undefined, signal);
  }

  private async execute(
    thread: Thread,
    input: string,
    chatKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<EngineResult> {
    let turn;
    try {
      turn = await thread.run(input, signal ? { signal } : {});
    } catch (err) {
      throw this.classify(err);
    }

    const threadId = thread.id;
    if (!threadId) throw new Error('Codex returned no thread id for a completed turn.');
    if (chatKey) setThreadId(this.db, chatKey, threadId);

    // Everything that is not the final answer is logged here and goes no further.
    for (const item of turn.items ?? []) {
      if (item.type === 'agent_message') continue;
      logger.debug({ threadId, item }, 'codex item');
      if (item.type === 'error') logger.warn({ threadId, message: item.message }, 'codex reported a non-fatal error');
    }
    logger.info(
      { threadId, chatKey, items: turn.items?.length ?? 0, usage: turn.usage },
      'turn complete',
    );

    return { text: turn.finalResponse ?? '', threadId };
  }

  /** Map SDK errors onto the Engine's vocabulary so callers can react. */
  private classify(err: unknown): Error {
    if (err instanceof Error && err.name === 'AbortError') return err;

    const msg = err instanceof Error ? err.message : String(err);

    if (isAuthError(err)) return new EngineAuthError(msg);
    if (CONTEXT_PATTERNS.some((re) => re.test(msg))) return new ContextExhaustedError(msg);

    // "Thread not found" style failures mean the session is gone for good;
    // network wobbles mean try again with the same thread.
    if (/thread.{0,20}(not found|missing|invalid)|no such (session|thread)|corrupt/i.test(msg)) {
      return new ThreadResumeError(msg, false);
    }
    if (TRANSIENT_PATTERNS.some((re) => re.test(msg))) return new ThreadResumeError(msg, true);

    return err instanceof Error ? err : new Error(msg);
  }
}
