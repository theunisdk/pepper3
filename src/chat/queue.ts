import { logger } from '../logger.js';
import type { TurnInput } from '../engine/types.js';

export interface QueuedTurn {
  /** Lines to send as one turn. Coalesced messages accumulate here. */
  inputs: string[];
  /** Image paths accumulated across coalesced messages. */
  images: string[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export interface TurnQueueOptions {
  /** Abort a turn after this long. */
  timeoutMs: number;
  /** Runs one turn. Must honour the signal. */
  run: (input: TurnInput, signal: AbortSignal) => Promise<string>;
}

/**
 * Serialises turns for one chat: exactly one in flight, the rest queued.
 *
 * This is half the answer to "it randomly includes previous answers". If two
 * messages are processed concurrently on one thread, their turns interleave and
 * the model can answer the earlier one in the later reply. Here a second
 * message that arrives mid-turn is *coalesced* into a single follow-up turn
 * rather than racing the first, so the model always sees a coherent
 * question -> answer -> question sequence.
 */
export class TurnQueue {
  private inFlight: AbortController | null = null;
  private pending: QueuedTurn | null = null;
  private draining = false;

  constructor(private readonly opts: TurnQueueOptions) {}

  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Number of messages waiting (0 or 1 coalesced turn). */
  get depth(): number {
    return this.pending ? 1 : 0;
  }

  /**
   * Submit a message. If a turn is already running, this message is merged with
   * any other waiting messages and they run together as one turn.
   */
  submit(input: string, images: string[] = []): Promise<string> {
    if (this.pending) {
      // Merge into the waiting turn; the caller who queued first gets the reply.
      this.pending.inputs.push(input);
      this.pending.images.push(...images);
      logger.debug({ merged: this.pending.inputs.length }, 'coalesced message into pending turn');
      return Promise.resolve('');
    }

    return new Promise<string>((resolve, reject) => {
      this.pending = { inputs: [input], images: [...images], resolve, reject };
      void this.drain();
    });
  }

  /** Abort the in-flight turn, if any. Returns true if something was aborted. */
  cancel(): boolean {
    if (!this.inFlight) return false;
    this.inFlight.abort();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending) {
        const turn = this.pending;
        this.pending = null;

        const ac = new AbortController();
        this.inFlight = ac;
        const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs);

        try {
          const text = await this.opts.run({ text: turn.inputs.join('\n'), images: turn.images }, ac.signal);
          turn.resolve(text);
        } catch (err) {
          turn.reject(err as Error);
        } finally {
          clearTimeout(timer);
          this.inFlight = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
