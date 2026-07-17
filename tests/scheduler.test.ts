import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { claimRun, createJob, nextRunAt, occurrencesBetween, updateJob } from '../src/scheduler/jobs.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { Job } from '../src/db.js';

function db(): Database.Database {
  return openDb(':memory:');
}

const TZ = 'Africa/Johannesburg';

describe('occurrence claiming', () => {
  it('lets exactly one caller claim an occurrence', () => {
    const d = db();
    const job = createJob(d, { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: TZ, prompt: 'p', mode: 'main' });

    const first = claimRun(d, job.id, 1_000_000, false);
    const second = claimRun(d, job.id, 1_000_000, true);

    expect(first).not.toBeNull();
    // This is the guarantee that lets the restart catch-up and the live ticker
    // race without double-firing.
    expect(second).toBeNull();
  });

  it('treats different occurrences of the same job as distinct', () => {
    const d = db();
    const job = createJob(d, { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: TZ, prompt: 'p', mode: 'main' });
    expect(claimRun(d, job.id, 1_000_000, false)).not.toBeNull();
    expect(claimRun(d, job.id, 2_000_000, false)).not.toBeNull();
  });
});

describe('next run calculation', () => {
  it('honours the job timezone rather than the server clock', () => {
    // 09:00 in Johannesburg is 07:00 UTC.
    const next = nextRunAt(
      { schedule: '0 9 * * *', kind: 'cron', tz: TZ },
      new Date('2026-07-16T00:00:00Z'),
    );
    expect(new Date(next!).toISOString()).toBe('2026-07-16T07:00:00.000Z');
  });

  it('returns null for a one-shot already in the past', () => {
    const next = nextRunAt(
      { schedule: '2020-01-01T00:00:00Z', kind: 'at', tz: TZ },
      new Date('2026-07-16T00:00:00Z'),
    );
    expect(next).toBeNull();
  });
});

describe('occurrencesBetween', () => {
  it('enumerates every missed occurrence in a window', () => {
    const job = { schedule: '0 * * * *', kind: 'cron', tz: 'UTC' } as Job;
    const from = Date.parse('2026-07-16T00:00:00Z');
    const to = Date.parse('2026-07-16T05:30:00Z');
    // 01:00 through 05:00
    expect(occurrencesBetween(job, from, to)).toHaveLength(5);
  });
});

describe('Scheduler', () => {
  let d: Database.Database;
  let fired: { job: string; scheduledFor: number }[];
  let notices: string[];

  beforeEach(() => {
    d = db();
    fired = [];
    notices = [];
  });

  function make(now: number, graceMs = 30 * 60_000) {
    return new Scheduler({
      db: d,
      graceMs,
      now: () => now,
      runJob: async (job, scheduledFor) => {
        fired.push({ job: job.name, scheduledFor });
        return 'ok';
      },
      notify: async (t) => {
        notices.push(t);
      },
    });
  }

  it('fires a due job exactly once even across repeated ticks', async () => {
    const now = Date.parse('2026-07-16T09:05:00Z');
    const job = createJob(
      d,
      { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: 'UTC', prompt: 'p', mode: 'main' },
      new Date(Date.parse('2026-07-16T08:00:00Z')),
    );
    expect(job.next_run).toBe(Date.parse('2026-07-16T09:00:00Z'));

    const s = make(now);
    await s.start();
    s.stop();
    await s.start(); // a second start (i.e. a restart) must not re-fire
    s.stop();

    expect(fired).toHaveLength(1);
  });

  it('fires a recently-missed occurrence late, within the grace window', async () => {
    const scheduled = Date.parse('2026-07-16T09:00:00Z');
    const now = scheduled + 10 * 60_000; // 10 min later, inside 30 min grace
    createJob(
      d,
      { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: 'UTC', prompt: 'p', mode: 'main' },
      new Date(scheduled - 3600_000),
    );

    const s = make(now);
    await s.start();
    s.stop();

    expect(fired).toEqual([{ job: 'j', scheduledFor: scheduled }]);
    const run = d.prepare('SELECT late FROM runs WHERE scheduled_for = ?').get(scheduled) as { late: number };
    expect(run.late).toBe(1);
  });

  it('records an old miss as skipped instead of firing it', async () => {
    const scheduled = Date.parse('2026-07-16T09:00:00Z');
    const now = scheduled + 5 * 3600_000; // 5h later, well past grace
    createJob(
      d,
      { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: 'UTC', prompt: 'p', mode: 'main' },
      new Date(scheduled - 3600_000),
    );

    const s = make(now);
    await s.start();
    s.stop();

    expect(fired).toHaveLength(0);
    const run = d.prepare('SELECT status FROM runs WHERE scheduled_for = ?').get(scheduled) as { status: string };
    // Visible, not silent — this is the whole point.
    expect(run.status).toBe('skipped');
  });

  it('proactively warns when a one-shot was missed while offline', async () => {
    const at = '2026-07-16T09:00:00Z';
    const now = Date.parse(at) + 5 * 3600_000;
    createJob(
      d,
      { name: 'call-mum', schedule: at, kind: 'at', tz: 'UTC', prompt: 'Remind me to call Mum.', mode: 'main' },
      new Date(Date.parse(at) - 3600_000),
    );

    const s = make(now);
    await s.start();
    s.stop();

    // A missed one-off reminder is useless as a /status footnote.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('call-mum');
    expect(notices[0]).toContain('Remind me to call Mum.');
  });

  it('retries once, then reports the failure to the owner', async () => {
    const now = Date.parse('2026-07-16T09:05:00Z');
    createJob(
      d,
      { name: 'flaky', schedule: '0 9 * * *', kind: 'cron', tz: 'UTC', prompt: 'p', mode: 'main' },
      new Date(Date.parse('2026-07-16T08:00:00Z')),
    );

    let attempts = 0;
    const s = new Scheduler({
      db: d,
      graceMs: 30 * 60_000,
      now: () => now,
      runJob: async () => {
        attempts++;
        throw new Error('boom');
      },
      notify: async (t) => {
        notices.push(t);
      },
    });
    await s.start();
    s.stop();

    expect(attempts).toBe(2);
    expect(notices[0]).toContain('flaky');
    expect(notices[0]).toContain('boom');
    const run = d.prepare('SELECT status FROM runs LIMIT 1').get() as { status: string };
    expect(run.status).toBe('error');
  });
});

describe('updateJob', () => {
  it('reschedules atomically and keeps history', () => {
    const d = db();
    const job = createJob(d, { name: 'j', schedule: '0 9 * * *', kind: 'cron', tz: 'UTC', prompt: 'p', mode: 'main' });
    claimRun(d, job.id, 1_000_000, false);

    const updated = updateJob(d, 'j', { schedule: '0 17 * * *' }, new Date('2026-07-16T00:00:00Z'));

    expect(updated.id).toBe(job.id);
    expect(new Date(updated.next_run!).toISOString()).toBe('2026-07-16T17:00:00.000Z');
    const runs = d.prepare('SELECT COUNT(*) c FROM runs WHERE job_id = ?').get(job.id) as { c: number };
    expect(runs.c).toBe(1); // rm+add would have lost this
  });
});
