import { Cron } from 'croner';
import type Database from 'better-sqlite3';
import type { Job, JobMode, Run, RunStatus } from '../db.js';

export interface NewJob {
  name: string;
  schedule: string;
  kind: 'cron' | 'at';
  tz: string;
  prompt: string;
  mode: JobMode;
}

export class JobError extends Error {
  override readonly name = 'JobError';
}

/** Next occurrence strictly after `after`, or null for a spent one-shot. */
export function nextRunAt(job: Pick<Job, 'schedule' | 'kind' | 'tz'>, after: Date = new Date()): number | null {
  if (job.kind === 'at') {
    const t = Date.parse(job.schedule);
    if (Number.isNaN(t)) throw new JobError(`"${job.schedule}" is not a valid ISO timestamp.`);
    return t > after.getTime() ? t : null;
  }
  const next = new Cron(job.schedule, { timezone: job.tz }).nextRun(after);
  return next ? next.getTime() : null;
}

export function validateSchedule(schedule: string, kind: 'cron' | 'at', tz: string): void {
  if (kind === 'at') {
    if (Number.isNaN(Date.parse(schedule))) {
      throw new JobError(`--at needs an ISO timestamp like 2026-07-20T15:00:00+02:00; got "${schedule}".`);
    }
    return;
  }
  try {
    const c = new Cron(schedule, { timezone: tz });
    if (!c.nextRun()) throw new JobError(`Cron "${schedule}" has no future occurrences.`);
  } catch (e) {
    if (e instanceof JobError) throw e;
    throw new JobError(`Invalid cron expression "${schedule}": ${(e as Error).message}`);
  }
}

export function createJob(db: Database.Database, j: NewJob, now: Date = new Date()): Job {
  validateSchedule(j.schedule, j.kind, j.tz);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(j.name)) {
    throw new JobError(`Job name "${j.name}" must be 1-64 chars of letters, digits, or hyphens.`);
  }
  if (getJobByName(db, j.name)) throw new JobError(`A job named "${j.name}" already exists. Use \`cron update\`.`);

  const next = nextRunAt(j, now);
  const info = db
    .prepare(
      `INSERT INTO jobs (name, schedule, kind, tz, prompt, mode, enabled, next_run, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(j.name, j.schedule, j.kind, j.tz, j.prompt, j.mode, next, now.getTime());
  return getJobById(db, Number(info.lastInsertRowid))!;
}

/**
 * Atomic edit. The alternative — delete and re-add — loses run history and can
 * half-fail, silently leaving no job where the owner thinks one exists.
 */
export function updateJob(
  db: Database.Database,
  name: string,
  patch: Partial<Pick<Job, 'schedule' | 'kind' | 'tz' | 'prompt' | 'mode' | 'enabled'>>,
  now: Date = new Date(),
): Job {
  const job = getJobByName(db, name);
  if (!job) throw new JobError(`No job named "${name}".`);

  const merged = { ...job, ...patch };
  if (patch.schedule !== undefined || patch.kind !== undefined || patch.tz !== undefined) {
    validateSchedule(merged.schedule, merged.kind, merged.tz);
  }
  const next = merged.enabled ? nextRunAt(merged, now) : null;

  db.prepare(
    `UPDATE jobs SET schedule = ?, kind = ?, tz = ?, prompt = ?, mode = ?, enabled = ?, next_run = ?
     WHERE id = ?`,
  ).run(merged.schedule, merged.kind, merged.tz, merged.prompt, merged.mode, merged.enabled, next, job.id);
  return getJobById(db, job.id)!;
}

export function deleteJob(db: Database.Database, name: string): void {
  const info = db.prepare('DELETE FROM jobs WHERE name = ?').run(name);
  if (info.changes === 0) throw new JobError(`No job named "${name}".`);
}

export function setEnabled(db: Database.Database, name: string, enabled: boolean, now = new Date()): Job {
  return updateJob(db, name, { enabled: enabled ? 1 : 0 }, now);
}

export function getJobByName(db: Database.Database, name: string): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as Job | undefined;
}

export function getJobById(db: Database.Database, id: number): Job | undefined {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

export function listJobs(db: Database.Database, includeDisabled = false): Job[] {
  const sql = includeDisabled
    ? 'SELECT * FROM jobs ORDER BY next_run IS NULL, next_run ASC'
    : 'SELECT * FROM jobs WHERE enabled = 1 ORDER BY next_run IS NULL, next_run ASC';
  return db.prepare(sql).all() as Job[];
}

export function setNextRun(db: Database.Database, jobId: number, next: number | null): void {
  db.prepare('UPDATE jobs SET next_run = ? WHERE id = ?').run(next, jobId);
}

// --- runs --------------------------------------------------------------------

/**
 * Claim an occurrence, or return null if it is already claimed.
 *
 * This is the whole anti-double-fire mechanism: the UNIQUE(job_id,
 * scheduled_for) index means the live ticker and restart catch-up race safely —
 * exactly one INSERT wins and the loser simply doesn't run. Keying on the
 * *nominal* occurrence rather than wall-clock time is what makes it work.
 */
export function claimRun(
  db: Database.Database,
  jobId: number,
  scheduledFor: number,
  late: boolean,
  now: number = Date.now(),
): number | null {
  try {
    const info = db
      .prepare(
        `INSERT INTO runs (job_id, scheduled_for, started_at, status, late)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(jobId, scheduledFor, now, late ? 1 : 0);
    return Number(info.lastInsertRowid);
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw e;
  }
}

/** Record a missed occurrence without running it. */
export function recordSkipped(db: Database.Database, jobId: number, scheduledFor: number, summary: string): boolean {
  try {
    db.prepare(
      `INSERT INTO runs (job_id, scheduled_for, started_at, finished_at, status, late, summary)
       VALUES (?, ?, ?, ?, 'skipped', 0, ?)`,
    ).run(jobId, scheduledFor, Date.now(), Date.now(), summary);
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
    throw e;
  }
}

export function finishRun(db: Database.Database, runId: number, status: RunStatus, summary?: string): void {
  db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary = ? WHERE id = ?').run(
    status,
    Date.now(),
    summary ?? null,
    runId,
  );
}

export function hasRunFor(db: Database.Database, jobId: number, scheduledFor: number): boolean {
  return !!db.prepare('SELECT 1 FROM runs WHERE job_id = ? AND scheduled_for = ?').get(jobId, scheduledFor);
}

export function recentRuns(db: Database.Database, jobId: number, limit = 10): Run[] {
  return db
    .prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY scheduled_for DESC LIMIT ?')
    .all(jobId, limit) as Run[];
}

/** Runs that were late or skipped since a given time — surfaced by /status. */
export function anomalousRuns(db: Database.Database, since: number): (Run & { name: string })[] {
  return db
    .prepare(
      `SELECT runs.*, jobs.name FROM runs JOIN jobs ON jobs.id = runs.job_id
       WHERE runs.scheduled_for >= ? AND (runs.late = 1 OR runs.status IN ('skipped','error','timeout'))
       ORDER BY runs.scheduled_for DESC LIMIT 20`,
    )
    .all(since) as (Run & { name: string })[];
}

/** Occurrences between `from` (exclusive) and `to` (inclusive), oldest first. */
export function occurrencesBetween(job: Job, from: number, to: number, cap = 50): number[] {
  const out: number[] = [];
  if (job.kind === 'at') {
    const t = Date.parse(job.schedule);
    if (!Number.isNaN(t) && t > from && t <= to) out.push(t);
    return out;
  }
  const cron = new Cron(job.schedule, { timezone: job.tz });
  let cursor = new Date(from);
  for (let i = 0; i < cap; i++) {
    const next = cron.nextRun(cursor);
    if (!next || next.getTime() > to) break;
    out.push(next.getTime());
    cursor = next;
  }
  return out;
}
