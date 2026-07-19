import type { Engine, EngineHealth, EngineResult } from './types.js';

export interface FakeTurn {
  chatKey: string | null;
  input: string;
  threadId: string;
}

/**
 * An Engine that never talks to Codex. This is why the Engine interface exists:
 * the gateway, queue, and scheduler can be driven end-to-end in tests with no
 * subscription, no network, and no quota burn.
 */
export class FakeEngine implements Engine {
  readonly turns: FakeTurn[] = [];
  private readonly threads = new Map<string, string>();
  private seq = 0;

  /** Override to script a reply. Default echoes a deterministic marker. */
  responder: (input: string, chatKey: string | null) => string | Promise<string> = (input) =>
    `reply(${input.slice(0, 60)})`;

  /** Set to make the next run throw — used to test failure paths. */
  nextError: Error | null = null;

  /** Artificial latency, so abort/timeout paths can be exercised. */
  delayMs = 0;

  /** Reported as EngineResult.inputTokens on every turn (rotation tests). */
  inputTokens: number | undefined = undefined;

  async runTurn(chatKey: string, input: string, signal?: AbortSignal): Promise<EngineResult> {
    return this.exec(chatKey, input, signal);
  }

  async runIsolated(input: string, signal?: AbortSignal): Promise<EngineResult> {
    return this.exec(null, input, signal);
  }

  async resetThread(chatKey: string): Promise<void> {
    this.threads.delete(chatKey);
  }

  async health(): Promise<EngineHealth> {
    return { authenticated: true, authMode: 'subscription', detail: 'fake engine' };
  }

  private async exec(chatKey: string | null, input: string, signal?: AbortSignal): Promise<EngineResult> {
    if (signal?.aborted) throw abortError();

    if (this.delayMs > 0) {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, this.delayMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          rej(abortError());
        });
      });
    }

    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw e;
    }

    const threadId = chatKey
      ? (this.threads.get(chatKey) ?? this.newThread(chatKey))
      : `isolated-${++this.seq}`;

    this.turns.push({ chatKey, input, threadId });
    return {
      text: await this.responder(input, chatKey),
      threadId,
      ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
    };
  }

  private newThread(chatKey: string): string {
    const id = `thread-${++this.seq}`;
    this.threads.set(chatKey, id);
    return id;
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}
