import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PepperConfig } from '../config.js';

/**
 * Guided Google activation — `pepperctl google [account@email]`.
 *
 * Design constraints, learned against the real CLI:
 * - gws (0.22.x) has no --client-secret flag; it reads its client config from
 *   its config dir, overridable via GOOGLE_WORKSPACE_CLI_CONFIG_DIR.
 * - Pepper gets a DEDICATED gws config dir (cfg.gwsConfigDir) so her Google
 *   identity never collides with any gws the owner uses on the same box —
 *   the same doctrine as her dedicated CODEX_HOME.
 * - Client-secret files are validated before use: a corrupt copy once passed
 *   silently as a 1-byte file.
 * - `gws auth setup` automates the whole Google-console part when gcloud is
 *   installed — offer it; otherwise print precise manual steps.
 * - Success is verified via `gws auth status` afterwards — never reported
 *   unobserved.
 */

/** Validate the structure of a Google OAuth Desktop-client secret JSON. */
export function validateClientSecret(raw: string): { ok: boolean; detail: string } {
  if (raw.trim().length < 50) {
    return { ok: false, detail: `file is ${raw.trim().length} bytes — not a client secret (corrupt copy?)` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, detail: 'not valid JSON' };
  }
  const installed = (parsed as { installed?: Record<string, unknown> }).installed;
  if (!installed) {
    return { ok: false, detail: 'missing "installed" key — is this a Desktop-app OAuth client download?' };
  }
  for (const field of ['client_id', 'client_secret'] as const) {
    const v = installed[field];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, detail: `missing or empty installed.${field}` };
    }
  }
  return { ok: true, detail: `client ${String(installed.client_id).slice(0, 12)}…` };
}

/** Parse `gws auth status` output (a JSON blob after a possible preamble line). */
export function parseAuthStatus(stdout: string): { authenticated: boolean; detail: string } {
  const start = stdout.indexOf('{');
  if (start < 0) return { authenticated: false, detail: 'no status output from gws' };
  try {
    const status = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    const ok = status.has_refresh_token === true && status.client_config_exists === true;
    return {
      authenticated: ok,
      detail: ok
        ? `authenticated (client ${String(status.client_id ?? '').slice(0, 12)}…)`
        : `not authenticated (client_config_exists=${String(status.client_config_exists)}, has_refresh_token=${String(status.has_refresh_token)})`,
    };
  } catch {
    return { authenticated: false, detail: 'unparseable status output from gws' };
  }
}

/** Extract the signed-in account from a `gws gmail users getProfile` response. */
export function extractEmail(stdout: string): string | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  try {
    const profile = JSON.parse(stdout.slice(start)) as { emailAddress?: string };
    return typeof profile.emailAddress === 'string' ? profile.emailAddress : undefined;
  } catch {
    return undefined;
  }
}

/** Merge a directory into sandboxWritableRoots in the raw config JSON. Idempotent. */
export function addWritableRoot(rawJson: string, dir: string): { json: string; changed: boolean } {
  const cfg = JSON.parse(rawJson) as Record<string, unknown>;
  const roots = Array.isArray(cfg.sandboxWritableRoots) ? (cfg.sandboxWritableRoots as string[]) : [];
  if (roots.includes(dir)) return { json: rawJson, changed: false };
  cfg.sandboxWritableRoots = [...roots, dir];
  return { json: JSON.stringify(cfg, null, 2) + '\n', changed: true };
}

const CONSOLE_STEPS = `To create the OAuth client by hand (once, ~10 min):
  1. console.cloud.google.com — create/select a project, signed in as the
     Google account your assistant will BE.
  2. APIs & Services -> Library: enable Gmail API and Google Calendar API.
  3. APIs & Services -> OAuth consent screen: External, fill the basics,
     then PUBLISH TO PRODUCTION (Testing-mode refresh tokens die in 7 days).
  4. Credentials -> Create credentials -> OAuth client ID -> Desktop app.
     Download the JSON, then re-run:
       pepperctl google --client-secret <downloaded-file.json>

Or install gcloud and re-run \`pepperctl google\` for the automated setup.`;

export function runGoogle(cfg: PepperConfig, configPath: string, argv: string[]): number {
  const probe = spawnSync('gws', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      'gws is not installed. Install it first (npm install -g @googleworkspace/cli), then re-run: pepperctl google\n',
    );
    return 1;
  }

  const gwsDir = cfg.gwsConfigDir;
  mkdirSync(gwsDir, { recursive: true });
  const gwsEnv = { ...process.env, GOOGLE_WORKSPACE_CLI_CONFIG_DIR: gwsDir };
  const clientSecretDest = join(gwsDir, 'client_secret.json');
  let authedDuringSetup = false;

  // Positional account email: `pepperctl google pepper@example.com` — used to
  // VERIFY the signed-in identity afterwards. The browser account-chooser
  // decides who the token belongs to; this catches picking the wrong account.
  const expectedEmail = argv.find((a) => !a.startsWith('--') && a.includes('@'));

  // --client-secret <file>: validate, then stage into the dedicated dir.
  const csIdx = argv.indexOf('--client-secret');
  const passThrough = [...argv];
  if (csIdx >= 0) {
    const src = passThrough[csIdx + 1];
    passThrough.splice(csIdx, src && !src.startsWith('--') ? 2 : 1);
    if (!src || src.startsWith('--') || !existsSync(src)) {
      process.stderr.write(`--client-secret: file not found: ${src ?? '(missing path)'}\n`);
      return 1;
    }
    const check = validateClientSecret(readFileSync(src, 'utf8'));
    if (!check.ok) {
      process.stderr.write(`--client-secret: ${src} failed validation: ${check.detail}\n`);
      return 1;
    }
    copyFileSync(src, clientSecretDest);
    chmodSync(clientSecretDest, 0o600);
    process.stdout.write(`Client secret validated (${check.detail}) and staged in ${gwsDir}.\n`);
  }

  if (!existsSync(clientSecretDest)) {
    // No OAuth client yet: automate with gcloud when possible, else instruct.
    const hasGcloud = spawnSync('gcloud', ['--version'], { stdio: 'ignore' }).status === 0;
    if (!hasGcloud) {
      process.stderr.write(`No OAuth client configured and gcloud is not installed.\n\n${CONSOLE_STEPS}\n`);
      return 1;
    }
    process.stdout.write(
      'No OAuth client configured. gcloud is available — running `gws auth setup --login`:\n' +
        'it creates the GCP project + OAuth client, then signs in. Use the Google account\n' +
        'your assistant will BE.\n',
    );
    const setup = spawnSync('gws', ['auth', 'setup', '--login'], { stdio: 'inherit', env: gwsEnv });
    if (setup.status !== 0) {
      process.stderr.write(`gws auth setup did not complete.\n\n${CONSOLE_STEPS}\n`);
      return setup.status ?? 1;
    }
    authedDuringSetup = true;
  }

  if (!authedDuringSetup) {
    process.stdout.write(
      `Running gws auth login (config dir: ${gwsDir}) — sign in as the Google account your assistant will BE.\n`,
    );
    const login = spawnSync('gws', ['auth', 'login', ...passThrough], { stdio: 'inherit', env: gwsEnv });
    if (login.status !== 0) {
      process.stderr.write('gws auth login did not complete. Fix that first, then re-run: pepperctl google\n');
      return login.status ?? 1;
    }
  }

  // Post-verify — never report success we did not observe.
  const status = spawnSync('gws', ['auth', 'status'], { encoding: 'utf8', env: gwsEnv });
  const verdict = parseAuthStatus(status.stdout ?? '');
  if (!verdict.authenticated) {
    process.stderr.write(`❌ Verification failed: ${verdict.detail}\n`);
    return 1;
  }

  // Identity check: whose token did the browser flow actually mint?
  const profile = spawnSync('gws', ['gmail', 'users', 'getProfile', '--params', '{"userId":"me"}'], {
    encoding: 'utf8',
    env: gwsEnv,
  });
  const signedInAs = extractEmail(profile.stdout ?? '');
  if (expectedEmail && signedInAs && signedInAs.toLowerCase() !== expectedEmail.toLowerCase()) {
    // Wrong account must not linger as the assistant's identity.
    spawnSync('gws', ['auth', 'logout'], { stdio: 'ignore', env: gwsEnv });
    process.stderr.write(
      `❌ Signed in as ${signedInAs}, but expected ${expectedEmail}.\n` +
        `   Logged that token out. Re-run and pick ${expectedEmail} in the browser's account chooser\n` +
        `   ("Use another account" if it isn't listed).\n`,
    );
    return 1;
  }
  process.stdout.write(`✅ ${verdict.detail}${signedInAs ? ` — signed in as ${signedInAs}` : ''}\n`);

  // Token refreshes must persist from headless agent runs: the dedicated dir
  // becomes a sandbox writable root.
  const raw = readFileSync(configPath, 'utf8');
  const { json, changed } = addWritableRoot(raw, gwsDir);
  if (changed) {
    writeFileSync(configPath, json);
    process.stdout.write(`Added ${gwsDir} to sandboxWritableRoots in ${configPath}.\n`);
  }
  process.stdout.write('Restart pepperd to apply (sudo systemctl restart pepperd, or restart your local daemon).\n');
  return 0;
}
