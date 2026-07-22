import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileP = promisify(execFile);

export interface AttachmentInput {
  buffer: Buffer;
  filename: string;
  mime: string;
  caption?: string;
}

export interface ProcessedAttachment {
  /** Text handed to the model (label + any extracted PDF text). */
  text: string;
  /** Absolute paths to local image files → passed as `local_image` blocks. */
  images: string[];
}

export type AttachmentProcessor = (input: AttachmentInput) => Promise<ProcessedAttachment>;

export interface AttachmentProcessorOptions {
  workspacePath: string;
  pdfMaxImagePages: number;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** MIME types the model can see as vision input. */
const IMAGE_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);

/** Binary formats saved but never sent to the model (OpenClaw's blocklist). */
export const BINARY_DOCUMENT_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/zip',
  'application/x-zip-compressed',
  'application/gzip',
  'application/x-tar',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/octet-stream',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/epub+zip',
]);

const MAX_PDF_TEXT_CHARS = 50_000;

/** Refuse oversized uploads before download. Returns a reply, or undefined if fine. */
export function attachmentRefusal(sizeBytes: number | undefined, maxBytes: number): string | undefined {
  if (sizeBytes !== undefined && sizeBytes > maxBytes) {
    return `That file is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — over my ${Math.round(
      maxBytes / (1024 * 1024),
    )} MB limit. Send a smaller one.`;
  }
  return undefined;
}

function mimeType(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function sanitiseName(name: string): string {
  const base = name.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'file';
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  return dirs.some((d) => existsSync(join(d, bin)));
}

function uploadDir(workspacePath: string, when: Date): string {
  return join(workspacePath, 'uploads', when.toISOString().slice(0, 10));
}

function relToWorkspace(workspacePath: string, p: string): string {
  return p.startsWith(workspacePath + '/') ? p.slice(workspacePath.length + 1) : p;
}

function saveUnique(dir: string, name: string, buffer: Buffer): string {
  let candidate = join(dir, name);
  if (existsSync(candidate)) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    do {
      candidate = join(dir, `${stem}-${i}${ext}`);
      i++;
    } while (existsSync(candidate));
  }
  writeFileSync(candidate, buffer);
  return candidate;
}

async function pdfPageCount(pdfPath: string): Promise<number> {
  try {
    const { stdout } = await execFileP('pdfinfo', [pdfPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function rasterise(pdfPath: string, lastPage: number): Promise<string[]> {
  const prefix = pdfPath.replace(/\.pdf$/i, '') + '-page';
  await execFileP('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', String(lastPage), pdfPath, prefix], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const dir = dirname(prefix);
  const base = prefix.slice(dir.length + 1);
  return readdirSync(dir)
    .filter((f) => f.startsWith(base) && f.endsWith('.png'))
    .sort()
    .map((f) => join(dir, f));
}

async function extractText(pdfPath: string): Promise<string> {
  if (!onPath('pdftotext')) return '';
  try {
    const { stdout } = await execFileP('pdftotext', ['-layout', pdfPath, '-'], {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.trim();
    return text.length > MAX_PDF_TEXT_CHARS ? text.slice(0, MAX_PDF_TEXT_CHARS) + '\n…(truncated)' : text;
  } catch {
    return '';
  }
}

async function processPdf(pdfPath: string, label: string, maxPages: number): Promise<ProcessedAttachment> {
  if (!onPath('pdftoppm')) {
    return { text: `${label}\n\n(PDF saved, but I can't read PDFs on this deployment — poppler-utils isn't installed.)`, images: [] };
  }
  const pages = await pdfPageCount(pdfPath);
  const renderPages = Math.min(pages || maxPages, maxPages);
  const images = await rasterise(pdfPath, renderPages);
  const text = await extractText(pdfPath);

  let body = label;
  if (pages > renderPages) {
    body += `\n\n(Showing the first ${renderPages} of ${pages} pages as images; full text extracted below.)`;
  }
  body += text
    ? `\n\n--- extracted text ---\n${text}`
    : `\n\n(No extractable text — likely a scanned PDF; read the page images.)`;
  return { text: body, images };
}

export function createAttachmentProcessor(opts: AttachmentProcessorOptions): AttachmentProcessor {
  const now = opts.now ?? (() => new Date());
  return async (input: AttachmentInput): Promise<ProcessedAttachment> => {
    const mime = mimeType(input.mime);
    const dir = uploadDir(opts.workspacePath, now());
    mkdirSync(dir, { recursive: true });
    const savedPath = saveUnique(dir, sanitiseName(input.filename), input.buffer);
    const caption = input.caption?.trim();
    const label = caption || `[${input.filename || 'file'}]`;

    if (IMAGE_MIMES.has(mime)) {
      return { text: caption || `[image: ${sanitiseName(input.filename)}]`, images: [savedPath] };
    }
    if (mime === 'application/pdf') {
      return await processPdf(savedPath, label, opts.pdfMaxImagePages);
    }
    return {
      text: `${label}\n\n(Saved to ${relToWorkspace(opts.workspacePath, savedPath)} — I can't read that format inline.)`,
      images: [],
    };
  };
}

/** Delete workspace/uploads/<date>/ dirs older than the retention window. Startup-only. */
export function pruneUploads(workspacePath: string, retentionDays: number, now: () => Date = () => new Date()): void {
  const root = join(workspacePath, 'uploads');
  if (!existsSync(root)) return;
  const cutoff = now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    try {
      if (statSync(dir).mtimeMs < cutoff) {
        rmSync(dir, { recursive: true, force: true });
        logger.info({ dir }, 'pruned old uploads');
      }
    } catch {
      /* ignore a dir that vanished or can't be statted */
    }
  }
}
