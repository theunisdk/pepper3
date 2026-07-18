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
