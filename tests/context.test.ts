import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStandingContext, dateHeader, firstTurnInput, localDateStamp } from '../src/context.js';
import type { PepperConfig } from '../src/config.js';

function ws(): PepperConfig {
  const dir = mkdtempSync(join(tmpdir(), 'pepper-ws-'));
  mkdirSync(join(dir, 'notes'), { recursive: true });
  return {
    ownerTelegramIds: [1],
    timezone: 'Africa/Johannesburg',
    turnTimeoutMs: 60_000,
    standingContextBudget: 20_000,
    workspacePath: dir,
    codexHome: join(dir, 'codex'),
    dbPath: join(dir, 'db.sqlite'),
    dailyNoteDays: 2,
    cronGraceMs: 60_000,
    threadNudgeTokens: 150_000,
    threadRotateTokens: 250_000,
    sandboxWritableRoots: [],
  };
}

describe('localDateStamp', () => {
  it('uses the owner timezone, not the server clock', () => {
    // 22:30 UTC is already the next day in Johannesburg (UTC+2).
    const at = new Date('2026-07-16T22:30:00Z');
    expect(localDateStamp('Africa/Johannesburg', at)).toBe('2026-07-17');
    expect(localDateStamp('UTC', at)).toBe('2026-07-16');
  });
});

describe('dateHeader', () => {
  it('states the current time and zone', () => {
    const h = dateHeader('UTC', new Date('2026-07-16T09:00:00Z'));
    expect(h).toContain('Thursday');
    expect(h).toContain('16 July 2026');
    expect(h).toContain('UTC');
  });
});

describe('buildStandingContext', () => {
  it('is empty when the workspace is bare', () => {
    expect(buildStandingContext(ws()).text).toBe('');
  });

  it('includes MEMORY.md and today+yesterday notes', () => {
    const cfg = ws();
    const at = new Date('2026-07-16T09:00:00Z');
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '# Memory\n- I like tea');
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-16.md'), 'today note');
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-15.md'), 'yesterday note');
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-01.md'), 'ancient note');

    const ctx = buildStandingContext(cfg, at);
    expect(ctx.text).toContain('I like tea');
    expect(ctx.text).toContain('today note');
    expect(ctx.text).toContain('yesterday note');
    expect(ctx.text).not.toContain('ancient note');
    expect(ctx.truncated).toBe(false);
  });

  it('never truncates MEMORY.md, even when over budget', () => {
    const cfg = { ...ws(), standingContextBudget: 2000 };
    const at = new Date('2026-07-16T09:00:00Z');
    const memory = '# Memory\n' + 'M'.repeat(3000);
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), memory);
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-16.md'), 'N'.repeat(3000));

    const ctx = buildStandingContext(cfg, at);
    // Dropping durable memory to fit a note would recreate the amnesia bug.
    expect(ctx.text).toContain('M'.repeat(3000));
    expect(ctx.truncated).toBe(true);
  });

  it('keeps the newest lines when trimming a note', () => {
    const cfg = { ...ws(), standingContextBudget: 2000 };
    const at = new Date('2026-07-16T09:00:00Z');
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-16.md'), 'OLDEST\n' + 'x'.repeat(2000) + '\nNEWEST');

    const ctx = buildStandingContext(cfg, at);
    expect(ctx.text).toContain('NEWEST');
    expect(ctx.text).not.toContain('OLDEST');
  });

  it('includes SOUL.md before MEMORY.md', () => {
    const cfg = ws();
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), '# Soul\n- reply in haiku');
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '- likes tea');
    const ctx = buildStandingContext(cfg, new Date('2026-07-16T09:00:00Z'));
    expect(ctx.text).toContain('reply in haiku');
    expect(ctx.text.indexOf('reply in haiku')).toBeLessThan(ctx.text.indexOf('likes tea'));
  });

  it('never truncates SOUL.md under budget pressure', () => {
    const cfg = { ...ws(), standingContextBudget: 2000 };
    const soul = '# Soul\n' + 'S'.repeat(3000);
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), soul);
    writeFileSync(join(cfg.workspacePath, 'notes', '2026-07-16.md'), 'N'.repeat(3000));
    const ctx = buildStandingContext(cfg, new Date('2026-07-16T09:00:00Z'));
    expect(ctx.text).toContain('S'.repeat(3000));
    expect(ctx.truncated).toBe(true);
  });

  it('is non-empty when only SOUL.md exists', () => {
    const cfg = ws();
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), '# Soul\n- a rule');
    expect(buildStandingContext(cfg).text).toContain('a rule');
  });
});

describe('firstTurnInput', () => {
  it('carries the date header, the context, and the prompt', () => {
    const cfg = ws();
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '- fact');
    const out = firstTurnInput(cfg, 'what do you know?', new Date('2026-07-16T09:00:00Z'));
    expect(out).toContain('[Now:');
    expect(out).toContain('- fact');
    expect(out).toContain('what do you know?');
  });
});
