import { describe, expect, it } from 'vitest';
import { decideRotation, NUDGE_NOTICE, ROTATE_NOTICE } from '../src/chat/rotation.js';

describe('decideRotation', () => {
  const NUDGE = 150_000;
  const ROTATE = 250_000;

  it('does nothing on a short thread', () => {
    expect(decideRotation(50_000, false, NUDGE, ROTATE)).toBe('none');
  });

  it('does nothing when usage is unknown (never rotate blind)', () => {
    expect(decideRotation(undefined, false, NUDGE, ROTATE)).toBe('none');
  });

  it('nudges exactly once per thread', () => {
    expect(decideRotation(160_000, false, NUDGE, ROTATE)).toBe('nudge');
    expect(decideRotation(200_000, true, NUDGE, ROTATE)).toBe('none'); // already nudged
  });

  it('rotates at the hard threshold regardless of the nudge flag', () => {
    expect(decideRotation(250_000, false, NUDGE, ROTATE)).toBe('rotate');
    expect(decideRotation(300_000, true, NUDGE, ROTATE)).toBe('rotate');
  });

  it('boundary: thresholds are inclusive', () => {
    expect(decideRotation(150_000, false, NUDGE, ROTATE)).toBe('nudge');
    expect(decideRotation(249_999, true, NUDGE, ROTATE)).toBe('none');
  });
});

describe('notices', () => {
  it('both reassure that memory survives', () => {
    expect(NUDGE_NOTICE).toContain('nothing is lost');
    expect(ROTATE_NOTICE).toContain('memory carried over');
  });
});
