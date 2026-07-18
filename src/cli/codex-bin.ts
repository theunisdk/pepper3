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
