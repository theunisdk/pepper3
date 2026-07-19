/**
 * Main-thread hygiene, daemon-owned (pattern 3).
 *
 * The main chat thread is the only context in the system that grows without
 * bound. Codex has its own auto-compaction, but we've never observed it fire
 * live — and "hope the opaque mechanism works" is not how Pepper holds a
 * guarantee. The daemon sees every turn's input-token usage, so it owns the
 * policy: nudge the owner once when the thread gets long, rotate it outright
 * before it gets pathological. Rotation is cheap by design — durable memory
 * lives on disk and is re-injected on the fresh thread, so the cost is recent
 * conversational nuance only.
 */

export type RotationDecision = 'none' | 'nudge' | 'rotate';

export function decideRotation(
  inputTokens: number | undefined,
  alreadyNudged: boolean,
  nudgeAt: number,
  rotateAt: number,
): RotationDecision {
  if (inputTokens === undefined) return 'none';
  if (inputTokens >= rotateAt) return 'rotate';
  if (inputTokens >= nudgeAt && !alreadyNudged) return 'nudge';
  return 'none';
}

export const NUDGE_NOTICE =
  '\n\n_(Heads up: this conversation is getting long. `/new` whenever convenient — my notes and memory carry over, nothing is lost.)_';

export const ROTATE_NOTICE =
  "\n\n_(This conversation grew long, so I've started a fresh thread — my notes and memory carried over.)_";
