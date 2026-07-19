import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkspace } from '../src/workspace.js';
import type { PepperConfig } from '../src/config.js';

function cfgIn(dir: string): PepperConfig {
  return {
    ownerTelegramIds: [1],
    timezone: 'UTC',
    turnTimeoutMs: 60_000,
    standingContextBudget: 20_000,
    workspacePath: join(dir, 'workspace'),
    codexHome: join(dir, 'codex-home'),
    dbPath: join(dir, 'db.sqlite'),
    dailyNoteDays: 2,
    cronGraceMs: 60_000,
    threadNudgeTokens: 150_000,
    threadRotateTokens: 250_000,
    sandboxWritableRoots: [],
  };
}

function gitLog(ws: string): string {
  return execSync(`git -C "${ws}" log --oneline`, { encoding: 'utf8' }).trim();
}

describe('initWorkspace', () => {
  it('creates the workspace with SOUL.md and a local git repo with one commit', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);

    expect(existsSync(join(cfg.workspacePath, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(cfg.workspacePath, '.git'))).toBe(true);
    expect(gitLog(cfg.workspacePath).split('\n')).toHaveLength(1);
    // Local-only: no remote may ever be configured by us.
    const remotes = execSync(`git -C "${cfg.workspacePath}" remote`, { encoding: 'utf8' }).trim();
    expect(remotes).toBe('');
  });

  it('makes AGENTS.md read-only (0444) as an accident barrier', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    const mode = statSync(join(cfg.workspacePath, 'AGENTS.md')).mode & 0o777;
    expect(mode).toBe(0o444);
  });

  it('is idempotent — a second run adds no commits', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    initWorkspace(cfg);
    expect(gitLog(cfg.workspacePath).split('\n')).toHaveLength(1);
  });

  it('auto-commits drift found at startup', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    writeFileSync(join(cfg.workspacePath, 'MEMORY.md'), '# Memory\n- drifted');
    initWorkspace(cfg);
    const log = gitLog(cfg.workspacePath);
    expect(log.split('\n')).toHaveLength(2);
    expect(log).toContain('uncommitted workspace changes');
  });

  it('recreates SOUL.md from the template if it went missing', () => {
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    rmSync(join(cfg.workspacePath, 'SOUL.md'));
    initWorkspace(cfg);
    expect(existsSync(join(cfg.workspacePath, 'SOUL.md'))).toBe(true);
  });
});

describe('commitWorkspace', () => {
  it('commits drift with the agent-authored message and reports the hash', async () => {
    const { commitWorkspace } = await import('../src/workspace.js');
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    writeFileSync(join(cfg.workspacePath, 'SOUL.md'), '# Soul\n- new rule');

    const r = commitWorkspace(cfg.workspacePath, 'add a new rule');
    expect(r.committed).toBe(true);
    expect(r.detail).toContain('add a new rule');
    expect(gitLog(cfg.workspacePath)).toContain('add a new rule');
  });

  it('reports nothing-to-commit on a clean tree without creating a commit', async () => {
    const { commitWorkspace } = await import('../src/workspace.js');
    const cfg = cfgIn(mkdtempSync(join(tmpdir(), 'ws-')));
    initWorkspace(cfg);
    const r = commitWorkspace(cfg.workspacePath, 'noop');
    expect(r.committed).toBe(false);
    expect(gitLog(cfg.workspacePath).split('\n')).toHaveLength(1);
  });
});

describe('ensurePepperctlShim', () => {
  it('writes an executable shim baking in entrypoint and config path', async () => {
    const { ensurePepperctlShim } = await import('../src/workspace.js');
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    const entry = join(dir, 'fake-pepperctl.js');
    writeFileSync(entry, '// entry');
    const ok = ensurePepperctlShim(dir, '/etc/pepper/pepper.config.json', entry);
    expect(ok).toBe(true);
    const shim = join(dir, 'tools', 'pepperctl');
    const mode = statSync(shim).mode & 0o111;
    expect(mode).not.toBe(0); // executable
    const body = execSync(`cat "${shim}"`, { encoding: 'utf8' });
    expect(body).toContain(entry);
    expect(body).toContain('/etc/pepper/pepper.config.json');
  });

  it('skips gracefully when the entrypoint does not exist', async () => {
    const { ensurePepperctlShim } = await import('../src/workspace.js');
    const dir = mkdtempSync(join(tmpdir(), 'ws-'));
    expect(ensurePepperctlShim(dir, '/cfg', join(dir, 'missing.js'))).toBe(false);
  });
});
