import { spawnSync } from 'node:child_process';
import type { PepperConfig } from '../config.js';
import { checkAuth } from '../engine/codex/auth.js';
import { sanitiseEnv } from '../engine/codex/env.js';
import { codexCliPath } from './codex-bin.js';

export interface LoginOptions {
  deviceAuth: boolean;
}

/**
 * Log Pepper in to Codex — always against Pepper's own CODEX_HOME, never
 * ~/.codex. Logging into the wrong home is the single most-hit setup footgun,
 * and `codex login status` cannot be trusted to catch it (it reports stale
 * credentials as healthy), so we verify with the JWT-expiry check afterwards.
 */
export function runLogin(cfg: PepperConfig, opts: LoginOptions): number {
  const { env, stripped } = sanitiseEnv(cfg.codexHome);
  if (stripped.length > 0) {
    process.stderr.write(
      `note: ignoring ${stripped.join(', ')} — Pepper runs on your ChatGPT subscription, not API keys.\n`,
    );
  }

  process.stdout.write(`Codex login for CODEX_HOME=${cfg.codexHome}\n`);
  const args = [codexCliPath(), 'login'];
  if (opts.deviceAuth) args.push('--device-auth');
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: env as NodeJS.ProcessEnv });

  const health = checkAuth(cfg.codexHome);
  if (health.authenticated) {
    process.stdout.write(`✅ ${health.detail ?? 'authenticated'}\n`);
    return 0;
  }
  process.stderr.write(`❌ ${health.detail ?? 'not authenticated'}\n`);
  return result.status ?? 1;
}
