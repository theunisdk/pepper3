import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addWritableRoot, detectTokenDir } from '../src/cli/google.js';

describe('addWritableRoot', () => {
  const base = JSON.stringify(
    { _comment: 'keep me', ownerTelegramIds: [123456789], timezone: 'UTC', sandboxWritableRoots: [] },
    null,
    2,
  );

  it('adds the directory and emits valid 2-space JSON', () => {
    const { json, changed } = addWritableRoot(base, '/home/x/.config/gws');
    expect(changed).toBe(true);
    const parsed = JSON.parse(json) as { sandboxWritableRoots: string[]; _comment: string };
    expect(parsed.sandboxWritableRoots).toEqual(['/home/x/.config/gws']);
    expect(parsed._comment).toBe('keep me'); // other fields preserved
  });

  it('is idempotent', () => {
    const once = addWritableRoot(base, '/d').json;
    const twice = addWritableRoot(once, '/d');
    expect(twice.changed).toBe(false);
    expect(twice.json).toBe(once);
  });

  it('creates the array when the config lacks the field', () => {
    const { json } = addWritableRoot(JSON.stringify({ ownerTelegramIds: [1] }), '/d');
    expect((JSON.parse(json) as { sandboxWritableRoots: string[] }).sandboxWritableRoots).toEqual(['/d']);
  });
});

describe('detectTokenDir', () => {
  it('finds an existing candidate', () => {
    const home = mkdtempSync(join(tmpdir(), 'gg-'));
    mkdirSync(join(home, '.config', 'gws'), { recursive: true });
    expect(detectTokenDir(home)).toEqual({ dir: join(home, '.config', 'gws'), found: true });
  });

  it('falls back to the default with found=false', () => {
    const home = mkdtempSync(join(tmpdir(), 'gg-'));
    const d = detectTokenDir(home);
    expect(d.found).toBe(false);
    expect(d.dir).toBe(join(home, '.config', 'gws'));
  });
});
