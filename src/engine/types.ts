/**
 * The boundary between everything deterministic (Pepper) and everything
 * cognitive (the model). The gateway and scheduler talk to this interface and
 * never to Codex directly, which is what lets the whole daemon be tested
 * against FakeEngine with no subscription and no network.
 */

export interface EngineResult {
  /** The reply, and only the reply. Tool calls and reasoning never appear here. */
  text: string;
  threadId: string;
}

export interface EngineHealth {
  authenticated: boolean;
  authMode: 'subscription' | 'unknown';
  detail?: string;
}

/** Thrown when the engine's credentials are missing, expired, or rejected. */
export class EngineAuthError extends Error {
  override readonly name = 'EngineAuthError';
}

/**
 * Thrown when a thread cannot be resumed and the caller must start a new one.
 * `transient: true` means "retry later, keep the thread" (network blip);
 * `transient: false` means the thread is gone and a reset is required.
 */
export class ThreadResumeError extends Error {
  override readonly name = 'ThreadResumeError';
  constructor(message: string, readonly transient: boolean) {
    super(message);
  }
}

/** Thrown when the model's context window is exhausted; triggers an auto-reset. */
export class ContextExhaustedError extends Error {
  override readonly name = 'ContextExhaustedError';
}

export interface Engine {
  /** Run a turn on the chat's persistent thread, creating or resuming as needed. */
  runTurn(chatKey: string, input: string, signal?: AbortSignal): Promise<EngineResult>;

  /** Run a turn on a fresh throwaway thread. Used by isolated-mode jobs. */
  runIsolated(input: string, signal?: AbortSignal): Promise<EngineResult>;

  /** Forget the chat's thread; the next runTurn starts fresh with standing context. */
  resetThread(chatKey: string): Promise<void>;

  health(): Promise<EngineHealth>;
}
