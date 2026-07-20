import { describe, expect, it } from 'vitest';
import { addWritableRoot, parseAuthStatus, validateClientSecret } from '../src/cli/google.js';

describe('validateClientSecret', () => {
  const good = JSON.stringify({
    installed: { client_id: '424242424-fake.apps.googleusercontent.com', client_secret: 'GOCSPX-x', project_id: 'p' },
  });

  it('accepts a real Desktop-client secret', () => {
    expect(validateClientSecret(good).ok).toBe(true);
  });

  it('rejects a near-empty file (the 1-byte regression)', () => {
    const r = validateClientSecret('\n');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('bytes');
  });

  it('rejects invalid JSON and web-client downloads', () => {
    expect(validateClientSecret('x'.repeat(60)).ok).toBe(false);
    expect(validateClientSecret(JSON.stringify({ web: { client_id: 'x'.repeat(60) } })).ok).toBe(false);
  });

  it('rejects missing client_secret field', () => {
    const r = validateClientSecret(JSON.stringify({ installed: { client_id: 'x'.repeat(60) } }));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('client_secret');
  });
});

describe('parseAuthStatus', () => {
  it('parses real gws output with a preamble line', () => {
    const out =
      'Using keyring backend: keyring\n' +
      JSON.stringify({ client_config_exists: true, has_refresh_token: true, client_id: '424242424-fake' });
    const r = parseAuthStatus(out);
    expect(r.authenticated).toBe(true);
    expect(r.detail).toContain('424242424');
  });

  it('reports unauthenticated states honestly', () => {
    const out = JSON.stringify({ client_config_exists: true, has_refresh_token: false });
    expect(parseAuthStatus(out).authenticated).toBe(false);
    expect(parseAuthStatus('garbage').authenticated).toBe(false);
  });
});

describe('addWritableRoot', () => {
  const base = JSON.stringify({ ownerTelegramIds: [123456789], sandboxWritableRoots: [] }, null, 2);

  it('adds and is idempotent', () => {
    const once = addWritableRoot(base, '/d');
    expect(once.changed).toBe(true);
    const twice = addWritableRoot(once.json, '/d');
    expect(twice.changed).toBe(false);
    expect((JSON.parse(once.json) as { sandboxWritableRoots: string[] }).sandboxWritableRoots).toEqual(['/d']);
  });
});
