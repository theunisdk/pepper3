# Pepper — Management CLI: Design Spec

**Date:** 2026-07-18
**Status:** Approved (owner: "go for it" on the scoped proposal); building
**Builds on:** [2026-07-16-pepper-personal-agent-design.md](2026-07-16-pepper-personal-agent-design.md), [2026-07-18-google-cli-competence-design.md](2026-07-18-google-cli-competence-design.md)

## 1. Purpose

Owner-facing management commands that **wrap the footguns, not the plumbing**. Each command encodes a documented runbook whose manual execution has already caused (or is primed to cause) real failures:

| Command | Footgun it kills |
|---|---|
| `pepperctl login` | Codex login against the wrong `CODEX_HOME` (hit twice in two days); trusting the lying `codex login status` |
| `pepperctl doctor` | "Is it healthy?" requiring five separate manual checks; silent decay discovered only when a turn fails |
| `pepperctl google` | gws token dir missing from `sandboxWritableRoots` → works at setup, dies days later |
| `pepperctl setup` | First-run config authored by hand; template adopters' first ten minutes |

**Explicit non-goals:** no wrappers for `systemctl`/`journalctl`/`terraform` (good tools; wrapping adds surface and removes no failure mode); no remote/SSM management from the laptop (a small `scripts/pepper` helper can be ported from pepper2 later, separately); no npm publication — invoked as `node dist/pepperctl.js <cmd>` / the `pepperctl` bin on deployed boxes.

## 2. Design

**One binary.** The new verbs join the existing `pepperctl` (cron/send/status/runs). Rationale: one tool to learn, shared config loading, and the daemon-control verbs already live there. The new verbs are *local* operations (no daemon socket needed), so the entry point routes: `setup|login|google|doctor` → local command modules; everything else → existing socket path. `setup` must run **before** a config exists; all other commands `loadConfig` first.

New modules under `src/cli/` (entry `src/pepperctl.ts` stays thin):

- **`codex-bin.ts`** — resolves the vendored Codex CLI (`createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')`); spawned via `process.execPath`. No system codex, no version skew — the SDK's pinned binary is the only one ever used (per the M1 spike finding).
- **`login.ts`** — `runLogin(cfg, {deviceAuth})`: spawns the vendored CLI's `login` (stdio inherited, interactive) with env from `sanitiseEnv(cfg.codexHome)` — so `CODEX_HOME` is always Pepper's and billing vars are stripped, same guarantee as the daemon. Afterwards verifies with `checkAuth` (JWT expiry — never `login status`) and prints the verdict; exit 0 only if authenticated.
- **`doctor.ts`** — pure check functions each returning `{label, level: ok|warn|fail, detail}`, assembled by `runDoctor`: config loads; Node ≥ 22; auth via `checkAuth` (fail if expired/missing); skills symlink points at `workspace/skills` (warn if absent — pepperd creates it on first run); daemon socket answers `status` within 2s (warn if down — doctor must work offline); `TELEGRAM_BOT_TOKEN` present in env (warn + where it comes from); each `sandboxWritableRoots` entry exists and is writable (fail); gws on PATH (informational — optional feature). Output style follows `scripts/audit-public.sh` (aligned ok/warn/fail lines); exit 1 iff any fail.
- **`google.ts`** — guided activation: verify gws is installed (else print the install pointer from docs/google-setup.md and exit 1); run `gws auth login` interactively (extra CLI args passed through, e.g. `--client-secret`); locate the token dir (`--token-dir` flag, else first existing of `~/.config/gws`, `~/.gws`; else default `~/.config/gws` with a warning — gws's layout varies by version, so detection is candidates-based, not hardcoded certainty); merge it into `sandboxWritableRoots` in the live `pepper.config.json` via a pure `addWritableRoot(rawJson, dir)` (parse → union → 2-space stringify; idempotent); print the restart reminder. The doc paragraph this automates stays in google-setup.md as the manual fallback.
- **`setup.ts`** — first-run wizard: refuses to overwrite an existing config (unless `--force`); prompts (node:readline/promises) for Telegram owner ID and timezone (validated with the same Intl check as loadConfig); writes `pepper.config.json` from a pure `buildInitialConfig({ownerId, tz})` using the example file's defaults; offers to chain into `login`. Non-interactive flags `--owner-id`, `--tz`, `--no-login` for scripts/tests.

**Safety posture:** all new verbs are owner-ops but harmless if the agent ever invokes them — `doctor` is read-only; `login`/`google`/`setup` block on interactive input (and grant nothing by themselves). No command ever prints a secret: `doctor` reports *presence* of the bot token, `login` reports the auth verdict, never token contents.

## 3. Doc updates

README quick-start collapses to `setup` → `login` → `spike` → `start`, with `doctor` as the troubleshooting entry point; docs/google-setup.md's authorise-on-the-box section leads with `pepperctl google` (manual steps kept as fallback); docs/deploy.md's step 4 and the Terraform MOTD (`user_data/init.sh.tftpl`) use `pepperctl login --device-auth`.

## 4. Testing / acceptance

Pure cores are unit-tested (vitest): doctor's individual checks against temp dirs/fake auth.json (reusing the fake-JWT helper pattern from engine-guard tests); `addWritableRoot` (adds, idempotent, preserves other fields, valid JSON out); `buildInitialConfig` (defaults + validation); pepperctl routing (new verbs don't hit the socket; `setup` runs without config). Interactive spawns (`login`, `gws auth login`, prompts) are thin shells, exercised live rather than mocked.

Live acceptance on the running local daemon: `pepperctl doctor` runs green (warns acceptable: gws absent), correct exit code; `pepperctl login` not re-run (auth valid — verified by doctor instead). `npm run audit` green; existing 59 tests untouched.
