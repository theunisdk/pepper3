import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';
import { logger } from '../logger.js';
import type { PepperConfig } from '../config.js';
import {
  createJob,
  deleteJob,
  getJobByName,
  JobError,
  listJobs,
  recentRuns,
  setEnabled,
  updateJob,
} from '../scheduler/jobs.js';
import { commitWorkspace } from '../workspace.js';
import type { ControlRequest, ControlResponse } from './protocol.js';
import type { JobMode } from '../db.js';

export interface ControlDeps {
  db: Database.Database;
  cfg: PepperConfig;
  /** Proactively message the owner. */
  send: (text: string) => Promise<void>;
  /** Text for `status`. */
  status: () => Promise<string>;
}

/**
 * A tiny unix-socket API, and the only way the model changes daemon state.
 *
 * It lives inside the workspace (not /run) for a specific reason: the agent's
 * shell runs in Codex's workspace-write sandbox, and a socket outside that
 * sandbox may not be connectable. Inside the workspace it is reachable by
 * construction. Mode 0600 plus a single-owner box is the access control.
 */
export class ControlServer {
  private server: Server | null = null;

  constructor(private readonly path: string, private readonly deps: ControlDeps) {}

  async start(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    // A leftover socket file from an unclean shutdown would block bind().
    if (existsSync(this.path)) rmSync(this.path);

    this.server = createServer((sock) => this.onConnection(sock));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.path, () => {
        this.server!.removeListener('error', reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    logger.info({ socket: this.path }, 'control socket listening');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((res) => this.server!.close(() => res()));
    if (existsSync(this.path)) rmSync(this.path);
    this.server = null;
  }

  private onConnection(sock: Socket): void {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        void this.dispatch(line)
          .then((res) => sock.write(JSON.stringify(res) + '\n'))
          .catch((e) => sock.write(JSON.stringify({ ok: false, error: String(e) }) + '\n'))
          .finally(() => sock.end());
      }
    });
    sock.on('error', (e) => logger.debug({ err: e.message }, 'control socket client error'));
  }

  private async dispatch(line: string): Promise<ControlResponse> {
    let req: ControlRequest;
    try {
      req = JSON.parse(line) as ControlRequest;
    } catch {
      return { ok: false, error: 'malformed request' };
    }

    const a = req.args ?? {};
    try {
      switch (req.cmd) {
        case 'status':
          return { ok: true, text: await this.deps.status() };

        case 'send': {
          const text = str(a.text, 'text');
          await this.deps.send(text);
          return { ok: true, text: 'sent' };
        }

        case 'cron.add': {
          const job = createJob(this.deps.db, {
            name: str(a.name, 'name'),
            schedule: str(a.schedule, 'schedule'),
            kind: a.kind === 'at' ? 'at' : 'cron',
            tz: typeof a.tz === 'string' && a.tz ? a.tz : this.deps.cfg.timezone,
            prompt: str(a.prompt, 'prompt'),
            mode: (a.mode === 'isolated' ? 'isolated' : 'main') as JobMode,
          });
          return {
            ok: true,
            text: `Added job "${job.name}" (${job.kind === 'at' ? 'once' : job.schedule}, ${job.tz}, ${job.mode}). Next run: ${fmt(job.next_run)}`,
            data: job,
          };
        }

        case 'cron.list': {
          const jobs = listJobs(this.deps.db, a.all === true);
          if (jobs.length === 0) return { ok: true, text: 'No scheduled jobs.', data: [] };
          const lines = jobs.map(
            (j) =>
              `${j.enabled ? '•' : '✗'} ${j.name} — ${j.kind === 'at' ? `once at ${j.schedule}` : j.schedule} (${j.tz}, ${j.mode}) → next ${fmt(j.next_run)}`,
          );
          return { ok: true, text: lines.join('\n'), data: jobs };
        }

        case 'cron.update': {
          const name = str(a.name, 'name');
          const patch: Parameters<typeof updateJob>[2] = {};
          if (typeof a.schedule === 'string') {
            patch.schedule = a.schedule;
            patch.kind = a.kind === 'at' ? 'at' : 'cron';
          }
          if (typeof a.tz === 'string') patch.tz = a.tz;
          if (typeof a.prompt === 'string') patch.prompt = a.prompt;
          if (a.mode === 'main' || a.mode === 'isolated') patch.mode = a.mode;
          if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
          const job = updateJob(this.deps.db, name, patch);
          return { ok: true, text: `Updated "${job.name}". Next run: ${fmt(job.next_run)}`, data: job };
        }

        case 'cron.rm':
          deleteJob(this.deps.db, str(a.name, 'name'));
          return { ok: true, text: `Removed "${String(a.name)}".` };

        case 'cron.pause': {
          const job = setEnabled(this.deps.db, str(a.name, 'name'), false);
          return { ok: true, text: `Paused "${job.name}".`, data: job };
        }

        case 'cron.resume': {
          const job = setEnabled(this.deps.db, str(a.name, 'name'), true);
          return { ok: true, text: `Resumed "${job.name}". Next run: ${fmt(job.next_run)}`, data: job };
        }

        case 'runs': {
          const name = str(a.name, 'name');
          const job = getJobByName(this.deps.db, name);
          if (!job) return { ok: false, error: `No job named "${name}".` };
          const runs = recentRuns(this.deps.db, job.id, typeof a.limit === 'number' ? a.limit : 10);
          if (runs.length === 0) return { ok: true, text: `"${name}" has not run yet.`, data: [] };
          const lines = runs.map(
            (r) =>
              `${fmt(r.scheduled_for)} — ${r.status}${r.late ? ' (late)' : ''}${r.summary ? `: ${r.summary.slice(0, 120)}` : ''}`,
          );
          return { ok: true, text: lines.join('\n'), data: runs };
        }

        case 'workspace.commit': {
          const message = str(a.message, 'message');
          const r = commitWorkspace(this.deps.cfg.workspacePath, message);
          return { ok: true, text: r.detail, data: r };
        }

        default:
          return { ok: false, error: `unknown command "${req.cmd}"` };
      }
    } catch (e) {
      if (e instanceof JobError) return { ok: false, error: e.message };
      logger.error({ err: e, cmd: req.cmd }, 'control command failed');
      return { ok: false, error: (e as Error).message };
    }
  }
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new JobError(`"${field}" is required.`);
  return v;
}

function fmt(t: number | null): string {
  return t === null ? 'never' : new Date(t).toISOString();
}
