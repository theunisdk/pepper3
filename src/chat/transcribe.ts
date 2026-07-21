import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileP = promisify(execFile);

/**
 * Voice-note transcription via a LOCAL whisper.cpp binary — deliberately not
 * the OpenAI audio API: that would require OPENAI_API_KEY, the exact
 * credential the billing guard strips to keep Pepper subscription-only.
 *
 * Pipeline: Telegram OGG/Opus → ffmpeg → 16 kHz mono WAV → whisper-cli.
 * Runs in the daemon (not the agent sandbox), niced so a long note can't
 * starve the gateway on a small box.
 */

export interface TranscriberOptions {
  whisperBin: string;
  whisperModel: string;
  /** Language hint passed to whisper. Owner speaks English to Pepper. */
  language?: string;
  /** Hard cap on transcription runtime. */
  timeoutMs?: number;
  ffmpegBin?: string;
}

/** Refuse clearly-oversized notes before burning CPU. Returns a reply, or undefined if fine. */
export function voiceRefusal(durationSec: number | undefined, fileSizeBytes: number | undefined): string | undefined {
  if (durationSec !== undefined && durationSec > 300) {
    return `That's ${Math.round(durationSec / 60)} minutes of audio — I only transcribe notes up to 5 minutes. Send a shorter note or type it.`;
  }
  if (fileSizeBytes !== undefined && fileSizeBytes > 25 * 1024 * 1024) {
    return 'That audio file is too large for me to transcribe (25 MB limit).';
  }
  return undefined;
}

export type Transcriber = (audio: Buffer) => Promise<string>;

/**
 * Build a transcriber, or undefined when the binaries/model are not present —
 * the gateway then answers voice notes with a polite "can't" instead of silence.
 */
export function createTranscriber(opts: TranscriberOptions): Transcriber | undefined {
  if (!existsSync(opts.whisperBin) || !existsSync(opts.whisperModel)) {
    logger.warn(
      { whisperBin: opts.whisperBin, whisperModel: opts.whisperModel },
      'whisper binary or model missing — voice transcription disabled',
    );
    return undefined;
  }
  const ffmpeg = opts.ffmpegBin ?? 'ffmpeg';
  const language = opts.language ?? 'en';
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return async (audio: Buffer): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'pepper-voice-'));
    try {
      const oggPath = join(dir, 'note.ogg');
      const wavPath = join(dir, 'note.wav');
      await writeFile(oggPath, audio);
      await execFileP(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', oggPath, '-ar', '16000', '-ac', '1', wavPath], {
        timeout: 60_000,
      });
      const { stdout } = await execFileP(
        'nice',
        ['-n', '10', opts.whisperBin, '-m', opts.whisperModel, '-f', wavPath, '-l', language, '-nt', '-np', '-t', '2'],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      );
      const text = stdout.replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('empty transcript');
      return text;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
