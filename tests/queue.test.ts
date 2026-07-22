import { describe, expect, it } from 'vitest';
import { TurnQueue } from '../src/chat/queue.js';
import type { TurnInput } from '../src/engine/types.js';

const defer = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('TurnQueue', () => {
  it('never runs two turns at once', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const q = new TurnQueue({
      timeoutMs: 5000,
      run: async (input) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await defer(20);
        concurrent--;
        return input.text;
      },
    });

    const a = q.submit('one');
    await defer(1);
    const b = q.submit('two');
    await Promise.all([a, b]);

    // Concurrency here is exactly the answer-bleed bug: two turns in flight on
    // one thread let the model answer the earlier question in the later reply.
    expect(maxConcurrent).toBe(1);
  });

  it('coalesces messages that arrive mid-turn into a single turn', async () => {
    const seen: string[] = [];
    const q = new TurnQueue({
      timeoutMs: 5000,
      run: async (input) => {
        seen.push(input.text);
        await defer(30);
        return 'ok';
      },
    });

    const first = q.submit('first');
    await defer(5);
    // Both arrive while 'first' is still running.
    void q.submit('second');
    void q.submit('third');
    await first;
    await defer(60);

    expect(seen).toEqual(['first', 'second\nthird']);
  });

  it('aborts the in-flight turn on cancel', async () => {
    const q = new TurnQueue({
      timeoutMs: 5000,
      run: (_input, signal) =>
        new Promise<string>((_res, rej) => {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            rej(e);
          });
        }),
    });

    const p = q.submit('long');
    await defer(5);
    expect(q.cancel()).toBe(true);
    await expect(p).rejects.toThrow(/aborted/);
    expect(q.cancel()).toBe(false);
  });

  it('aborts a turn that exceeds the timeout', async () => {
    const q = new TurnQueue({
      timeoutMs: 20,
      run: (_input, signal) =>
        new Promise<string>((_res, rej) => {
          signal.addEventListener('abort', () => {
            const e = new Error('timed out');
            e.name = 'AbortError';
            rej(e);
          });
        }),
    });
    await expect(q.submit('slow')).rejects.toThrow(/timed out/);
  });

  it('keeps serving turns after one fails', async () => {
    let n = 0;
    const q = new TurnQueue({
      timeoutMs: 1000,
      run: async () => {
        if (++n === 1) throw new Error('boom');
        return 'recovered';
      },
    });
    await expect(q.submit('a')).rejects.toThrow('boom');
    await expect(q.submit('b')).resolves.toBe('recovered');
  });

  it('coalesces text and concatenates image paths into one turn', async () => {
    const seen: TurnInput[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new TurnQueue({
      timeoutMs: 1000,
      run: async (input) => {
        seen.push(input);
        if (seen.length === 1) await gate; // hold the first turn open
        return 'ok';
      },
    });

    const first = q.submit('caption', ['/u/a.png']); // starts turn 1
    q.submit('and the pdf', ['/u/p1.png', '/u/p2.png']); // coalesced into turn 2
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));

    expect(seen[0]).toEqual({ text: 'caption', images: ['/u/a.png'] });
    expect(seen[1]).toEqual({ text: 'and the pdf', images: ['/u/p1.png', '/u/p2.png'] });
  });

  it('defaults images to empty for a text-only submit', async () => {
    const seen: TurnInput[] = [];
    const q = new TurnQueue({ timeoutMs: 1000, run: async (i) => (seen.push(i), 'ok') });
    await q.submit('hello');
    expect(seen[0]).toEqual({ text: 'hello', images: [] });
  });

  it('merges image paths from multiple mid-turn submits into one coalesced turn', async () => {
    const seen: TurnInput[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new TurnQueue({
      timeoutMs: 1000,
      run: async (input) => {
        seen.push(input);
        if (seen.length === 1) await gate; // hold turn 1 open so the next two submits share turn 2
        return 'ok';
      },
    });

    const first = q.submit('one', ['/u/a.png']); // turn 1, held open
    q.submit('two', ['/u/p1.png']); // creates pending turn 2 (new-pending)
    q.submit('three', ['/u/p2.png', '/u/p3.png']); // MERGES into pending turn 2
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ text: 'one', images: ['/u/a.png'] });
    expect(seen[1]).toEqual({ text: 'two\nthree', images: ['/u/p1.png', '/u/p2.png', '/u/p3.png'] });
  });
});
