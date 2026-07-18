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
