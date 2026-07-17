import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from './logger.js';
import type { PepperConfig } from './config.js';

/**
 * Standing context is the whole answer to "it went dumb after a reset".
 *
 * Durable knowledge lives on disk, not in the model's context window, and is
 * re-injected whenever a thread starts. A reset therefore costs recent
 * conversational nuance and nothing else — MEMORY.md comes straight back.
 */

export interface StandingContext {
  text: string;
  truncated: boolean;
  files: string[];
}

/** YYYY-MM-DD for a given instant in the owner's timezone (not the server's). */
export function localDateStamp(tz: string, at: Date = new Date()): string {
  // en-CA renders ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * A one-line header on EVERY turn, not just the first.
 *
 * The main thread can live for weeks, so a date captured at thread start goes
 * stale and any date-sensitive skill ("append to today's note") would quietly
 * write to the wrong day.
 */
export function dateHeader(tz: string, at: Date = new Date()): string {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  return `[Now: ${stamp} (${tz})]`;
}

export function withDateHeader(input: string, tz: string, at: Date = new Date()): string {
  return `${dateHeader(tz, at)}\n\n${input}`;
}

function readIfPresent(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch (e) {
    logger.warn({ path, err: (e as Error).message }, 'could not read context file');
    return undefined;
  }
}

/** Note filenames for today and the previous `days - 1` days, newest first. */
export function dailyNotePaths(cfg: PepperConfig, at: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < Math.max(0, cfg.dailyNoteDays); i++) {
    const d = new Date(at.getTime() - i * 86_400_000);
    out.push(join(cfg.workspacePath, 'notes', `${localDateStamp(cfg.timezone, d)}.md`));
  }
  return out;
}

/**
 * Assemble the block prefixed to the first turn of a new thread.
 *
 * Budget rule: MEMORY.md is never truncated — it is the durable layer and
 * dropping it would recreate the amnesia this exists to prevent. Under
 * pressure we drop the oldest daily note first, then trim today's note from
 * the *top*, so the most recent working state always survives.
 */
export function buildStandingContext(cfg: PepperConfig, at: Date = new Date()): StandingContext {
  const files: string[] = [];

  const memoryPath = join(cfg.workspacePath, 'MEMORY.md');
  const memory = readIfPresent(memoryPath);
  if (memory?.trim()) files.push(memoryPath);

  const notes: { path: string; body: string }[] = [];
  for (const p of dailyNotePaths(cfg, at)) {
    const body = readIfPresent(p);
    if (body?.trim()) notes.push({ path: p, body });
  }

  // A brand-new workspace has nothing to say. Emitting the header over an empty
  // body would tell the model "here is the durable truth about your owner" and
  // then show it nothing — noise at best, misleading at worst.
  if (!memory?.trim() && notes.length === 0) {
    return { text: '', truncated: false, files: [] };
  }

  const header =
    'The following is your standing context, loaded from disk at the start of this thread. ' +
    'It is the durable truth about your owner and your recent work. Treat it as authoritative.';

  const memBlock = memory?.trim() ? `\n\n## MEMORY.md (durable — never invent changes to this)\n\n${memory.trim()}` : '';

  let budgetLeft = cfg.standingContextBudget - header.length - memBlock.length;
  let truncated = false;
  const noteBlocks: string[] = [];

  // Newest first, so the freshest note wins the remaining budget.
  for (const note of notes) {
    const title = `\n\n## ${note.path.split('/').pop()}\n\n`;
    const cost = title.length + note.body.length;
    if (cost <= budgetLeft) {
      noteBlocks.push(title + note.body.trim());
      files.push(note.path);
      budgetLeft -= cost;
      continue;
    }
    // Not enough room. Keep the tail (most recent lines) of this note if a
    // useful amount fits; otherwise drop it and everything older.
    const room = budgetLeft - title.length;
    if (room > 500) {
      const kept = note.body.slice(-room);
      noteBlocks.push(`${title}[…older lines trimmed…]\n${kept.trim()}`);
      files.push(note.path);
      truncated = true;
    } else {
      truncated = true;
    }
    break;
  }

  if (truncated) {
    logger.warn(
      { budget: cfg.standingContextBudget },
      'standing context exceeded its budget — daily notes were trimmed (MEMORY.md was not)',
    );
  }

  const text = `${header}${memBlock}${noteBlocks.join('')}`.trim();
  return { text, truncated, files };
}

/** The full first-turn input for a new thread: date header + standing context + the prompt. */
export function firstTurnInput(cfg: PepperConfig, prompt: string, at: Date = new Date()): string {
  const ctx = buildStandingContext(cfg, at);
  const body = ctx.text ? `${ctx.text}\n\n---\n\n${prompt}` : prompt;
  return withDateHeader(body, cfg.timezone, at);
}
