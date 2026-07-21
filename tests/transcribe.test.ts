import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranscriber, voiceRefusal } from '../src/chat/transcribe.js';

/** Stub whisper/ffmpeg so the pipeline is testable without real binaries. */
function stubBins(whisperBody: string): { whisperBin: string; whisperModel: string; ffmpegBin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stub-bins-'));
  const whisperBin = join(dir, 'whisper-cli');
  writeFileSync(whisperBin, `#!/bin/sh\n${whisperBody}\n`);
  chmodSync(whisperBin, 0o755);
  const ffmpegBin = join(dir, 'ffmpeg');
  // Real invocation: ffmpeg ... -i <in> -ar 16000 -ac 1 <out>. Touch the output (last arg).
  writeFileSync(ffmpegBin, '#!/bin/sh\nfor last; do :; done\n: > "$last"\n');
  chmodSync(ffmpegBin, 0o755);
  const whisperModel = join(dir, 'model.bin');
  writeFileSync(whisperModel, 'fake-model');
  return { whisperBin, whisperModel, ffmpegBin };
}

describe('voiceRefusal', () => {
  it('accepts normal notes', () => {
    expect(voiceRefusal(45, 200_000)).toBeUndefined();
    expect(voiceRefusal(undefined, undefined)).toBeUndefined();
  });

  it('refuses very long or very large audio with a human reason', () => {
    expect(voiceRefusal(700, 1000)).toMatch(/5 minutes/);
    expect(voiceRefusal(30, 30 * 1024 * 1024)).toMatch(/too large/);
  });
});

describe('createTranscriber', () => {
  it('is undefined when the binary or model is missing (voice politely disabled)', () => {
    expect(
      createTranscriber({ whisperBin: '/nonexistent/whisper', whisperModel: '/nonexistent/model' }),
    ).toBeUndefined();
  });

  it('runs the ffmpeg→whisper pipeline and returns a whitespace-normalised transcript', async () => {
    const bins = stubBins('echo " hello   world "');
    const t = createTranscriber(bins)!;
    await expect(t(Buffer.from('fake-ogg'))).resolves.toBe('hello world');
  });

  it('treats an empty transcript as failure', async () => {
    const bins = stubBins('echo ""');
    const t = createTranscriber(bins)!;
    await expect(t(Buffer.from('fake-ogg'))).rejects.toThrow(/empty transcript/);
  });

  it('propagates whisper failure', async () => {
    const bins = stubBins('echo "boom" >&2; exit 3');
    const t = createTranscriber(bins)!;
    await expect(t(Buffer.from('fake-ogg'))).rejects.toThrow();
  });
});
