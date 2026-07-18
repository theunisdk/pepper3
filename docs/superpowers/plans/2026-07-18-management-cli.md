# Management CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner-facing `pepperctl` verbs — `login`, `doctor`, `google`, `setup` — that encode the setup/diagnose runbooks (correct `CODEX_HOME`, gws writable-root, health checks, first-run config) as commands.

**Architecture:** New local-command modules under `src/cli/`, routed from the existing `src/pepperctl.ts` entry before the daemon-socket path. Interactive spawns are thin shells; every decision-making core is a pure exported function with unit tests. Spec: `docs/superpowers/specs/2026-07-18-management-cli-design.md`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers, strict + noUncheckedIndexedAccess), vitest, `node:child_process.spawnSync` for interactive tools.

## Global Constraints

- **PUBLIC repo.** Nothing owner-specific in tracked files; `npm run audit` must pass before push.
- All imports use `.js` specifiers.
- **No secrets in output**: commands report token *presence* and auth *verdicts*, never contents.
- The only codex binary used is the vendored one (resolve `@openai/codex/bin/codex.js`); never a system `codex`.
- Reuse existing helpers — `sanitiseEnv`, `checkAuth`, `callControl`, `socketPath`, `loadConfig`/`ConfigError` — do not duplicate them.
- Commit after each task with the message given in the task.

---

### Task 1: `codex-bin` resolver + `pepperctl login`

**Files:**
- Create: `src/cli/codex-bin.ts`, `src/cli/login.ts`, `tests/cli-login.test.ts`
- Modify: `src/pepperctl.ts`

**Interfaces:**
- Consumes: `sanitiseEnv(codexHome)` from `src/engine/codex/env.js`; `checkAuth(codexHome)` from `src/engine/codex/auth.js`; `loadConfig` from `src/config.js`.
- Produces: `codexCliPath(): string` (Task 6's smoke may use it); `runLogin(cfg: PepperConfig, opts: {deviceAuth: boolean}): number` (Task 4's setup chains into it).

- [ ] **Step 1: Write the failing test**

Create `tests/cli-login.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli-login.test.ts`
Expected: FAIL — module `../src/cli/codex-bin.js` not found.

- [ ] **Step 3: Implement the resolver**

Create `src/cli/codex-bin.ts`:

```typescript
import { createRequire } from 'node:module';

/**
 * The only codex binary Pepper ever uses is the one vendored by the pinned
 * @openai/codex-sdk dependency chain (spike finding: the SDK ships its own
 * binary, so pinning the SDK pins the runtime). Resolving it here — instead of
 * trusting whatever `codex` is on PATH — keeps login and the daemon on the
 * same version and the same auth format.
 */
export function codexCliPath(): string {
  const require = createRequire(import.meta.url);
  return require.resolve('@openai/codex/bin/codex.js');
}
```

- [ ] **Step 4: Implement `runLogin`**

Create `src/cli/login.ts`:

```typescript
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
```

- [ ] **Step 5: Route it in pepperctl**

In `src/pepperctl.ts`: add imports at the top:

```typescript
import { runLogin } from './cli/login.js';
```

In `main()`, immediately after the help/usage early-return and before the existing `loadConfig` line, insert:

```typescript
  if (argv[0] === 'login') {
    const cfg = loadConfig(resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json'));
    process.exit(runLogin(cfg, { deviceAuth: argv.includes('--device-auth') }));
  }
```

Add to the USAGE string, after the `pepperctl runs` line:

```
  pepperctl login [--device-auth]             Log in to Codex against Pepper's CODEX_HOME
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (existing 59 + 1 new), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/cli/codex-bin.ts src/cli/login.ts tests/cli-login.test.ts src/pepperctl.ts
git commit -m "feat: pepperctl login — vendored codex, correct CODEX_HOME, JWT-verified"
```

---

### Task 2: `pepperctl doctor`

**Files:**
- Create: `src/cli/doctor.ts`, `tests/cli-doctor.test.ts`
- Modify: `src/pepperctl.ts`

**Interfaces:**
- Consumes: `checkAuth` from `src/engine/codex/auth.js`; `callControl` from `src/control/client.js`; `socketPath`, `PepperConfig` from `src/config.js`.
- Produces: `runDoctor(cfg, env?): Promise<number>` plus exported pure checks (named below) that the tests target.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-doctor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkBotToken,
  checkCodexAuth,
  checkNode,
  checkSkillsLink,
  checkWritableRoots,
} from '../src/cli/doctor.js';

function fakeAuthJson(dir: string, expEpochSeconds: number): void {
  const payload = Buffer.from(JSON.stringify({ exp: expEpochSeconds })).toString('base64url');
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({ tokens: { access_token: `header.${payload}.sig`, refresh_token: 'r' } }),
  );
}

describe('checkNode', () => {
  it('passes on >= 22 and fails below', () => {
    expect(checkNode('v22.4.0').level).toBe('ok');
    expect(checkNode('v18.19.0').level).toBe('fail');
  });
});

describe('checkCodexAuth', () => {
  it('fails on missing credentials and passes on a live token', () => {
    const empty = mkdtempSync(join(tmpdir(), 'doc-'));
    expect(checkCodexAuth(empty).level).toBe('fail');

    const live = mkdtempSync(join(tmpdir(), 'doc-'));
    fakeAuthJson(live, Math.floor(Date.now() / 1000) + 86_400);
    expect(checkCodexAuth(live).level).toBe('ok');
  });
});

describe('checkSkillsLink', () => {
  it('ok when the symlink points at workspace skills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const ws = join(dir, 'ws');
    const home = join(dir, 'home');
    mkdirSync(join(ws, 'skills'), { recursive: true });
    mkdirSync(home, { recursive: true });
    symlinkSync(join(ws, 'skills'), join(home, 'skills'), 'dir');
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('ok');
  });

  it('warns when missing (pepperd creates it) and fails on a wrong target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const ws = join(dir, 'ws');
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('warn');

    symlinkSync(join(dir, 'elsewhere'), join(home, 'skills'), 'dir');
    expect(checkSkillsLink({ codexHome: home, workspacePath: ws }).level).toBe('fail');
  });
});

describe('checkBotToken', () => {
  it('reports presence without ever echoing the value', () => {
    const c = checkBotToken({ TELEGRAM_BOT_TOKEN: 'sekrit-token-value' } as NodeJS.ProcessEnv);
    expect(c.level).toBe('ok');
    expect(JSON.stringify(c)).not.toContain('sekrit');
    expect(checkBotToken({} as NodeJS.ProcessEnv).level).toBe('warn');
  });
});

describe('checkWritableRoots', () => {
  it('ok when none configured; per-root ok/fail otherwise', () => {
    expect(checkWritableRoots([])).toEqual([expect.objectContaining({ level: 'ok' })]);
    const dir = mkdtempSync(join(tmpdir(), 'doc-'));
    const results = checkWritableRoots([dir, join(dir, 'nope')]);
    expect(results[0]!.level).toBe('ok');
    expect(results[1]!.level).toBe('fail');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli-doctor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/cli/doctor.ts`:

```typescript
import { accessSync, constants, lstatSync, readlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { callControl } from '../control/client.js';
import { checkAuth } from '../engine/codex/auth.js';
import { socketPath, type PepperConfig } from '../config.js';

export type CheckLevel = 'ok' | 'warn' | 'fail';
export interface Check {
  label: string;
  level: CheckLevel;
  detail: string;
}

export function checkNode(version: string = process.version): Check {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return major >= 22
    ? { label: 'node', level: 'ok', detail: version }
    : { label: 'node', level: 'fail', detail: `${version} — Pepper needs Node >= 22` };
}

export function checkCodexAuth(codexHome: string): Check {
  const h = checkAuth(codexHome);
  return h.authenticated
    ? { label: 'codex auth', level: 'ok', detail: h.detail ?? 'authenticated' }
    : { label: 'codex auth', level: 'fail', detail: h.detail ?? 'not authenticated' };
}

export function checkSkillsLink(cfg: Pick<PepperConfig, 'codexHome' | 'workspacePath'>): Check {
  const link = join(cfg.codexHome, 'skills');
  const target = join(cfg.workspacePath, 'skills');
  try {
    if (lstatSync(link).isSymbolicLink()) {
      const actual = readlinkSync(link);
      return actual === target
        ? { label: 'skills link', level: 'ok', detail: `${link} -> ${target}` }
        : { label: 'skills link', level: 'fail', detail: `${link} -> ${actual}, expected ${target}` };
    }
    return {
      label: 'skills link',
      level: 'fail',
      detail: `${link} is a real directory — move its contents into ${target} and delete it`,
    };
  } catch {
    return { label: 'skills link', level: 'warn', detail: `${link} missing — pepperd creates it on startup` };
  }
}

/** Reports presence only. The token value must never appear in any output. */
export function checkBotToken(env: NodeJS.ProcessEnv = process.env): Check {
  return env.TELEGRAM_BOT_TOKEN?.trim()
    ? { label: 'bot token', level: 'ok', detail: 'TELEGRAM_BOT_TOKEN is set' }
    : {
        label: 'bot token',
        level: 'warn',
        detail: 'TELEGRAM_BOT_TOKEN not set in this shell (on EC2 it lives in /etc/pepper/pepper.env)',
      };
}

export function checkWritableRoots(roots: string[]): Check[] {
  if (roots.length === 0) return [{ label: 'writable roots', level: 'ok', detail: 'none configured' }];
  return roots.map((r) => {
    try {
      accessSync(r, constants.W_OK);
      return { label: 'writable root', level: 'ok' as const, detail: r };
    } catch {
      return { label: 'writable root', level: 'fail' as const, detail: `${r} missing or not writable` };
    }
  });
}

export function checkGws(): Check {
  const r = spawnSync('gws', ['--version'], { stdio: 'ignore' });
  return r.error || r.status !== 0
    ? { label: 'gws', level: 'warn', detail: 'not installed (optional — see docs/google-setup.md)' }
    : { label: 'gws', level: 'ok', detail: 'installed' };
}

export async function checkDaemon(cfg: PepperConfig): Promise<Check> {
  try {
    const res = await callControl(socketPath(cfg), { cmd: 'status' }, 2000);
    return res.ok
      ? { label: 'daemon', level: 'ok', detail: 'responding on the control socket' }
      : { label: 'daemon', level: 'warn', detail: `responded with error: ${res.error ?? 'unknown'}` };
  } catch {
    return { label: 'daemon', level: 'warn', detail: `not running (no reply at ${socketPath(cfg)})` };
  }
}

const ICON: Record<CheckLevel, string> = { ok: ' ok ', warn: 'warn', fail: 'FAIL' };

export async function runDoctor(cfg: PepperConfig, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const checks: Check[] = [
    checkNode(),
    checkCodexAuth(cfg.codexHome),
    checkSkillsLink(cfg),
    checkBotToken(env),
    ...checkWritableRoots(cfg.sandboxWritableRoots),
    checkGws(),
    await checkDaemon(cfg),
  ];
  for (const c of checks) {
    process.stdout.write(`[${ICON[c.level]}] ${c.label.padEnd(14)} ${c.detail}\n`);
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  process.stdout.write(fails === 0 ? '\nNo failures.\n' : `\n${fails} failure(s) — see FAIL lines above.\n`);
  return fails === 0 ? 0 : 1;
}
```

- [ ] **Step 4: Route it in pepperctl**

In `src/pepperctl.ts`: add import `import { runDoctor } from './cli/doctor.js';`. In `main()`, next to the Task 1 `login` route, insert:

```typescript
  if (argv[0] === 'doctor') {
    const cfg = loadConfig(resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json'));
    process.exit(await runDoctor(cfg));
  }
```

Add to USAGE after the login line:

```
  pepperctl doctor                            Health checks: auth, skills link, daemon, roots
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor.ts tests/cli-doctor.test.ts src/pepperctl.ts
git commit -m "feat: pepperctl doctor — one command for the five health checks"
```

---

### Task 3: `pepperctl google`

**Files:**
- Create: `src/cli/google.ts`, `tests/cli-google.test.ts`
- Modify: `src/pepperctl.ts`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `runGoogle(configPath: string, argv: string[]): number`; pure `addWritableRoot(rawJson, dir)` and `detectTokenDir(home?)` for tests.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-google.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli-google.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/cli/google.ts`:

```typescript
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Merge a directory into sandboxWritableRoots in the raw config JSON.
 * Pure so it can be tested; idempotent so re-running `pepperctl google`
 * never duplicates entries.
 */
export function addWritableRoot(rawJson: string, dir: string): { json: string; changed: boolean } {
  const cfg = JSON.parse(rawJson) as Record<string, unknown>;
  const roots = Array.isArray(cfg.sandboxWritableRoots) ? (cfg.sandboxWritableRoots as string[]) : [];
  if (roots.includes(dir)) return { json: rawJson, changed: false };
  cfg.sandboxWritableRoots = [...roots, dir];
  return { json: JSON.stringify(cfg, null, 2) + '\n', changed: true };
}

/**
 * gws's token directory varies by version, so this is candidates-based
 * detection, not certainty. `--token-dir` overrides it.
 */
export function detectTokenDir(home: string = homedir()): { dir: string; found: boolean } {
  const candidates = [join(home, '.config', 'gws'), join(home, '.gws')];
  for (const c of candidates) {
    if (existsSync(c)) return { dir: c, found: true };
  }
  return { dir: candidates[0]!, found: false };
}

/**
 * Guided Google activation: run gws's interactive auth, then wire its token
 * directory into sandboxWritableRoots — the step whose omission makes gws work
 * at setup time and die days later when a headless token refresh can't persist.
 */
export function runGoogle(configPath: string, argv: string[]): number {
  const probe = spawnSync('gws', ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    process.stderr.write(
      'gws is not installed. Install it (npm install -g @googleworkspace/cli), do the Google Cloud ' +
        'OAuth setup in docs/google-setup.md, then re-run: pepperctl google\n',
    );
    return 1;
  }

  // --token-dir is ours; everything else passes through to `gws auth login`
  // (e.g. --client-secret <file>).
  const passThrough = [...argv];
  let tokenDirArg: string | undefined;
  const idx = passThrough.indexOf('--token-dir');
  if (idx >= 0) {
    tokenDirArg = passThrough[idx + 1];
    passThrough.splice(idx, tokenDirArg ? 2 : 1);
  }

  process.stdout.write('Running `gws auth login` — follow its prompts.\n');
  const login = spawnSync('gws', ['auth', 'login', ...passThrough], { stdio: 'inherit' });
  if (login.status !== 0) {
    process.stderr.write('gws auth login did not complete. Fix that first, then re-run: pepperctl google\n');
    return login.status ?? 1;
  }

  let tokenDir: string;
  let certain = true;
  if (tokenDirArg) {
    tokenDir = tokenDirArg;
  } else {
    const d = detectTokenDir();
    tokenDir = d.dir;
    certain = d.found;
  }
  if (!certain) {
    process.stderr.write(
      `warning: could not find gws's token directory; assuming ${tokenDir}. Override with --token-dir <path>.\n`,
    );
  }

  const raw = readFileSync(configPath, 'utf8');
  const { json, changed } = addWritableRoot(raw, tokenDir);
  if (changed) {
    writeFileSync(configPath, json);
    process.stdout.write(`Added ${tokenDir} to sandboxWritableRoots in ${configPath}.\n`);
  } else {
    process.stdout.write(`${tokenDir} is already in sandboxWritableRoots.\n`);
  }
  process.stdout.write('Restart pepperd to apply (sudo systemctl restart pepperd, or restart your local daemon).\n');
  return 0;
}
```

- [ ] **Step 4: Route it in pepperctl**

In `src/pepperctl.ts`: add import `import { runGoogle } from './cli/google.js';`. Next to the other local routes, insert (note: it loads config only to fail fast with a good error if none exists — the command edits the file by path):

```typescript
  if (argv[0] === 'google') {
    const configPath = resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json');
    loadConfig(configPath); // fail fast with ConfigError guidance if absent/invalid
    process.exit(runGoogle(configPath, argv.slice(1)));
  }
```

Add to USAGE after the doctor line:

```
  pepperctl google [--token-dir <p>] [gws args] Connect Google: gws auth + sandbox writable root
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/cli/google.ts tests/cli-google.test.ts src/pepperctl.ts
git commit -m "feat: pepperctl google — guided gws auth + writable-root wiring"
```

---

### Task 4: `pepperctl setup` + final USAGE

**Files:**
- Create: `src/cli/setup.ts`, `tests/cli-setup.test.ts`
- Modify: `src/pepperctl.ts`

**Interfaces:**
- Consumes: `runLogin` from Task 1; `loadConfig`, `ConfigError` from `src/config.js`.
- Produces: `runSetup(configPath: string, argv: string[]): Promise<number>`; pure `buildInitialConfig({ownerId, tz})`.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli-setup.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/cli-setup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/cli/setup.ts`:

```typescript
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
```

- [ ] **Step 4: Route it + final USAGE**

In `src/pepperctl.ts`: add import `import { runSetup } from './cli/setup.js';`. Insert the route **before** the other local routes (setup must run with no config present):

```typescript
  if (argv[0] === 'setup') {
    const configPath = resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json');
    process.exit(await runSetup(configPath, argv.slice(1)));
  }
```

Replace the USAGE constant's command list wholesale with this final grouped form (keep the existing Modes/Examples sections below it unchanged):

```
pepperctl — control and manage Pepper

Daemon control (talks to the running pepperd):
  pepperctl status
  pepperctl send <text>                       Message the owner proactively
  pepperctl cron list [--all]
  pepperctl cron add --name <n> (--cron '<expr>' | --at <iso>) --prompt <text>
                     [--mode main|isolated] [--tz <zone>]
  pepperctl cron update --name <n> [--cron '<expr>'|--at <iso>] [--prompt <t>] [--mode m] [--tz z]
  pepperctl cron rm|pause|resume --name <n>
  pepperctl runs --name <n> [--limit N]

Management (local, work without the daemon):
  pepperctl setup [--owner-id N] [--tz Z] [--force] [--no-login]   First-run config wizard
  pepperctl login [--device-auth]             Log in to Codex against Pepper's CODEX_HOME
  pepperctl doctor                            Health checks: auth, skills link, daemon, roots
  pepperctl google [--token-dir <p>] [gws args] Connect Google: gws auth + sandbox writable root
```

- [ ] **Step 5: Run tests + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass, clean, builds.

- [ ] **Step 6: Commit**

```bash
git add src/cli/setup.ts tests/cli-setup.test.ts src/pepperctl.ts
git commit -m "feat: pepperctl setup — first-run wizard; final grouped usage text"
```

---

### Task 5: Doc updates

**Files:**
- Modify: `README.md`, `docs/deploy.md`, `docs/google-setup.md`, `terraform/modules/pepper/user_data/init.sh.tftpl`

- [ ] **Step 1: README quick start**

In `README.md`, in the "## Quick start (local)" section, replace the block from `cp pepper.config.example.json pepper.config.json` through `npm run build && npm start` (inclusive) with:

```bash
npm install && npm run build
node dist/pepperctl.js setup       # writes pepper.config.json, offers Codex login

export TELEGRAM_BOT_TOKEN='123456:ABC...'      # from @BotFather
CODEX_HOME=~/pepper/codex-home npm run spike   # verify headless tool-use — do this first
npm start
```

Immediately after that code block, add the line:

```markdown
If anything misbehaves: `node dist/pepperctl.js doctor` runs every health check at once.
```

In the "## Development" section's code block, add after the `npm run audit` line:

```
node dist/pepperctl.js doctor   # health checks: auth, skills link, daemon, writable roots
```

- [ ] **Step 2: deploy.md — login via pepperctl**

In `docs/deploy.md`, section "## 4. Log Pepper in to Codex", replace:

```bash
sudo -u pepper -i
cd ~/app
CODEX_HOME=~/pepper/codex-home npx @openai/codex login --device-auth
```

with:

```bash
sudo -u pepper -i
cd ~/app
PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js login --device-auth
```

(keep the "and add after that code block:" part that follows, unchanged)

and add after that code block:

```markdown
(`login` reads `codexHome` from the config, runs the SDK's own vendored codex
binary, and verifies the credentials by decoding the token itself — no
`CODEX_HOME` juggling, no trusting `codex login status`.)
```

In "## 5. Verify", after the spike block, add:

```markdown
Or run every health check at once:

```bash
PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js doctor
```
```

- [ ] **Step 3: google-setup.md — lead with the command**

In `docs/google-setup.md`, section "### 3. Authorise on the box": after the `gws auth login --client-secret ...` code block and its "It prints a URL..." line, and **before** the "Then tell Pepper's sandbox..." paragraph, insert:

```markdown
Or let Pepper do this step and the next one together:

    PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js google \
      --client-secret ~/pepper/google_client_secret.json

`pepperctl google` runs the gws login, finds the token directory, adds it to
`sandboxWritableRoots`, and reminds you to restart. The manual steps below
remain as the fallback.
```

- [ ] **Step 4: Terraform MOTD**

In `terraform/modules/pepper/user_data/init.sh.tftpl`, in the MOTD heredoc, replace:

```
  CODEX_HOME=~/pepper/codex-home npx @openai/codex login --device-auth
```

with:

```
  PEPPER_CONFIG=~/pepper/pepper.config.json node dist/pepperctl.js login --device-auth
```

- [ ] **Step 5: Verify and commit**

Run: `npm run audit` → "safe to publish". Verify no stale instruction remains: `grep -rn "npx @openai/codex login" README.md docs/ terraform/` → only historical mentions in docs/spike-findings.md are acceptable (that file records what was run at spike time); README/deploy/MOTD must be clean.

```bash
git add README.md docs/deploy.md docs/google-setup.md terraform/modules/pepper/user_data/init.sh.tftpl
git commit -m "docs: route setup/login/google/doctor runbooks through pepperctl"
```

---

### Task 6: Final verification (orchestrator-run)

- [ ] **Step 1:** `npx vitest run && npx tsc --noEmit && npm run build && npm run audit` — all green.
- [ ] **Step 2:** Live: `node dist/pepperctl.js doctor` against the running local daemon (PEPPER_CONFIG defaulting to repo config). Expected: node ok, codex auth ok, skills link ok, bot token warn (not set in this shell — the daemon holds it), writable roots ok (none configured), gws warn (not installed locally), daemon ok. Exit 0.
- [ ] **Step 3:** `terraform fmt -check` on the module (MOTD edit is inside a heredoc — formatting must survive), and `terraform validate` both roots.
- [ ] **Step 4:** Push: `git push origin main`.
