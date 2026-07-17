/**
 * The subscription-only guard.
 *
 * Requirement 7 is "use my Codex subscription, never per-token API billing".
 * The Codex SDK honours that by *omission*: with no API key in the environment
 * it falls back to the cached ChatGPT login. But "billing is correct because a
 * variable happens to be unset" is not a guarantee — one stray OPENAI_API_KEY
 * in a shell profile, an .env file, or a systemd drop-in and Pepper silently
 * starts spending money per token, with nothing in the logs to say so.
 *
 * So we make it active: strip the credential vars from the child environment
 * and say loudly that we did.
 */

/** Vars that would divert Codex from subscription auth to metered API billing. */
export const BILLING_ENV_VARS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_API_KEY_PATH',
  'AZURE_OPENAI_API_KEY',
] as const;

export interface SanitisedEnv {
  env: NodeJS.ProcessEnv;
  /** Names that were present and have been removed. */
  stripped: string[];
}

/**
 * Returns a copy of `env` with billing credentials removed and CODEX_HOME
 * pinned to Pepper's dedicated directory (so an interactive codex on the same
 * box can't leak its MCP servers or global AGENTS.md into Pepper's runs).
 */
export function sanitiseEnv(codexHome: string, env: NodeJS.ProcessEnv = process.env): SanitisedEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const stripped: string[] = [];

  for (const key of BILLING_ENV_VARS) {
    if (out[key] !== undefined && out[key] !== '') {
      stripped.push(key);
    }
    // Delete unconditionally: an empty-string key is still a key the SDK might read.
    delete out[key];
  }

  out.CODEX_HOME = codexHome;
  return { env: out, stripped };
}
