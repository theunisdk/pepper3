import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBotToken,
  checkCodexAuth,
  checkNode,
  checkSkillsLink,
  checkWritableRoots,
} from '../src/cli/doctor.js';

function fakeAuthJson(dir: string, expEpochSeconds: number): void {
  const payload = Buffer.from(JSON.stringify({ exp: expEpochSeconds })).toString('base64url');
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: `header.${payload}.sig`, refresh_token: 'r' } }),
  );
}

describe('checkNode', () => {
  it('passes on >= 22 and fails below', () => {
    expect(checkNode('v22.4.0').level).toBe('ok');
    expect(checkNode('v18.19.0').level).toBe('fail');
  });
});

describe('checkCodexAuth', () => {
  it('fails on missing credentials and passes on a live token', () => {
    const empty = mkdtempSync(join(tmpdir(), 'doc-'));
    expect(checkCodexAuth(empty).level).toBe('fail');

    const live = mkdtempSync(join(tmpdir(), 'doc-'));
    fakeAuthJson(live, Math.floor(Date.now() / 1000) + 86_400);
    expect(checkCodexAuth(live).level).toBe('ok');
  });
});

describe('checkSkillsLink', () => {
  it('ok when the symlink points at workspace skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const ws = join(dir, 'ws');
    const home = join(dir, 'home');
    mkdirSync(join(ws, 'skills'), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(join(ws, 'skills'), join(home, 'skills'), 'dir');
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('ok');
  });

  it('warns when missing (pepperd creates it) and fails on a wrong target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const ws = join(dir, 'ws');
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('warn');

    symlinkSync(join(dir, 'elsewhere'), join(home, 'skills'), 'dir');
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('fail');
  });
});

describe('checkBotToken', () => {
  it('reports presence without ever echoing the value', () => {
    const c = checkBotToken({ TELEGRAM_BOT_TOKEN: 'sekrit-token-value' } as NodeJS.ProcessEnv);
    expect(c.level).toBe('ok');
    expect(JSON.stringify(c)).not.toContain('sekrit');
    expect(checkBotToken({} as NodeJS.ProcessEnv).level).toBe('warn');
  });
});

describe('checkWritableRoots', () => {
  it('ok when none configured; per-root ok/fail otherwise', () => {
    expect(checkWritableRoots([])).toEqual([expect.objectContaining({ level: 'ok' })]);
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const results = checkWritableRoots([dir, join(dir, 'nope')]);
    expect(results[0]!.level).toBe('ok');
    expect(results[1]!.level).toBe('fail');
  });
});
