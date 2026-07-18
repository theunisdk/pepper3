import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { codexCliPath } from '../src/cli/codex-bin.js';

describe('codexCliPath', () => {
  it('resolves the vendored codex CLI entry point', () => {
    const p = codexCliPath();
    expect(p).toMatch(/@openai\/codex\/bin\/codex\.js$/);
    expect(existsSync(p)).toBe(true);
  });
});
