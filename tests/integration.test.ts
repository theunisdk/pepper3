import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { ControlServer } from '../src/control/server.js';
import { callControl } from '../src/control/client.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { TurnQueue } from '../src/chat/queue.js';
import { FakeEngine } from '../src/engine/fake.js';
import { listJobs } from '../src/scheduler/jobs.js';
import type { PepperConfig } from '../src/config.js';

/**
 * End-to-end over the real socket and the real job store, with only the model
 * faked. This is the path the agent itself takes when it runs `pepperctl`.
 */
describe('control socket + scheduler', () => {
  let db: Database.Database;
  let server: ControlServer;
  let sock: string;
  let sent: string[];
  let cfg: PepperConfig;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-int-'));
    mkdirSync(join(dir, 'run'), { recursive: true });
    sock = join(dir, 'run', 'pepperd.sock');
    db = openDb(':memory:');
    sent = [];
    cfg = {
      ownerTelegramIds: [1],
      timezone: 'Africa/Johannesburg',
      turnTimeoutMs: 5000,
      standingContextBudget: 20_000,
      workspacePath: dir,
      codexHome: join(dir, 'codex'),
      dbPath: ':memory:',
      dailyNoteDays: 2,
      cronGraceMs: 60_000,
    threadNudgeTokens: 150_000,
    threadRotateTokens: 250_000,
    gwsConfigDir: join(dir, 'gws-home'),
      sandboxWritableRoots: [],
    };

    server = new ControlServer(sock, {
      db,
      cfg,
      send: async (t) => {
        sent.push(t);
      },
      status: async () => 'STATUS OK',
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
  });

  it('answers status', async () => {
    const res = await callControl(sock, { cmd: 'status' });
    expect(res.ok).toBe(true);
    expect(res.text).toBe('STATUS OK');
  });

  it('adds a job and reports its next run — the self-management path', async () => {
    const res = await callControl(sock, {
      cmd: 'cron.add',
      args: { name: 'checkin', schedule: '30 16 * * 1-5', kind: 'cron', prompt: 'What did you work on?' },
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain('checkin');
    expect(res.text).toContain('Next run');

    const jobs = listJobs(db);
    expect(jobs).toHaveLength(1);
    // Defaults matter: main mode is what makes the reply land on the same thread.
    expect(jobs[0]!.mode).toBe('main');
    expect(jobs[0]!.tz).toBe('Africa/Johannesburg');
  });

  it('rejects a bad cron expression instead of silently creating a job that never fires', async () => {
    const res = await callControl(sock, {
      cmd: 'cron.add',
      args: { name: 'bad', schedule: 'not a cron', kind: 'cron', prompt: 'x' },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid cron/i);
    expect(listJobs(db)).toHaveLength(0);
  });

  it('refuses a duplicate name and points at update', async () => {
    const args = { name: 'dupe', schedule: '0 9 * * *', kind: 'cron', prompt: 'x' };
    await callControl(sock, { cmd: 'cron.add', args });
    const res = await callControl(sock, { cmd: 'cron.add', args });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('update');
  });

  it('updates a job in place, keeping its identity', async () => {
    await callControl(sock, {
      cmd: 'cron.add',
      args: { name: 'checkin', schedule: '30 16 * * *', kind: 'cron', prompt: 'old' },
    });
    const res = await callControl(sock, {
      cmd: 'cron.update',
      args: { name: 'checkin', schedule: '0 17 * * *', kind: 'cron' },
    });
    expect(res.ok).toBe(true);
    const jobs = listJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.schedule).toBe('0 17 * * *');
    expect(jobs[0]!.prompt).toBe('old'); // untouched
  });

  it('pauses and resumes', async () => {
    await callControl(sock, {
      cmd: 'cron.add',
      args: { name: 'j', schedule: '0 9 * * *', kind: 'cron', prompt: 'x' },
    });
    await callControl(sock, { cmd: 'cron.pause', args: { name: 'j' } });
    expect(listJobs(db)).toHaveLength(0); // not listed when disabled
    expect(listJobs(db, true)[0]!.enabled).toBe(0);

    await callControl(sock, { cmd: 'cron.resume', args: { name: 'j' } });
    expect(listJobs(db)).toHaveLength(1);
  });

  it('sends a proactive message', async () => {
    const res = await callControl(sock, { cmd: 'send', args: { text: 'heads up' } });
    expect(res.ok).toBe(true);
    expect(sent).toEqual(['heads up']);
  });

  it('reports unknown commands rather than failing silently', async () => {
    const res = await callControl(sock, { cmd: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown command');
  });

  it('todo round-trip: add with source dedup, list, done', async () => {
    const add = await callControl(sock, {
      cmd: 'todo.add',
      args: { title: 'Reply to Alex', context: 'alpha', source: 'acct:MSG1' },
    });
    expect(add.ok).toBe(true);
    expect(add.text).toContain('T1');

    const dup = await callControl(sock, {
      cmd: 'todo.add',
      args: { title: 'same item again', source: 'acct:MSG1' },
    });
    expect(dup.ok).toBe(true);
    expect(dup.text).toContain('already covers');

    const list = await callControl(sock, { cmd: 'todo.list', args: {} });
    expect(list.ok).toBe(true);
    expect(list.text).toContain('T1 · Reply to Alex');

    const done = await callControl(sock, { cmd: 'todo.done', args: { id: 'T1' } });
    expect(done.ok).toBe(true);
    const after = await callControl(sock, { cmd: 'todo.list', args: {} });
    expect(after.text).toContain('No open todos');
  });

  it('todo errors surface cleanly over the socket', async () => {
    const bad = await callControl(sock, { cmd: 'todo.done', args: { id: 'T99' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('No todo T99');
  });
});

describe('scheduled question round-trip (acceptance scenario 1)', () => {
  it('delivers a main-mode job onto the same thread the owner replies on', async () => {
    const db = openDb(':memory:');
    const engine = new FakeEngine();
    const delivered: string[] = [];

    const queue = new TurnQueue({
      timeoutMs: 5000,
      run: async (input, signal) => (await engine.runTurn('main', input, signal)).text,
    });

    const scheduler = new Scheduler({
      db,
      graceMs: 60_000,
      now: () => Date.parse('2026-07-16T14:31:00Z'),
      runJob: async (job) => {
        const text = await queue.submit(job.prompt);
        delivered.push(text);
        return text;
      },
      notify: async (t) => {
        delivered.push(t);
      },
    });

    const { createJob } = await import('../src/scheduler/jobs.js');
    createJob(
      db,
      { name: 'checkin', schedule: '30 16 * * *', kind: 'cron', tz: 'Africa/Johannesburg', prompt: 'What did you work on?', mode: 'main' },
      new Date(Date.parse('2026-07-16T10:00:00Z')),
    );

    await scheduler.start();
    scheduler.stop();

    // The job asked its question...
    expect(engine.turns.map((t) => t.input)).toContain('What did you work on?');
    const jobThread = engine.turns[0]!.threadId;

    // ...and the owner's reply continues the SAME thread. If these differed,
    // the assistant would have no idea what the answer referred to — which is
    // exactly the bug this design exists to prevent.
    await queue.submit('3h on billing');
    expect(engine.turns).toHaveLength(2);
    expect(engine.turns[1]!.threadId).toBe(jobThread);
    expect(engine.turns[1]!.chatKey).toBe('main');
    expect(delivered.length).toBeGreaterThan(0);

    db.close();
  });
});
