# Document & Image Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner send a PDF or image over Telegram and have Pepper read it — images via the model's vision, PDFs as rasterized page images plus extracted text, letting Codex pick.

**Architecture:** A new `message:document` / `message:photo` gateway handler downloads the file and runs it through a standalone `attachments.ts` processor (mirroring `transcribe.ts`): images are saved and passed as `local_image`; PDFs are rasterized (first N pages via `pdftoppm`) and text-extracted (all pages via `pdftotext`); office binaries are saved but not sent to the model. The result feeds the existing `onMessage` path, so coalescing and the turn queue apply unchanged. The one boundary change widens the Engine input from `string` to `string | TurnInput` (text + image paths); the string path stays byte-for-byte identical.

**Tech Stack:** TypeScript (ESM, NodeNext), grammY, `@openai/codex-sdk`, poppler-utils (`pdftoppm`/`pdftotext`/`pdfinfo`), vitest.

**Spec:** [docs/superpowers/specs/2026-07-21-document-uploads-design.md](../specs/2026-07-21-document-uploads-design.md)

## Global Constraints

- ESM throughout; **`.js` import specifiers** (NodeNext resolution).
- TypeScript `strict` + `noUncheckedIndexedAccess` — index access is `T | undefined`.
- **Only `finalResponse` reaches Telegram** — this feature changes only what goes *in*; never add a path from a tool item to a chat message.
- **Subscription-only** — no `OPENAI_API_KEY`, no OpenAI vision/audio API. Rasterization and extraction are local poppler, mirroring the local-whisper decision.
- **Engine boundary is the single seam to Codex** — the widened input stays behind `Engine`; `FakeEngine` must implement it so the daemon stays fully testable offline.
- `@openai/codex-sdk` stays pinned at `0.144.5` — do not change its version.
- **Public repo:** no secrets/identifiers in any committed file; `npm run audit` must pass before any push.
- Every task ends green: `npm run typecheck` and `npm test` pass.

---

### Task 1: Config keys

**Files:**
- Modify: `src/config.ts` (interface `PepperConfig`, `DEFAULTS`, parse body, validation)
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `PepperConfig.pdfMaxImagePages: number`, `PepperConfig.attachmentMaxBytes: number`, `PepperConfig.uploadsRetentionDays: number`.

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`:

```ts
it('defaults document-upload knobs and allows overrides', () => {
  const base = loadConfig(writeConfig({ ownerTelegramIds: [1] }));
  expect(base.pdfMaxImagePages).toBe(20);
  expect(base.attachmentMaxBytes).toBe(20 * 1024 * 1024);
  expect(base.uploadsRetentionDays).toBe(30);

  const over = loadConfig(
    writeConfig({ ownerTelegramIds: [1], pdfMaxImagePages: 5, uploadsRetentionDays: 7 }),
  );
  expect(over.pdfMaxImagePages).toBe(5);
  expect(over.uploadsRetentionDays).toBe(7);
});

it('rejects a non-positive pdfMaxImagePages', () => {
  expect(() => loadConfig(writeConfig({ ownerTelegramIds: [1], pdfMaxImagePages: 0 }))).toThrow(
    /pdfMaxImagePages/,
  );
});
```

> Reuse this file's existing `writeConfig` helper (it already writes a temp `pepper.config.json` and returns its path). If its shape differs, match the existing calls in the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts -t "document-upload knobs"`
Expected: FAIL — `pdfMaxImagePages` is `undefined`.

- [ ] **Step 3: Implement** — in `src/config.ts`:

Add to the `PepperConfig` interface (after `whisperModel?`):

```ts
  /** PDF pages rasterized to images per upload. pdftotext still extracts ALL pages' text. */
  pdfMaxImagePages: number;
  /** Reject uploads larger than this many bytes before downloading them. */
  attachmentMaxBytes: number;
  /** Delete workspace/uploads/<date>/ dirs older than this many days, on startup. */
  uploadsRetentionDays: number;
```

Add to `DEFAULTS`:

```ts
  pdfMaxImagePages: 20,
  attachmentMaxBytes: 20 * 1024 * 1024,
  uploadsRetentionDays: 30,
```

Add to the `cfg` object literal (alongside the other `num(...) ?? DEFAULTS...` fields):

```ts
    pdfMaxImagePages: num(c.pdfMaxImagePages) ?? DEFAULTS.pdfMaxImagePages,
    attachmentMaxBytes: num(c.attachmentMaxBytes) ?? DEFAULTS.attachmentMaxBytes,
    uploadsRetentionDays: num(c.uploadsRetentionDays) ?? DEFAULTS.uploadsRetentionDays,
```

Add validation (near the other range checks, before `return cfg;`):

```ts
  if (cfg.pdfMaxImagePages <= 0) throw new ConfigError('pdfMaxImagePages must be a positive integer.');
  if (cfg.attachmentMaxBytes < 1024) throw new ConfigError('attachmentMaxBytes must be at least 1024.');
  if (cfg.uploadsRetentionDays < 0) throw new ConfigError('uploadsRetentionDays must be >= 0.');
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): pdfMaxImagePages, attachmentMaxBytes, uploadsRetentionDays"
```

---

### Task 2: Engine boundary — `TurnInput` + `toSdkInput` + FakeEngine images

**Files:**
- Modify: `src/engine/types.ts` (add `TurnInput`, widen `runTurn`)
- Modify: `src/engine/codex/adapter.ts` (add `toSdkInput`, widen `runTurn`/`execute`, use helper)
- Modify: `src/engine/fake.ts` (widen `runTurn`, record `images` on `FakeTurn`)
- Test: `tests/adapter-options.test.ts` (pure `toSdkInput`)

**Interfaces:**
- Produces: `interface TurnInput { text: string; images?: string[] }`; `Engine.runTurn(chatKey: string, input: string | TurnInput, signal?): Promise<EngineResult>`; `toSdkInput(input: string | TurnInput): Input`; `FakeTurn.images: string[]`.
- Consumes (from SDK): `import { type Input } from '@openai/codex-sdk'` where `Input = string | ({type:'text';text:string} | {type:'local_image';path:string})[]`.

- [ ] **Step 1: Write the failing test** — append to `tests/adapter-options.test.ts`:

```ts
import { toSdkInput } from '../src/engine/codex/adapter.js';

describe('toSdkInput', () => {
  it('passes a plain string through unchanged', () => {
    expect(toSdkInput('hello')).toBe('hello');
  });

  it('passes a TurnInput with no images as its text string', () => {
    expect(toSdkInput({ text: 'hi' })).toBe('hi');
    expect(toSdkInput({ text: 'hi', images: [] })).toBe('hi');
  });

  it('builds a text block followed by one local_image per path, in order', () => {
    expect(toSdkInput({ text: 'look', images: ['/a.png', '/b.png'] })).toEqual([
      { type: 'text', text: 'look' },
      { type: 'local_image', path: '/a.png' },
      { type: 'local_image', path: '/b.png' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/adapter-options.test.ts -t "toSdkInput"`
Expected: FAIL — `toSdkInput` is not exported.

- [ ] **Step 3: Implement**

In `src/engine/types.ts`, add above `EngineResult`:

```ts
/** A turn's input: text, plus optional local image paths passed as `local_image` blocks. */
export interface TurnInput {
  text: string;
  images?: string[];
}
```

Change the `Engine.runTurn` signature:

```ts
  runTurn(chatKey: string, input: string | TurnInput, signal?: AbortSignal): Promise<EngineResult>;
```

In `src/engine/codex/adapter.ts`, extend the SDK import and add the helper (top level, exported, pure):

```ts
import { Codex, type Input, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { ContextExhaustedError, EngineAuthError, ThreadResumeError, type Engine, type EngineHealth, type EngineResult, type TurnInput } from '../types.js';

/** Map the Engine's input onto the Codex SDK's. A string (or text-only TurnInput)
 *  stays a string — the exact path every existing caller uses. Images become a
 *  text block followed by one `local_image` block per path. */
export function toSdkInput(input: string | TurnInput): Input {
  if (typeof input === 'string') return input;
  if (!input.images || input.images.length === 0) return input.text;
  return [{ type: 'text', text: input.text }, ...input.images.map((path) => ({ type: 'local_image' as const, path }))];
}
```

> Merge the new `type Input` and `type TurnInput` into the existing import lines rather than duplicating imports.

Widen `runTurn` and `execute` to accept `string | TurnInput`, and pass through `toSdkInput` in `execute`:

```ts
  async runTurn(chatKey: string, input: string | TurnInput, signal?: AbortSignal): Promise<EngineResult> {
```

In `execute`, change the param type and the `thread.run` call:

```ts
  private async execute(
    thread: Thread,
    input: string | TurnInput,
    chatKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<EngineResult> {
    let turn;
    try {
      turn = await thread.run(toSdkInput(input), signal ? { signal } : {});
```

> `runIsolated` keeps its `string` parameter — isolated jobs never carry images.

In `src/engine/fake.ts`, add `images` to `FakeTurn` and record it:

```ts
export interface FakeTurn {
  chatKey: string | null;
  input: string;
  images: string[];
  threadId: string;
}
```

```ts
  async runTurn(chatKey: string, input: string | { text: string; images?: string[] }, signal?: AbortSignal): Promise<EngineResult> {
    return this.exec(chatKey, input, signal);
  }
```

Change `exec` to normalise:

```ts
  private async exec(
    chatKey: string | null,
    input: string | { text: string; images?: string[] },
    signal?: AbortSignal,
  ): Promise<EngineResult> {
    // ...existing abort/delay/error guards unchanged...
    const text = typeof input === 'string' ? input : input.text;
    const images = typeof input === 'string' ? [] : (input.images ?? []);
    const threadId = chatKey ? (this.threads.get(chatKey) ?? this.newThread(chatKey)) : `isolated-${++this.seq}`;
    this.turns.push({ chatKey, input: text, images, threadId });
    return {
      text: await this.responder(text, chatKey),
      threadId,
      ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
    };
  }
```

> `runIsolated` calls `exec(null, input, signal)` with `input` still typed `string` — fine, the union accepts it. Import `TurnInput` if you prefer to type the param as `string | TurnInput` instead of the inline shape.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/adapter-options.test.ts && npm run typecheck`
Expected: PASS, no type errors. The full suite still passes because the string path is unchanged: `npx vitest run`.

- [ ] **Step 5: Commit**

```bash
git add src/engine/types.ts src/engine/codex/adapter.ts src/engine/fake.ts tests/adapter-options.test.ts
git commit -m "feat(engine): widen turn input to string | TurnInput (text + local_image paths)"
```

---

### Task 3: Queue coalescing with images

**Files:**
- Modify: `src/chat/queue.ts`
- Test: `tests/queue.test.ts`

**Interfaces:**
- Consumes: `TurnInput` from `../engine/types.js`.
- Produces: `TurnQueue.submit(input: string, images?: string[]): Promise<string>`; `TurnQueueOptions.run: (input: TurnInput, signal: AbortSignal) => Promise<string>`; `QueuedTurn.images: string[]`.

- [ ] **Step 1: Write the failing test** — append to `tests/queue.test.ts`:

```ts
it('coalesces text and concatenates image paths into one turn', async () => {
  const seen: import('../src/engine/types.js').TurnInput[] = [];
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
  const seen: import('../src/engine/types.js').TurnInput[] = [];
  const q = new TurnQueue({ timeoutMs: 1000, run: async (i) => (seen.push(i), 'ok') });
  await q.submit('hello');
  expect(seen[0]).toEqual({ text: 'hello', images: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/queue.test.ts -t "coalesces text and concatenates"`
Expected: FAIL — `run` currently receives a string, not `{ text, images }`.

- [ ] **Step 3: Implement** — rewrite the relevant parts of `src/chat/queue.ts`:

```ts
import { logger } from '../logger.js';
import type { TurnInput } from '../engine/types.js';

export interface QueuedTurn {
  inputs: string[];
  images: string[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export interface TurnQueueOptions {
  timeoutMs: number;
  run: (input: TurnInput, signal: AbortSignal) => Promise<string>;
}
```

`submit`:

```ts
  submit(input: string, images: string[] = []): Promise<string> {
    if (this.pending) {
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
```

In `drain`, change the run call:

```ts
        try {
          const text = await this.opts.run({ text: turn.inputs.join('\n'), images: turn.images }, ac.signal);
          turn.resolve(text);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/queue.test.ts`
Expected: PASS. (Existing text-only queue tests still pass; `run` now gets `{text, images}` — update any existing test in this file that asserted `run` received a bare string to read `input.text`.)

- [ ] **Step 5: Commit**

```bash
git add src/chat/queue.ts tests/queue.test.ts
git commit -m "feat(queue): coalesce image paths alongside text into one turn"
```

---

### Task 4: `attachments.ts` processor + `pruneUploads`

**Files:**
- Create: `src/chat/attachments.ts`
- Test: `tests/attachments.test.ts`

**Interfaces:**
- Produces:
  - `interface AttachmentInput { buffer: Buffer; filename: string; mime: string; caption?: string }`
  - `interface ProcessedAttachment { text: string; images: string[] }`
  - `type AttachmentProcessor = (input: AttachmentInput) => Promise<ProcessedAttachment>`
  - `function createAttachmentProcessor(opts: { workspacePath: string; pdfMaxImagePages: number; now?: () => Date }): AttachmentProcessor`
  - `function attachmentRefusal(sizeBytes: number | undefined, maxBytes: number): string | undefined`
  - `function pruneUploads(workspacePath: string, retentionDays: number, now?: () => Date): void`
  - `const BINARY_DOCUMENT_MIMES: Set<string>`

- [ ] **Step 1: Write the failing test** — create `tests/attachments.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentRefusal,
  BINARY_DOCUMENT_MIMES,
  createAttachmentProcessor,
  pruneUploads,
} from '../src/chat/attachments.js';

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'pepper-att-'));
}
function hasPoppler(): boolean {
  try { execFileSync('pdftoppm', ['-h'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// A minimal single-page PDF containing the text "PEPPER PDF OK".
const SAMPLE_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 18 Tf 20 100 Td (PEPPER PDF OK) Tj ET
endstream endobj
5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj
trailer<< /Root 1 0 R >>
%%EOF`,
  'latin1',
);

describe('attachmentRefusal', () => {
  it('accepts under the limit, refuses over', () => {
    expect(attachmentRefusal(1000, 2000)).toBeUndefined();
    expect(attachmentRefusal(undefined, 2000)).toBeUndefined();
    expect(attachmentRefusal(3000, 2000)).toMatch(/limit/);
  });
});

describe('createAttachmentProcessor routing', () => {
  it('saves an image and returns it as a local image path', async () => {
    const root = ws();
    const proc = createAttachmentProcessor({ workspacePath: root, pdfMaxImagePages: 20 });
    const res = await proc({ buffer: Buffer.from('pngbytes'), filename: 'cat.png', mime: 'image/png', caption: 'my cat' });
    expect(res.images).toHaveLength(1);
    expect(existsSync(res.images[0]!)).toBe(true);
    expect(res.text).toBe('my cat');
  });

  it('saves a docx but does not send it to the model', async () => {
    const root = ws();
    const proc = createAttachmentProcessor({ workspacePath: root, pdfMaxImagePages: 20 });
    const res = await proc({
      buffer: Buffer.from('PK...'),
      filename: 'q3.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    expect(res.images).toEqual([]);
    expect(res.text).toMatch(/can't read that format/i);
  });

  it('blocklist covers the common office/archive binaries', () => {
    expect(BINARY_DOCUMENT_MIMES.has('application/zip')).toBe(true);
    expect(BINARY_DOCUMENT_MIMES.has('application/vnd.ms-excel')).toBe(true);
    expect(BINARY_DOCUMENT_MIMES.has('application/pdf')).toBe(false); // PDF is handled, not blocked
  });
});

describe.skipIf(!hasPoppler())('createAttachmentProcessor PDF (needs poppler)', () => {
  it('rasterizes pages and extracts text', async () => {
    const root = ws();
    const proc = createAttachmentProcessor({ workspacePath: root, pdfMaxImagePages: 20 });
    const res = await proc({ buffer: SAMPLE_PDF, filename: 'doc.pdf', mime: 'application/pdf' });
    expect(res.images.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(res.images[0]!)).toBe(true);
    expect(res.text).toMatch(/PEPPER PDF OK/);
  });

  it('caps rasterized pages and notes the truncation', async () => {
    const root = ws();
    const proc = createAttachmentProcessor({ workspacePath: root, pdfMaxImagePages: 1 });
    // SAMPLE_PDF is 1 page, so no note; assert the cap is honoured (<= 1 image).
    const res = await proc({ buffer: SAMPLE_PDF, filename: 'doc.pdf', mime: 'application/pdf' });
    expect(res.images.length).toBeLessThanOrEqual(1);
  });
});

describe('pruneUploads', () => {
  it('deletes upload dirs older than the retention window and keeps recent ones', () => {
    const root = ws();
    const old = join(root, 'uploads', '2000-01-01');
    const recent = join(root, 'uploads', '2999-01-01');
    mkdirSync(old, { recursive: true });
    mkdirSync(recent, { recursive: true });
    const ancient = new Date('2000-01-01').getTime() / 1000;
    utimesSync(old, ancient, ancient);
    pruneUploads(root, 30);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});
```

> If poppler's strict parser rejects `SAMPLE_PDF`, regenerate a valid 1-page fixture during implementation (`pdftoppm`/`pdfinfo` must succeed on it) and inline the bytes; the parser is lenient and usually recovers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/attachments.test.ts`
Expected: FAIL — `src/chat/attachments.ts` does not exist.

- [ ] **Step 3: Implement** — create `src/chat/attachments.ts`:

```ts
import { execFile, execFileSync } from 'node:child_process';
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

function pdfPageCount(pdfPath: string): number {
  try {
    const out = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    const m = out.match(/^Pages:\s+(\d+)/m);
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
  const pages = pdfPageCount(pdfPath);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/attachments.test.ts && npm run typecheck`
Expected: PASS (PDF block skipped if poppler absent).

- [ ] **Step 5: Commit**

```bash
git add src/chat/attachments.ts tests/attachments.test.ts
git commit -m "feat(chat): attachment processor (image→vision, pdf→rasterize+extract, binaries saved) + prune"
```

---

### Task 5: Gateway `message:document` / `message:photo` handler

**Files:**
- Modify: `src/chat/gateway.ts` (`GatewayDeps`, new handler)
- Test: none new — the grammY handler follows the existing voice-handler precedent (untested at the gateway layer; its logic is covered by `attachments.test.ts` and the Task 8 spike). Do NOT invent a heavy grammY-context mock.

**Interfaces:**
- Consumes: `AttachmentProcessor`, `attachmentRefusal` from `./attachments.js`.
- Produces: `GatewayDeps.onMessage: (chatId: number, text: string, images?: string[]) => Promise<string>`; `GatewayDeps.attachments: AttachmentProcessor`; `GatewayDeps.attachmentMaxBytes: number`.

- [ ] **Step 1: Implement** — in `src/chat/gateway.ts`:

Update the import and `GatewayDeps`:

```ts
import { attachmentRefusal, type AttachmentProcessor } from './attachments.js';
```

```ts
  /** Handle a normal (non-command) message. Returns the reply, or '' for none. */
  onMessage: (chatId: number, text: string, images?: string[]) => Promise<string>;
  // ...existing fields...
  /** Turn an uploaded file into text + local image paths. */
  attachments: AttachmentProcessor;
  /** Reject uploads larger than this before downloading. */
  attachmentMaxBytes: number;
```

Add the handler in the constructor, next to the voice handler (after it):

```ts
    // Documents & photos: download, run through the attachment processor, then
    // feed the result through the SAME onMessage path as text — coalescing and
    // the turn queue apply unchanged. Images become local_image (vision); PDFs
    // become page images + extracted text; office binaries are saved, not sent.
    this.bot.on(['message:document', 'message:photo'], async (ctx) => {
      const doc = ctx.message.document;
      const photo = doc ? undefined : ctx.message.photo?.[ctx.message.photo.length - 1];
      const sizeBytes = doc?.file_size ?? photo?.file_size;

      const refusal = attachmentRefusal(sizeBytes, this.deps.attachmentMaxBytes);
      if (refusal) {
        await this.reply(ctx, refusal);
        return;
      }
      try {
        await ctx.replyWithChatAction('typing').catch(() => {});
        const file = await ctx.getFile();
        if (!file.file_path) throw new Error('Telegram returned no file path');
        const res = await fetch(`https://api.telegram.org/file/bot${this.deps.token}/${file.file_path}`);
        if (!res.ok) throw new Error(`file download failed (${res.status})`);
        const buffer = Buffer.from(await res.arrayBuffer());

        const { text, images } = await this.deps.attachments({
          buffer,
          filename: doc?.file_name ?? (photo ? 'photo.jpg' : 'file'),
          mime: doc?.mime_type ?? (photo ? 'image/jpeg' : ''),
          ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
        });

        await ctx.replyWithChatAction('typing').catch(() => {});
        const reply = await this.deps.onMessage(ctx.chat.id, text, images);
        if (reply) await this.reply(ctx, reply);
      } catch (e) {
        const err = e as Error;
        logger.error({ err: err.message }, 'attachment handling failed');
        await this.reply(
          ctx,
          err.name === 'AbortError' ? 'That took too long, so I stopped it.' : "I couldn't read that file — try again?",
        );
      }
    });
```

> `this.deps.token` already exists on `GatewayDeps` and is used by the voice handler — reuse it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`ctx.message.photo` is `PhotoSize[] | undefined`; `noUncheckedIndexedAccess` makes the last-element access `PhotoSize | undefined`, which the `?.` handles.)

- [ ] **Step 3: Run the suite**

Run: `npx vitest run`
Expected: PASS — unchanged (no gateway unit tests; nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add src/chat/gateway.ts
git commit -m "feat(gateway): handle message:document and message:photo uploads"
```

---

### Task 6: Wire pepperd, workspace uploads dir, gitignore, AGENTS.md note

**Files:**
- Modify: `src/pepperd.ts` (`runOnMain` → `TurnInput`, `onMessage` passes images, gateway deps, isolated run, prune call, imports)
- Modify: `src/workspace.ts` (add `uploads` to the subdir list)
- Modify: `workspace.template/.gitignore` (add `uploads/`)
- Modify: `workspace.template/AGENTS.md` (one line describing how uploads arrive)
- Test: rely on `tests/integration.test.ts` (FakeEngine) staying green

**Interfaces:**
- Consumes: `createAttachmentProcessor`, `pruneUploads` from `./chat/attachments.js`; `TurnInput` from `./engine/types.js`.

- [ ] **Step 1: Implement pepperd wiring**

Add imports in `src/pepperd.ts`:

```ts
import { createAttachmentProcessor, pruneUploads } from './chat/attachments.js';
import { ContextExhaustedError, EngineAuthError, type Engine, type TurnInput } from './engine/types.js';
```

> Merge `type TurnInput` into the existing `./engine/types.js` import line.

Change `runOnMain` to take a `TurnInput` and carry images through (including the retry). Replace the whole function signature and its body references to `prompt`:

```ts
  async function runOnMain(input: TurnInput, signal: AbortSignal): Promise<string> {
    const text = isNewThread(MAIN_CHAT_KEY)
      ? firstTurnInput(cfg, input.text)
      : withDateHeader(input.text, cfg.timezone);
    const turnInput: TurnInput = { text, ...(input.images && input.images.length ? { images: input.images } : {}) };
    try {
      const res = await engine.runTurn(MAIN_CHAT_KEY, turnInput, signal);
      // ...thread-hygiene block unchanged...
    } catch (err) {
      if (err instanceof ContextExhaustedError) {
        logger.warn('context exhausted — resetting thread');
        await resetMainThread();
        const retry: TurnInput = {
          text: firstTurnInput(cfg, input.text),
          ...(input.images && input.images.length ? { images: input.images } : {}),
        };
        const res = await engine.runTurn(MAIN_CHAT_KEY, retry, signal);
        return `_(Started a fresh thread — the old one got too long. My notes and memory carried over.)_\n\n${res.text}`;
      }
      // ...EngineAuthError branch unchanged...
      throw err;
    }
  }
```

> Keep the thread-hygiene / nudge / rotate block between the two edits exactly as-is; only the input construction and the retry changed.

Update the isolated queue's `run` (it now receives a `TurnInput`):

```ts
  const isolatedQueue = new TurnQueue({
    timeoutMs: cfg.turnTimeoutMs,
    run: async (input, signal) => (await engine.runIsolated(firstTurnInput(cfg, input.text), signal)).text,
  });
```

Update the gateway deps — `onMessage` forwards images, and add the two new deps:

```ts
    onMessage: (_chatId, text, images) => queue.submit(text, images),
```

```ts
    attachments: createAttachmentProcessor({ workspacePath: cfg.workspacePath, pdfMaxImagePages: cfg.pdfMaxImagePages }),
    attachmentMaxBytes: cfg.attachmentMaxBytes,
```

Add the startup prune right after `initWorkspace(...)`:

```ts
  const ws = initWorkspace(cfg, configPath);
  pruneUploads(cfg.workspacePath, cfg.uploadsRetentionDays);
```

- [ ] **Step 2: Implement workspace + template changes**

In `src/workspace.ts`, add `uploads` to the subdir list:

```ts
  for (const sub of ['notes', 'skills', 'tools', 'run', 'uploads']) {
    mkdirSync(join(cfg.workspacePath, sub), { recursive: true });
  }
```

In `workspace.template/.gitignore`, append:

```
# Inbound file uploads (runtime data, not behaviour history)
uploads/
```

In `workspace.template/AGENTS.md`, add one line wherever inbound-message handling is described (e.g. near any note about voice transcripts):

```
- Uploaded files arrive as text: images come through as pictures you can see; a PDF arrives as page images plus its extracted text (prefer the text, use the images for layout/figures or scanned pages); other formats (docx, xlsx, zip…) are saved to `uploads/` but not readable inline — tell the owner if you need them in another form.
```

- [ ] **Step 3: Typecheck and run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. If `tests/integration.test.ts` constructs a gateway or its deps directly and now misses `attachments`/`attachmentMaxBytes`, add them there (`attachments: createAttachmentProcessor({ workspacePath: <tmp>, pdfMaxImagePages: 20 })`, `attachmentMaxBytes: 20*1024*1024`). If it drives `onMessage`/`runOnMain` with a bare string, update those call sites to pass `{ text, images: [] }` where `runOnMain` is called, and `(chatId, text)` still works for `onMessage` (images optional).

- [ ] **Step 4: Build to confirm the composition root compiles**

Run: `npm run build`
Expected: PASS — `dist/` emitted with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pepperd.ts src/workspace.ts workspace.template/.gitignore workspace.template/AGENTS.md
git commit -m "feat(pepperd): wire attachment uploads end-to-end + uploads dir/gitignore/prune"
```

---

### Task 7: Provisioning — install poppler-utils on the box

**Files:**
- Modify: `terraform/modules/pepper/user_data/init.sh.tftpl` (apt install list)

**Interfaces:** none (infra only).

- [ ] **Step 1: Implement** — in `init.sh.tftpl`, add `poppler-utils` to the `apt-get install -y` list (line ~33):

```sh
apt-get install -y \
  ca-certificates curl unzip jq git sqlite3 \
  build-essential python3 \
  ufw fail2ban unattended-upgrades \
  ripgrep poppler-utils
```

- [ ] **Step 2: Validate the template renders**

Run: `cd terraform/modules/pepper && terraform fmt -check user_data/init.sh.tftpl; cd -`
Expected: no formatting error (the `.tftpl` is a template; `terraform fmt` won't touch the shell body — this is a sanity check that nothing else broke). If terraform isn't installed locally, skip and eyeball the diff.

- [ ] **Step 3: Commit**

```bash
git add terraform/modules/pepper/user_data/init.sh.tftpl
git commit -m "infra: install poppler-utils for PDF rasterization/extraction"
```

---

### Task 8: Spike verification — does Codex actually see `local_image`?

**Files:**
- Modify: `src/spike.ts` (or the existing spike entrypoint — confirm the filename with `grep -l spike package.json && cat package.json | grep spike`) OR document a manual check in `docs/spike-findings.md`.

**Interfaces:** none — this is the honesty gate before trusting vision. Requires a real `codex login`.

- [ ] **Step 1: Identify the spike entrypoint**

Run: `grep -n '"spike"' package.json`
Expected: shows the script (e.g. `tsx src/spike.ts`). Open that file to see how it constructs a `Codex`/`Thread`.

- [ ] **Step 2: Add a vision probe to the spike**

Add a step that rasterizes the sample PDF (or writes a tiny PNG containing a known word) and runs a turn with a `local_image` input, asserting the reply mentions the known content:

```ts
// after a normal text-turn probe:
const png = /* path to an image whose content is known, e.g. rasterized SAMPLE_PDF page 1 */;
const turn = await thread.run([
  { type: 'text', text: 'What word is written in this image? Answer with just the word.' },
  { type: 'local_image', path: png },
]);
console.log('vision reply:', turn.finalResponse);
// Manual pass criterion: finalResponse contains the known word (e.g. "PEPPER").
```

- [ ] **Step 3: Run the spike against real Codex**

Run: `npm run spike`
Expected: the vision reply names the known word. If it does NOT (Codex ignores `local_image` on the subscription), STOP — the vision route is unavailable and the PDF path must fall back to text-only (`pdftotext`) — record that in `docs/spike-findings.md` and open a follow-up. This is the assumption the whole image route rests on.

- [ ] **Step 4: Record the finding**

Add a line to `docs/spike-findings.md` stating whether subscription Codex honours `local_image`, dated, with the model slug used.

- [ ] **Step 5: Commit**

```bash
git add src/spike.ts docs/spike-findings.md
git commit -m "spike: verify Codex local_image vision on the subscription"
```

---

## Self-Review

**Spec coverage:**
- Routing table (image/pdf/binary/unknown) → Task 4 (processor) + Task 5 (gateway dispatch). ✓
- `attachments.ts` mirroring `transcribe.ts`, optional poppler, polite degradation → Task 4. ✓
- Engine boundary `string | TurnInput`, string path unchanged, `toSdkInput`, FakeEngine records images → Task 2. ✓
- Queue coalescing carries images → Task 3. ✓
- Config `pdfMaxImagePages` (20), `attachmentMaxBytes` (20 MB), `uploadsRetentionDays` (30) → Task 1. ✓
- Storage under `workspace/uploads/<date>/`, gitignored in workspace, kept + startup prune → Task 4 (prune) + Task 6 (dir, gitignore, prune call). ✓
- Provisioning poppler-utils → Task 7. ✓
- Size cap (20 MB) refusal before download → Task 4 (`attachmentRefusal`) + Task 5 (gateway uses it). ✓
- Spike verifying `local_image` vision → Task 8. ✓
- Invariants (only finalResponse out, one-turn-in-flight, Engine seam, subscription-only) → preserved by construction; no task weakens them. ✓
- AGENTS.md note so the model uses both text+images → Task 6. ✓ (small addition beyond the spec's letter, within its spirit.)

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The only conditional is the poppler-guarded PDF test block, which is explicit. ✓

**Type consistency:** `TurnInput { text; images? }` defined in Task 2, consumed identically in Tasks 3 (`run`), 5/6 (wiring). `AttachmentProcessor`/`AttachmentInput`/`ProcessedAttachment` defined in Task 4, consumed in Task 5 with matching field names (`buffer`, `filename`, `mime`, `caption`; `text`, `images`). `attachmentRefusal(sizeBytes, maxBytes)` signature matches its Task 5 call. `createAttachmentProcessor({ workspacePath, pdfMaxImagePages, now? })` matches Task 6's call. `pruneUploads(workspacePath, retentionDays)` matches Task 6's call. ✓
