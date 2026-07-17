import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineHealth } from '../types.js';

/**
 * Why we don't just shell out to `codex login status`:
 *
 * During the M1 spike it cheerfully reported "Logged in using ChatGPT" for
 * credentials whose access token had expired three months earlier and whose
 * refresh token had already been spent. It reads the file; it does not
 * validate. Trusting it would mean Pepper reporting itself healthy right up
 * until the first turn of the day failed.
 *
 * So we read auth.json ourselves and decode the JWT's `exp`. This is still only
 * a liveness hint — a rotating refresh token can be spent without the access
 * token having expired — so an auth-shaped error from a real turn always wins
 * over anything decided here (see isAuthError).
 */

/** Treat a token expiring within this window as already unhealthy. */
const EXPIRY_SKEW_MS = 5 * 60_000;

interface AuthJson {
  tokens?: { access_token?: string; refresh_token?: string };
  OPENAI_API_KEY?: string | null;
}

export function authJsonPath(codexHome: string): string {
  return join(codexHome, 'auth.json');
}

/** Decode a JWT's exp claim (epoch ms). Returns undefined if unreadable. */
function decodeExp(jwt: string): number | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export function checkAuth(codexHome: string, now: number = Date.now()): EngineHealth {
  const path = authJsonPath(codexHome);
  if (!existsSync(path)) {
    return {
      authenticated: false,
      authMode: 'unknown',
      detail: `No credentials at ${path}. Run: codex login --device-auth (CODEX_HOME=${codexHome})`,
    };
  }

  let auth: AuthJson;
  try {
    auth = JSON.parse(readFileSync(path, 'utf8')) as AuthJson;
  } catch (e) {
    return { authenticated: false, authMode: 'unknown', detail: `auth.json is unreadable: ${(e as Error).message}` };
  }

  const access = auth.tokens?.access_token;
  if (!access) {
    return {
      authenticated: false,
      authMode: 'unknown',
      detail: 'auth.json has no ChatGPT access token — Pepper requires subscription auth, not an API key.',
    };
  }

  const exp = decodeExp(access);
  if (exp === undefined) {
    // Can't read it; let a real turn be the judge rather than blocking startup.
    return { authenticated: true, authMode: 'subscription', detail: 'token expiry unknown' };
  }
  if (exp - EXPIRY_SKEW_MS <= now) {
    return {
      authenticated: false,
      authMode: 'subscription',
      detail:
        `ChatGPT token expired ${new Date(exp).toISOString()}. Codex may refresh it automatically on the next ` +
        `turn; if that fails the refresh token is spent — run: codex login --device-auth`,
    };
  }
  return {
    authenticated: true,
    authMode: 'subscription',
    detail: `ChatGPT token valid until ${new Date(exp).toISOString()}`,
  };
}

const AUTH_ERROR_PATTERNS = [
  /refresh token was already used/i,
  /could not be refreshed/i,
  /please (log ?out and )?sign ?in again/i,
  /not logged in/i,
  /unauthorized/i,
  /401/,
];

/** An auth-shaped failure from a real turn is authoritative — see the note above. */
export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERNS.some((re) => re.test(msg));
}
