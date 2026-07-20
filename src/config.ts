import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, isAbsolute, join } from 'node:path';

export interface PepperConfig {
  /** Telegram numeric user IDs allowed to talk to the bot. Everything else is dropped. */
  ownerTelegramIds: number[];
  /** IANA timezone for cron schedules and the per-turn date header. */
  timezone: string;
  /** Codex model slug, or undefined to use the Codex default. */
  model?: string;
  /** Abort a turn after this long. */
  turnTimeoutMs: number;
  /** Truncate standing context above this size (MEMORY.md is never truncated). */
  standingContextBudget: number;
  /** Live workspace: AGENTS.md, MEMORY.md, notes/, skills/, tools/, run/. */
  workspacePath: string;
  /** Dedicated CODEX_HOME so nothing from an interactive codex leaks in. */
  codexHome: string;
  /** SQLite file holding thread mappings, jobs, and run history. */
  dbPath: string;
  /** Days of daily notes to load as standing context (today + N-1 previous). */
  dailyNoteDays: number;
  /** Fire a missed recurring occurrence if the daemon restarts within this window. */
  cronGraceMs: number;
  /** Nudge the owner (once per thread) when the main thread reaches this many input tokens. */
  threadNudgeTokens: number;
  /** Rotate the main thread automatically at this many input tokens. */
  threadRotateTokens: number;
  /** Dedicated gws (Google Workspace CLI) config dir — Pepper's own Google identity, isolated from any gws use by the owner on the same box. */
  gwsConfigDir: string;
  /**
   * Extra directories the agent's sandboxed shell may write to, beyond the
   * workspace. Needed by tools that persist state in $HOME — e.g. gws writes
   * refreshed OAuth tokens to its config dir; without this the tool works at
   * setup time and dies days later when a headless token refresh can't persist.
   */
  sandboxWritableRoots: string[];
}

const DEFAULTS = {
  timezone: 'UTC',
  turnTimeoutMs: 10 * 60_000,
  standingContextBudget: 20_000,
  dailyNoteDays: 2,
  cronGraceMs: 30 * 60_000,
  threadNudgeTokens: 150_000,
  threadRotateTokens: 250_000,
} as const;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

/**
 * Config is plain JSON with no secrets in it — secrets arrive via the
 * environment (see `/etc/pepper/pepper.env`, populated from SSM at boot).
 * Validation is strict and fails at startup rather than at 3am.
 */
export interface LoadConfigOptions {
  /**
   * The daemon and chat-facing commands need the owner allowlist; local
   * management commands (google/login/doctor) do not — requiring it there
   * just forces an irrelevant env var into setup instructions.
   */
  requireOwnerIds?: boolean;
}

export function loadConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): PepperConfig {
  if (!existsSync(configPath)) {
    throw new ConfigError(
      `No config at ${configPath}. Copy pepper.config.example.json to pepper.config.json and edit it.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }
  const c = raw as Record<string, unknown>;
  // Relative paths resolve against the CONFIG FILE's directory, never the
  // invoker's cwd — pepperctl runs from the agent's sandbox (cwd = workspace),
  // the daemon from the repo, systemd from /: all must agree on the same paths.
  const baseDir = dirname(resolve(configPath));

  // Owner IDs: the security control. An empty allowlist would mean "anyone", so
  // it is an error rather than a permissive default.
  const idsRaw = c.ownerTelegramIds ?? parseEnvIds(env.PEPPER_OWNER_TELEGRAM_IDS) ?? [];
  if ((!Array.isArray(idsRaw) || idsRaw.length === 0) && opts.requireOwnerIds !== false) {
    throw new ConfigError(
      'ownerTelegramIds must list at least one numeric Telegram user ID. ' +
        'Without it the bot would answer anyone. Get yours from @userinfobot.',
    );
  }
  const ownerTelegramIds = (Array.isArray(idsRaw) ? idsRaw : []).map((v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) {
      throw new ConfigError(`ownerTelegramIds entries must be positive integers; got ${JSON.stringify(v)}`);
    }
    return n;
  });

  const workspacePath = absolutise(str(c.workspacePath, env.PEPPER_WORKSPACE) ?? '~/pepper/workspace', baseDir);
  const codexHome = absolutise(str(c.codexHome, env.PEPPER_CODEX_HOME) ?? '~/pepper/codex-home', baseDir);
  const dbPath = absolutise(str(c.dbPath, env.PEPPER_DB) ?? '~/pepper/pepper.sqlite', baseDir);
  const gwsConfigDir = absolutise(str(c.gwsConfigDir, env.PEPPER_GWS_CONFIG_DIR) ?? '~/pepper/gws-home', baseDir);

  const rootsRaw = c.sandboxWritableRoots ?? [];
  if (!Array.isArray(rootsRaw)) {
    throw new ConfigError('sandboxWritableRoots must be an array of directory paths.');
  }
  const sandboxWritableRoots = rootsRaw.map((v) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new ConfigError(`sandboxWritableRoots entries must be non-empty strings; got ${JSON.stringify(v)}`);
    }
    return absolutise(v.trim(), baseDir);
  });

  const timezone = str(c.timezone, env.PEPPER_TZ) ?? DEFAULTS.timezone;
  assertTimezone(timezone);

  const cfg: PepperConfig = {
    ownerTelegramIds,
    timezone,
    turnTimeoutMs: num(c.turnTimeoutMs) ?? DEFAULTS.turnTimeoutMs,
    standingContextBudget: num(c.standingContextBudget) ?? DEFAULTS.standingContextBudget,
    workspacePath,
    codexHome,
    dbPath,
    dailyNoteDays: num(c.dailyNoteDays) ?? DEFAULTS.dailyNoteDays,
    cronGraceMs: num(c.cronGraceMs) ?? DEFAULTS.cronGraceMs,
    threadNudgeTokens: num(c.threadNudgeTokens) ?? DEFAULTS.threadNudgeTokens,
    threadRotateTokens: num(c.threadRotateTokens) ?? DEFAULTS.threadRotateTokens,
    gwsConfigDir,
    sandboxWritableRoots,
  };
  const model = str(c.model, env.PEPPER_MODEL);
  if (model) cfg.model = model;

  if (cfg.turnTimeoutMs < 10_000) throw new ConfigError('turnTimeoutMs must be at least 10000 (10s).');
  if (cfg.dailyNoteDays < 0) throw new ConfigError('dailyNoteDays must be >= 0.');
  if (cfg.standingContextBudget < 1000) throw new ConfigError('standingContextBudget must be at least 1000.');
  if (cfg.threadNudgeTokens < 10_000) throw new ConfigError('threadNudgeTokens must be at least 10000.');
  if (cfg.threadRotateTokens <= cfg.threadNudgeTokens) {
    throw new ConfigError('threadRotateTokens must be greater than threadNudgeTokens.');
  }

  return cfg;
}

/** The Telegram bot token lives only in the environment, never in config. */
export function requireBotToken(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!t) {
    throw new ConfigError(
      'TELEGRAM_BOT_TOKEN is not set. On the EC2 box it is written to /etc/pepper/pepper.env ' +
        'from SSM Parameter Store at boot; locally, export it in your shell.',
    );
  }
  return t;
}

export function socketPath(cfg: PepperConfig): string {
  return join(cfg.workspacePath, 'run', 'pepperd.sock');
}

function parseEnvIds(v: string | undefined): number[] | undefined {
  if (!v?.trim()) return undefined;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
}

function str(v: unknown, envVal?: string): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (envVal?.trim()) return envVal.trim();
  return undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function absolutise(p: string, baseDir: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(baseDir, e);
}

function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ConfigError(`timezone "${tz}" is not a valid IANA timezone (e.g. "Africa/Johannesburg").`);
  }
}
