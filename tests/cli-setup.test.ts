import { describe, expect, it } from 'vitest';
import { buildInitialConfig } from '../src/cli/setup.js';

describe('buildInitialConfig', () => {
  it('produces a config with the template defaults', () => {
    const cfg = buildInitialConfig({ ownerId: 123456789, tz: 'Africa/Johannesburg' });
    expect(cfg).toEqual({
      ownerTelegramIds: [123456789],
      timezone: 'Africa/Johannesburg',
      workspacePath: '~/pepper/workspace',
      codexHome: '~/pepper/codex-home',
      dbPath: '~/pepper/pepper.sqlite',
      sandboxWritableRoots: [],
    });
  });

  it('rejects a non-positive or non-integer owner id', () => {
    expect(() => buildInitialConfig({ ownerId: 0, tz: 'UTC' })).toThrow(/positive integer/);
    expect(() => buildInitialConfig({ ownerId: 1.5, tz: 'UTC' })).toThrow(/positive integer/);
  });

  it('rejects an invalid timezone', () => {
    expect(() => buildInitialConfig({ ownerId: 1, tz: 'Mars/OlympusMons' })).toThrow(/IANA timezone/);
  });
});
