import { existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../config.js';
import { runLogin } from './login.js';

export interface SetupAnswers {
  ownerId: number;
  tz: string;
}

/** Pure config builder — mirrors pepper.config.example.json's defaults. */
export function buildInitialConfig(a: SetupAnswers): Record<string, unknown> {
  if (!Number.isInteger(a.ownerId) || a.ownerId <= 0) {
    throw new Error('owner Telegram ID must be a positive integer (get yours from @userinfobot)');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: a.tz });
  } catch {
    throw new Error(`"${a.tz}" is not a valid IANA timezone (e.g. "Africa/Johannesburg")`);
  }
  return {
    ownerTelegramIds: [a.ownerId],
    timezone: a.tz,
    workspacePath: '~/pepper/workspace',
    codexHome: '~/pepper/codex-home',
    dbPath: '~/pepper/pepper.sqlite',
    sandboxWritableRoots: [],
  };
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}

/**
 * First-run wizard. Interactive by default; --owner-id/--tz/--no-login make it
 * scriptable. Refuses to clobber an existing config without --force.
 */
export async function runSetup(configPath: string, argv: string[]): Promise<number> {
  if (existsSync(configPath) && !argv.includes('--force')) {
    process.stderr.write(`${configPath} already exists. Re-run with --force to overwrite it.\n`);
    return 1;
  }

  let ownerIdRaw = flagValue(argv, '--owner-id');
  let tz = flagValue(argv, '--tz');

  if (!ownerIdRaw || !tz) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      ownerIdRaw ??= (await rl.question('Your numeric Telegram user ID (message @userinfobot to get it): ')).trim();
      tz ??= (await rl.question('Your IANA timezone [UTC]: ')).trim() || 'UTC';
    } finally {
      rl.close();
    }
  }

  let config: Record<string, unknown>;
  try {
    config = buildInitialConfig({ ownerId: Number(ownerIdRaw), tz });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 1;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  process.stdout.write(`Wrote ${configPath}.\n\nNext steps:\n`);
  process.stdout.write('  1. export TELEGRAM_BOT_TOKEN=...   (from @BotFather)\n');
  process.stdout.write('  2. pepperctl login                  (your ChatGPT subscription)\n');
  process.stdout.write('  3. npm run spike && npm start\n');

  if (!argv.includes('--no-login') && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer: string;
    try {
      answer = (await rl.question('\nLog in to Codex now? [Y/n]: ')).trim().toLowerCase();
    } finally {
      rl.close();
    }
    if (answer === '' || answer === 'y' || answer === 'yes') {
      const cfg = loadConfig(configPath);
      return runLogin(cfg, { deviceAuth: argv.includes('--device-auth') });
    }
  }
  return 0;
}
