import type Database from 'better-sqlite3';
import type { Job } from '../db.js';
import { logger } from '../logger.js';
import {
  claimRun,
  finishRun,
  listJobs,
  nextRunAt,
  occurrencesBetween,
  recordSkipped,
  setNextRun,
} from './jobs.js';

export interface SchedulerDeps {
  db: Database.Database;
  /** Run a job's prompt. Resolves with a short summary for the run history. */
  runJob: (job: Job, scheduledFor: number) => Promise<string>;
  /** Tell the owner something happened. */
  notify: (text: string) => Promise<void>;
  graceMs: number;
  /** Injectable for tests. */
  now?: () => number;
  tickMs?: number;
}

/**
 * The scheduler lives here, in the daemon — not in the model.
 *
 * The model can ask for a schedule to exist (via pepperctl); whether it then
 * fires is a property of this loop and the SQLite rows it reads, so a confused
 * model can't forget an appointment. Every fire is keyed on the *nominal*
 * occurrence rather than wall-clock now, which is what lets restart catch-up and
 * the live tick race without double-firing or silently skipping.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private readonly now: () => number;
  private readonly tickMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tickMs = deps.tickMs ?? 20_000;
  }

  /** Catch up on anything missed while we were down, then start ticking. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.catchUp();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Don't hold the process open on this timer alone.
    this.timer.unref?.();
    logger.info({ tickMs: this.tickMs }, 'scheduler started');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Reconcile the gap since the last known next_run for each job.
   *
   * Recurring jobs: at most one late fire (nobody wants ten stale prompts after
   * a long outage); older misses are recorded as skipped and surfaced by
   * /status. One-shots: a missed reminder is useless as a /status footnote, so
   * it gets an immediate proactive message instead.
   */
  private async catchUp(): Promise<void> {
    const now = this.now();
    for (const job of listJobs(this.deps.db, true)) {
      if (!job.enabled || job.next_run === null) continue;
      if (job.next_run > now) continue;

      const missed = occurrencesBetween(job, job.next_run - 1, now);
      if (missed.length === 0) continue;

      const newest = missed[missed.length - 1]!;
      const withinGrace = now - newest <= this.deps.graceMs;

      for (const occ of missed) {
        if (occ === newest && withinGrace) continue; // fire it below
        const isOneShot = job.kind === 'at';
        recordSkipped(this.deps.db, job.id, occ, `missed while pepperd was down (${new Date(occ).toISOString()})`);
        logger.warn({ job: job.name, occurrence: new Date(occ).toISOString() }, 'occurrence skipped');
        if (isOneShot) {
          await this.deps.notify(
            `⚠️ Missed your one-off "${job.name}" scheduled for ${new Date(occ).toISOString()} — ` +
              `I was offline. It said:\n\n${job.prompt}`,
          );
        }
      }

      if (withinGrace) {
        await this.fire(job, newest, true);
      }
      setNextRun(this.deps.db, job.id, nextRunAt(job, new Date(now)));
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    for (const job of listJobs(this.deps.db)) {
      if (job.next_run === null || job.next_run > now) continue;
      await this.fire(job, job.next_run, false);
      setNextRun(this.deps.db, job.id, nextRunAt(job, new Date(now)));
    }
  }

  private async fire(job: Job, scheduledFor: number, late: boolean): Promise<void> {
    // Claim first, run second. If another path already claimed this occurrence
    // the insert fails and we simply don't run it.
    const runId = claimRun(this.deps.db, job.id, scheduledFor, late, this.now());
    if (runId === null) {
      logger.debug({ job: job.name, scheduledFor }, 'occurrence already claimed, skipping');
      return;
    }

    logger.info({ job: job.name, scheduledFor: new Date(scheduledFor).toISOString(), late }, 'firing job');

    // One retry, then tell the owner. Never fail silently.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const summary = await this.deps.runJob(job, scheduledFor);
        finishRun(this.deps.db, runId, 'ok', summary.slice(0, 500));
        return;
      } catch (err) {
        const isTimeout = (err as Error)?.name === 'AbortError';
        const msg = (err as Error)?.message ?? String(err);
        if (attempt === 1) {
          logger.warn({ job: job.name, err: msg }, 'job failed, retrying once');
          continue;
        }
        finishRun(this.deps.db, runId, isTimeout ? 'timeout' : 'error', msg.slice(0, 500));
        logger.error({ job: job.name, err: msg }, 'job failed after retry');
        await this.deps.notify(`❌ Job "${job.name}" failed: ${firstLine(msg)}`);
      }
    }
  }
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? s).slice(0, 300);
}
