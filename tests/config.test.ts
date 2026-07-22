import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.js';

function writeCfg(extra: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pepper-cfg-'));
  const path = join(dir, 'pepper.config.json');
  writeFileSync(path, JSON.stringify({ ownerTelegramIds: [123456789], ...extra }));
  return path;
}

describe('sandboxWritableRoots', () => {
  it('defaults to an empty array when absent', () => {
    const cfg = loadConfig(writeCfg({}));
    expect(cfg.sandboxWritableRoots).toEqual([]);
  });

  it('expands ~ and absolutises relative paths', () => {
    const cfg = loadConfig(writeCfg({ sandboxWritableRoots: ['~/.config/gws', 'rel/dir'] }));
    expect(cfg.sandboxWritableRoots[0]).toBe(join(homedir(), '.config/gws'));
    expect(cfg.sandboxWritableRoots[1]).toMatch(/^\//);
    expect(cfg.sandboxWritableRoots[1]!.endsWith('rel/dir')).toBe(true);
  });

  it('rejects non-array values', () => {
    expect(() => loadConfig(writeCfg({ sandboxWritableRoots: '~/.config/gws' }))).toThrow(ConfigError);
  });

  it('rejects non-string entries', () => {
    expect(() => loadConfig(writeCfg({ sandboxWritableRoots: [42] }))).toThrow(ConfigError);
  });
});

describe('thread rotation thresholds', () => {
  it('defaults to 150k nudge / 250k rotate', () => {
    const cfg = loadConfig(writeCfg({}));
    expect(cfg.threadNudgeTokens).toBe(150_000);
    expect(cfg.threadRotateTokens).toBe(250_000);
  });

  it('rejects rotate <= nudge', () => {
    expect(() => loadConfig(writeCfg({ threadNudgeTokens: 200_000, threadRotateTokens: 200_000 }))).toThrow(
      ConfigError,
    );
  });

  it('rejects a nudge threshold below 10k', () => {
    expect(() => loadConfig(writeCfg({ threadNudgeTokens: 500, threadRotateTokens: 250_000 }))).toThrow(ConfigError);
  });
});

describe('path resolution', () => {
  it('resolves relative paths against the config file dir, not process.cwd()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-cfg-'));
    const path = join(dir, 'pepper.config.json');
    writeFileSync(
      path,
      JSON.stringify({ ownerTelegramIds: [1], workspacePath: './ws', dbPath: './data/pepper.sqlite' }),
    );
    const cfg = loadConfig(path);
    // Wherever the loader is invoked from, the answer must be config-relative.
    expect(cfg.workspacePath).toBe(join(dir, 'ws'));
    expect(cfg.dbPath).toBe(join(dir, 'data', 'pepper.sqlite'));
  });
});

describe('requireOwnerIds option', () => {
  it('management commands can load config without an allowlist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-cfg-'));
    const path = join(dir, 'pepper.config.json');
    writeFileSync(path, JSON.stringify({ timezone: 'UTC' }));
    const cfg = loadConfig(path, {} as NodeJS.ProcessEnv, { requireOwnerIds: false });
    expect(cfg.ownerTelegramIds).toEqual([]);
    // The daemon path still refuses:
    expect(() => loadConfig(path, {} as NodeJS.ProcessEnv)).toThrow(ConfigError);
  });
});

describe('document upload knobs', () => {
  it('defaults document-upload knobs and allows overrides', () => {
    const base = loadConfig(writeCfg({ ownerTelegramIds: [1] }));
    expect(base.pdfMaxImagePages).toBe(20);
    expect(base.attachmentMaxBytes).toBe(20 * 1024 * 1024);
    expect(base.uploadsRetentionDays).toBe(30);

    const over = loadConfig(
      writeCfg({ ownerTelegramIds: [1], pdfMaxImagePages: 5, uploadsRetentionDays: 7 }),
    );
    expect(over.pdfMaxImagePages).toBe(5);
    expect(over.uploadsRetentionDays).toBe(7);
  });

  it('rejects a non-positive pdfMaxImagePages', () => {
    expect(() => loadConfig(writeCfg({ ownerTelegramIds: [1], pdfMaxImagePages: 0 }))).toThrow(
      /pdfMaxImagePages/,
    );
  });

  it('rejects a fractional pdfMaxImagePages', () => {
    expect(() => loadConfig(writeCfg({ ownerTelegramIds: [1], pdfMaxImagePages: 2.5 }))).toThrow(
      /pdfMaxImagePages/,
    );
  });

  it('rejects attachmentMaxBytes below 1024', () => {
    expect(() => loadConfig(writeCfg({ ownerTelegramIds: [1], attachmentMaxBytes: 100 }))).toThrow(
      /attachmentMaxBytes/,
    );
  });

  it('rejects a negative uploadsRetentionDays', () => {
    expect(() => loadConfig(writeCfg({ ownerTelegramIds: [1], uploadsRetentionDays: -1 }))).toThrow(
      /uploadsRetentionDays/,
    );
  });
});
