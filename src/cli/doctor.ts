import { accessSync, constants, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { callControl } from '../control/client.js';
import { checkAuth } from '../engine/codex/auth.js';
import { socketPath, type PepperConfig } from '../config.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';
export interface Check {
  label: string;
  level: CheckLevel;
  detail: string;
}

export function checkNode(version: string = process.version): Check {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return major >= 22
    ? { label: 'node', level: 'ok', detail: version }
    : { label: 'node', level: 'fail', detail: `${version} — Pepper needs Node >= 22` };
}

export function checkCodexAuth(codexHome: string): Check {
  const h = checkAuth(codexHome);
  return h.authenticated
    ? { label: 'codex auth', level: 'ok', detail: h.detail ?? 'authenticated' }
    : { label: 'codex auth', level: 'fail', detail: h.detail ?? 'not authenticated' };
}

export function checkSkillsLink(cfg: Pick<PepperConfig, 'codexHome' | 'workspacePath'>): Check {
  const link = join(cfg.codexHome, 'skills');
  const target = join(cfg.workspacePath, 'skills');
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const actual = readlinkSync(link);
      return actual === target
        ? { label: 'skills link', level: 'ok', detail: `${link} -> ${target}` }
        : { label: 'skills link', level: 'fail', detail: `${link} -> ${actual}, expected ${target}` };
    }
    return {
      label: 'skills link',
      level: 'fail',
      detail: `${link} is a real directory — move its contents into ${target} and delete it`,
    };
  } catch {
    return { label: 'skills link', level: 'warn', detail: `${link} missing — pepperd creates it on startup` };
  }
}

/** Reports presence only. The token value must never appear in any output. */
export function checkBotToken(env: NodeJS.ProcessEnv = process.env): Check {
  return env.TELEGRAM_BOT_TOKEN?.trim()
    ? { label: 'bot token', level: 'ok', detail: 'TELEGRAM_BOT_TOKEN is set' }
    : {
        label: 'bot token',
        level: 'warn',
        detail: 'TELEGRAM_BOT_TOKEN not set in this shell (on EC2 it lives in /etc/pepper/pepper.env)',
      };
}

export function checkWritableRoots(roots: string[]): Check[] {
  if (roots.length === 0) return [{ label: 'writable roots', level: 'ok', detail: 'none configured' }];
  return roots.map((r) => {
    try {
      accessSync(r, constants.W_OK);
      return { label: 'writable root', level: 'ok' as const, detail: r };
    } catch {
      return { label: 'writable root', level: 'fail' as const, detail: `${r} missing or not writable` };
    }
  });
}

export function checkGws(): Check {
  const r = spawnSync('gws', ['--version'], { stdio: 'ignore' });
  return r.error || r.status !== 0
    ? { label: 'gws', level: 'warn', detail: 'not installed (optional — see docs/google-setup.md)' }
    : { label: 'gws', level: 'ok', detail: 'installed' };
}

export async function checkDaemon(cfg: PepperConfig): Promise<Check> {
  try {
    const res = await callControl(socketPath(cfg), { cmd: 'status' }, 2000);
    return res.ok
      ? { label: 'daemon', level: 'ok', detail: 'responding on the control socket' }
      : { label: 'daemon', level: 'warn', detail: `responded with error: ${res.error ?? 'unknown'}` };
  } catch {
    return { label: 'daemon', level: 'warn', detail: `not running (no reply at ${socketPath(cfg)})` };
  }
}

const ICON: Record<CheckLevel, string> = { ok: ' ok ', warn: 'warn', fail: 'FAIL' };

export async function runDoctor(cfg: PepperConfig, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const checks: Check[] = [
    checkNode(),
    checkCodexAuth(cfg.codexHome),
    checkSkillsLink(cfg),
    checkBotToken(env),
    ...checkWritableRoots(cfg.sandboxWritableRoots),
    checkGws(),
    await checkDaemon(cfg),
  ];
  for (const c of checks) {
    process.stdout.write(`[${ICON[c.level]}] ${c.label.padEnd(14)} ${c.detail}\n`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  process.stdout.write(fails === 0 ? '\nNo failures.\n' : `\n${fails} failure(s) — see FAIL lines above.\n`);
  return fails === 0 ? 0 : 1;
}
