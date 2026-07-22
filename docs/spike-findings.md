# M1 Spike Findings — Codex SDK

Spec §5.1 requires verifying six unknowns on the pinned Codex version before building on it.
Run the spike yourself with `npm run spike` (requires a working `codex login`).

**Pinned version:** `@openai/codex-sdk@0.144.5` → `@openai/codex@0.144.5` → `codex-cli 0.144.5`
**Run date:** 2026-07-16

## Results

| # | Question | Verdict |
|---|---|---|
| 1 | Headless shell tool, no approval stall | ⏸ **Blocked on auth** — must re-run after `codex login` |
| 2 | Sandboxed shell can reach the control socket | ⏸ **Blocked on auth** |
| 3 | Skill discovery path | ✅ **`$CODEX_HOME/skills`** |
| 4 | Abort actually stops the run | ✅ **PASS** — `AbortController` → `AbortError` in ~2.5s |
| 5 | Long-thread auto-compaction | ✅ **Config-confirmed** (`auto_compact_token_limit`); fallback still specified |
| 6 | Token refresh persists | ⚠️ **Refuted as designed** — see "Refresh tokens rotate" below |

Plus one unplanned finding that changes the deploy story (SDK vendors its binary).

## 1. The SDK vendors its own `codex` binary ✅

`@openai/codex-sdk` depends on `@openai/codex`, which ships a platform binary
(`@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`). Pinning the SDK in
`package-lock.json` therefore pins the binary that executes turns — the spec's §5-vs-§11
contradiction (SDK-vendored vs separately-installed CLI) is resolved in favour of vendored.

**Consequence:** `user_data` does **not** need a separate codex CLI install. The same vendored
binary serves `codex login`, so there is no version-skew risk between the login CLI and the
runtime. `scripts/codex-bin.sh` resolves its path.

## 2. Abort works ✅ (this was a spec blocker)

`thread.run(prompt, { signal })` honours an `AbortSignal` and rejects with `AbortError`
(~2.5s, i.e. it genuinely interrupts rather than running to completion). The `Engine`
interface's `signal?: AbortSignal` design is validated. **Not yet verified:** whether
`resumeThread` on an aborted thread is safe — needs auth (§3 fallback stands until proven).

## 3. Skills live at `$CODEX_HOME/skills` ✅

Confirmed from the binary's embedded strings and config schema (`$CODEX_HOME/skills`,
falling back to `$HOME/.codex/skills`; `skills` is a config key alongside `plugins`,
`mcpServers`, `hooks`, `subagents`; there is a `skills/changed` event and
`include_skills_usage_instructions` model flag). `SKILL.md` + YAML frontmatter is the format,
matching the Agent Skills open standard.

**Design simplification:** because Pepper uses a *dedicated* `CODEX_HOME` (§5), we symlink
`$CODEX_HOME/skills` → `workspace/skills`. Skills the owner authors are live immediately —
no mtime polling, no sync step, nothing to forget. §8's "auto-sync" mechanism collapses into
one symlink created at startup.

## 4. Refresh tokens rotate — copying `auth.json` is a trap ⚠️

The most consequential finding. Attempting a real turn produced:

> `Your access token could not be refreshed because your refresh token was already used.
> Please log out and sign in again.`

Refresh tokens are **single-use** (rotating). Each refresh mints a new pair and invalidates
the old. Implications for the deploy design:

- **Copying `auth.json` between machines is hazardous, not merely "sensitive".** Two hosts
  holding the same refresh token means the first to refresh silently invalidates the other.
  The spec listed this as a documented fallback; it must be documented as **last resort**,
  with the copy deleted from the source host.
- **Restoring a backed-up `auth.json` after instance replacement can fail** — the stored
  refresh token may already be spent. Backing up `auth.json` to Parameter Store is therefore
  not a reliable restore path; **`codex login --device-auth` on the fresh box is.**
- `codex login --device-auth` is the correct primary path for EC2 (already the spec's choice).

## 5. `codex login status` lies ⚠️

It reported **"Logged in using ChatGPT"** for credentials whose access token had expired
~3 months earlier (24 Apr) and whose refresh token was spent. It reads the file; it does not
validate. **`health()` must not depend on it.** Instead: decode the `access_token` JWT's `exp`
claim from `auth.json` and treat imminent/passed expiry as unhealthy, and treat any
auth-shaped error from a real turn as authoritative. This is implemented in
`src/engine/codex/auth.ts`.

## Still blocked (re-run after `codex login`)

Tests 1 and 2 — headless shell execution without an approval stall, and socket reachability
from inside the sandbox — need valid credentials. They are the remaining risk to
requirements 2, 4, and 5.

**This does not block development:** per §12 the daemon is built and tested against
`FakeEngine`, which needs no Codex at all. It blocks *deployment sign-off*. Run:

```bash
npx @openai/codex login     # browser, or --device-auth on a headless box
npm run spike               # must be green before M4/deploy
```

## PENDING — vision (`local_image`) probe (added 2026-07-22)

The document-upload feature (PDF pages rasterised to images, sent to the model as
`local_image` blocks — see `src/chat/attachments.ts`) rests on one unverified assumption:
that the subscription Codex model actually *sees* a `local_image` input. The SDK exposes
the type; it has never been run against real Codex.

A probe (`'vision (local_image) input'`) has been **added to `scripts/spike.ts`** (section 5,
after the control-socket test). It builds a test image through the real attachment-processor
pipeline (a minimal 1-page PDF containing the text "PEPPER PDF OK"), sends it to a fresh
thread as `{ type: 'local_image', path }`, and checks whether the model's reply contains
"PDF OK" or "PEPPER PDF OK" — phrases that appear only in the rendered image, not in the
spike's AGENTS.md context, ensuring a PASS is genuine image-reading evidence.

**This has not been run yet.** It requires a box with a valid `codex login` — the environment
that added this probe has none. The owner must run:

```bash
CODEX_HOME=<their codex home> npm run spike
```

and record the PASS/FAIL/SKIP verdict for `vision (local_image) input` in this file (SKIP is
expected if poppler-utils isn't installed on that box).

**If it FAILS** (Codex ignores or cannot use `local_image` on the subscription), the
PDF-vision route is unavailable and the document-upload feature must fall back to the
`pdftotext`-only path (extracted text still sent, no page images) until/unless that changes.
