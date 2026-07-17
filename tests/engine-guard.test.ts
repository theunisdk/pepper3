import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitiseEnv, BILLING_ENV_VARS } from '../src/engine/codex/env.js';
import { checkAuth, isAuthError } from '../src/engine/codex/auth.js';

function fakeAuthJson(dir: string, expEpochSeconds: number): void {
  const payload = Buffer.from(JSON.stringify({ exp: expEpochSeconds })).toString('base64url');
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: `header.${payload}.sig`, refresh_token: 'r' } }),
  );
}

describe('subscription-only guard', () => {
  it('strips every billing variable from the child environment', () => {
    const { env, stripped } = sanitiseEnv('/tmp/codex-home', {
      OPENAI_API_KEY: 'sk-real',
      CODEX_API_KEY: 'ck-real',
      PATH: '/usr/bin',
    } as NodeJS.ProcessEnv);

    // Requirement 7 is "never per-token billing". Leaving this to chance means
    // one stray shell export silently starts charging.
    for (const k of BILLING_ENV_VARS) expect(env[k]).toBeUndefined();
    expect(stripped).toContain('OPENAI_API_KEY');
    expect(stripped).toContain('CODEX_API_KEY');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('pins CODEX_HOME so an interactive codex cannot leak config in', () => {
    const { env } = sanitiseEnv('/opt/pepper/codex-home', { CODEX_HOME: '/home/me/.codex' } as NodeJS.ProcessEnv);
    expect(env.CODEX_HOME).toBe('/opt/pepper/codex-home');
  });

  it('reports nothing stripped on a clean environment', () => {
    const { stripped } = sanitiseEnv('/tmp/x', { PATH: '/bin' } as NodeJS.ProcessEnv);
    expect(stripped).toEqual([]);
  });
});

describe('auth health', () => {
  it('reports unauthenticated when there are no credentials', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-auth-'));
    const h = checkAuth(dir);
    expect(h.authenticated).toBe(false);
    expect(h.detail).toContain('codex login');
  });

  it('catches an expired token that `codex login status` would call healthy', () => {
    // This is the real failure the spike hit: login status said "Logged in"
    // for a token three months dead.
    const dir = mkdtempSync(join(tmpdir(), 'pepper-auth-'));
    fakeAuthJson(dir, Math.floor(Date.now() / 1000) - 86_400);
    const h = checkAuth(dir);
    expect(h.authenticated).toBe(false);
    expect(h.detail).toContain('expired');
  });

  it('accepts a token with time left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-auth-'));
    fakeAuthJson(dir, Math.floor(Date.now() / 1000) + 86_400);
    const h = checkAuth(dir);
    expect(h.authenticated).toBe(true);
    expect(h.authMode).toBe('subscription');
  });

  it('treats an about-to-expire token as unhealthy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pepper-auth-'));
    fakeAuthJson(dir, Math.floor(Date.now() / 1000) + 60); // inside the skew
    expect(checkAuth(dir).authenticated).toBe(false);
  });
});

describe('isAuthError', () => {
  it('recognises the rotating-refresh-token failure', () => {
    expect(
      isAuthError(new Error('Your access token could not be refreshed because your refresh token was already used.')),
    ).toBe(true);
  });

  it('recognises 401s and sign-in prompts', () => {
    expect(isAuthError(new Error('401 Unauthorized'))).toBe(true);
    expect(isAuthError(new Error('Please log out and sign in again'))).toBe(true);
  });

  it('does not swallow unrelated errors', () => {
    expect(isAuthError(new Error('ECONNRESET'))).toBe(false);
  });
});
