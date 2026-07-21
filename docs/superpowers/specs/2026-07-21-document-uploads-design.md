# Document & image uploads over Telegram — design

**Date:** 2026-07-21
**Status:** Approved design, pre-implementation
**Motivating bug:** Owner uploaded a PDF via Telegram; Pepper replied she couldn't read it. Investigation showed the gateway has **no handler for `message:document` or `message:photo`** — such updates pass the allowlist middleware and are then silently dropped (no queue, no Engine, no log). The reply came from an empty context.

## Goal

Let the owner send a PDF or an image over Telegram and have Pepper actually read it, using the same path as typed text (coalescing, turn queue, and every invariant apply unchanged).

## The binding constraint

Pepper does not call a model API directly — it goes through the Codex SDK. The SDK's turn input is:

```ts
type UserInput = { type: "text"; text: string } | { type: "local_image"; path: string };
type Input = string | UserInput[];
```

There is **no document/PDF input type**. The model can be handed text or a local image path, and nothing else. This is why we can't copy OpenClaw's approach directly (see below): a PDF cannot be handed to the model as a document. It must be turned into text and/or images first.

## Precedent (what OpenClaw / Hermes actually do)

- **Hermes (pepper2):** only infrastructure survives in this tree — no chat-app source. No precedent to copy; it's the lineage Pepper replaced.
- **OpenClaw (`openclaw-extensions/gupshup`, its WhatsApp channel):** on inbound media it (1) builds a text label (`[media attached: <filename>]` or the caption), (2) downloads the file with a size cap, (3) **blocks binary office formats from the LLM entirely** — docx/xlsx/pptx/doc/xls/ppt/odt/ods/odp/zip/tar/7z/rar/gzip/epub/octet-stream are saved as assets but never sent, and (4) passes everything else — images **and PDFs** — to the model as a native document/image content block.

OpenClaw's step 4 works because it talks to a raw model API with a native PDF document type. **Codex has no such type**, so we adopt OpenClaw's *hybrid routing and its office-binary blocklist verbatim*, but replace "native PDF document block" with "rasterize to images + extract text," which is the only route the SDK leaves open.

## Routing

A new gateway handler for `message:document` **and** `message:photo`, routing by MIME type:

| Upload | Handling | Sent to the model |
|---|---|---|
| Photo / image document (jpg, png, webp, gif, …) | save to workspace | `local_image` (vision) |
| **PDF** | save + `pdftoppm` rasterize first N pages → PNGs + `pdftotext` extract whole doc | **both**: one text block (all pages) + one `local_image` per rasterized page — Codex chooses |
| Binary office (docx, xlsx, zip, …) | save only | **not sent** — Pepper replies "saved it, but I can't read that format inline" |
| Unknown / octet-stream | save only | not sent — acknowledged with the saved path |

The office-binary blocklist is copied from OpenClaw's `BINARY_DOCUMENT_MIMES`.

## Components

### `src/chat/attachments.ts` (new)

Standalone module mirroring [`src/chat/transcribe.ts`](../../../src/chat/transcribe.ts) — same "optional dependency, degrade politely" shape. Pure enough to unit-test.

- Input: the downloaded buffer + metadata `{ filename, mime, sizeBytes, caption }` and the workspace path.
- Output: `{ text: string; images: string[] }` where `images` are **absolute paths** to local image files.
- Behaviour by type:
  - **image** → save to `workspace/uploads/<date>/`, return `{ text: caption || "[image: <name>]", images: [savedPath] }`.
  - **pdf** → `pdfinfo` for page count; `pdftoppm -png -r 150 -f 1 -l N <pdf> <prefix>` for the first N pages; `pdftotext -layout <pdf> -` for the entire document's text. Return `{ text: label + "\n\n" + extractedText, images: [png paths…] }`. If page count > N, append a note: *"Showing the first N of M pages as images; full text extracted below."* If `pdftotext` yields effectively no text (a scanned PDF), the images carry the content — that's the point of rasterizing.
  - **binary office / unknown** → save the original, return `{ text: "[saved uploads/<date>/<name> — <mime>, not readable inline]", images: [] }`.
- **Dependency detection:** `pdftoppm`, `pdftotext`, `pdfinfo` are looked up on `PATH` (poppler installs them there, unlike whisper's bundled binary+model). If poppler is absent, PDFs get a polite "I can't read PDFs on this deployment yet" reply — exactly the voice fallback. Images need no external tool and always work.
- **Refusal guard** (mirrors `voiceRefusal`): refuse before download when `sizeBytes > attachmentMaxBytes` (default 20 MB).

### `src/chat/gateway.ts` (extend)

Add `this.bot.on(['message:document', 'message:photo'], handler)`. The handler runs *after* the existing allowlist/private-chat middleware (unchanged), then:

1. If `deps.attachments` is absent → polite "can't handle files on this deployment" reply.
2. Apply the size refusal; reply and stop if it trips.
3. Download the file (same mechanism as voice: `ctx.getFile()` + fetch to the Telegram file API with the bot token).
4. For `message:photo`, pick the largest `PhotoSize`; for `message:document`, use `ctx.message.document` (filename + mime).
5. Call the attachment processor → `{ text, images }`.
6. `await deps.onMessage(ctx.chat.id, text, images)` and reply as usual (typing indicator, chunked HTML reply — reuse `this.reply`).

Errors are logged and answered with a friendly failure, matching the voice handler's `catch`.

### Engine boundary (extend — the load-bearing change)

Today: `runTurn(chatKey: string, input: string, signal?)`. Widen the input to a small union, in `src/engine/types.ts`:

```ts
export interface TurnInput {
  text: string;
  /** Absolute paths to local image files → passed as `local_image` blocks. */
  images?: string[];
}

runTurn(chatKey: string, input: string | TurnInput, signal?): Promise<EngineResult>;
```

Invariants preserved:

- **The string path is byte-for-byte unchanged.** Scheduler, isolated jobs, `pepperctl`, retry paths, and every existing test keep passing plain strings and hit identical code. Only an image-bearing chat turn constructs a `TurnInput`.
- `CodexEngine.execute` maps the input via a small pure helper `toSdkInput`: a string (or a `TurnInput` with no images) is passed straight through as today; with images it becomes `[{ type: 'text', text }, ...images.map(path => ({ type: 'local_image', path }))]`.
- **"Only `finalResponse` escapes" is untouched** — this changes only what goes *in*, never what comes *out*.
- `FakeEngine` normalises to `text` for its responder and records `images` on `FakeTurn`, so integration tests assert image paths threaded end-to-end with **no network** — the whole-daemon-testable property holds.

### Queue coalescing (extend — preserve one-turn-in-flight)

`TurnQueue` accumulates `inputs: string[]` today and joins with `\n`. Extend it to also accumulate `images: string[]`, and change `submit(text, images?)`. Mid-turn a caption + a PDF a second apart **coalesce into one next turn** — text joined, image paths concatenated — the same invariant that stops answer-bleed. The queue's `run` callback receives a `TurnInput` (`{ text: inputs.join('\n'), images }`); the isolated queue reads `.text` (jobs never carry images).

`GatewayDeps.onMessage` becomes `(chatId, text, images?) => Promise<string>`. In `pepperd`, `runOnMain` applies the date-header / standing-context wrap to `.text` and carries `.images` alongside — **including on the `ContextExhaustedError` retry path**, which must rebuild `{ text: firstTurnInput(cfg, input.text), images: input.images }` rather than dropping the images.

## Configuration

New keys (camelCase, mirroring existing config style; numeric defaults in `DEFAULTS`):

- `pdfMaxImagePages` — pages to rasterize as images. **Default 20.** Text extraction always covers the whole document regardless.
- `attachmentMaxBytes` — refuse uploads larger than this. **Default 20 MB.**
- `uploadsRetentionDays` — prune uploads older than this. **Default 30.**

No config for poppler binaries — detected on `PATH`. Uploads dir is derived (`<workspacePath>/uploads/`), not configured.

## Storage & retention

- Uploads (originals + rasterized PNGs) go under `workspace/uploads/<YYYY-MM-DD>/`. Inside the sandbox, so Codex can also shell to the original if it wants. **Gitignored in the workspace's local git** (the AGENTS.md-integrity repo) so uploads don't clutter that history.
- **Kept**, so the owner and Codex can refer back ("that PDF I sent"). A simple age-based prune (delete `uploads/<date>/` dirs older than `uploadsRetentionDays`) runs on daemon startup — small, bounded, non-blocking. Files must persist at least through the turn because `local_image` reads a path at `thread.run` time; startup-only pruning never races a live turn.

## Provisioning

`poppler-utils` (one apt package: `pdftoppm` + `pdftotext` + `pdfinfo`) added to the box wherever ffmpeg/whisper are installed (user_data / setup docs). If it's absent the feature degrades to images-only + a polite PDF refusal; it does not break the daemon.

## Testing

- **`attachments.ts` unit tests:** MIME routing (image / pdf / office-binary / unknown), the office-binary blocklist, size refusal, poppler-absent degradation, page-cap note when `pages > pdfMaxImagePages`, scanned-PDF (empty pdftotext) still returns images. Use a tiny fixture PDF and image; skip poppler-dependent assertions when the binaries are absent so CI without poppler still passes.
- **`queue.ts` unit tests:** coalescing merges text *and* concatenates image paths; depth/busy semantics unchanged for text-only.
- **`toSdkInput` unit test:** string → string; `TurnInput` no images → string; `TurnInput` with images → text block + one `local_image` per path in order.
- **Integration (FakeEngine):** a simulated document update threads image paths through gateway → queue → Engine and they appear on `FakeTurn.images`, with no network.
- **Spike (real Codex, honest-about-unverified):** confirm the subscription Codex model actually *sees* a `local_image` input and can answer a question about its contents. This is the one assumption the SDK type implies but that hasn't been run; it gates trusting the feature, consistent with the repo's stance on unverified behaviour.

## Invariants touched — and why each stays intact

- **Only `finalResponse` reaches Telegram** — unchanged; this is input-only.
- **One turn in flight; mid-turn coalesce** — preserved; the queue now coalesces images too.
- **Engine boundary is the single seam to Codex** — respected; the widened input is still behind `Engine`, and `FakeEngine` implements it, so the daemon stays fully testable offline.
- **Subscription-only billing guard** — untouched; no API key, no OpenAI audio/vision API — rasterization and extraction are local poppler, mirroring the local-whisper decision for voice.

## Out of scope (YAGNI)

- Office-binary *content* extraction (docx→text etc.) — save + acknowledge only, as OpenClaw does.
- Rasterizing more than `pdfMaxImagePages`; long PDFs rely on the full text extraction.
- Video/audio-file *documents* (voice is already handled; audio-as-document is rare and can reuse the transcriber later if wanted).
- OCR beyond what the vision model itself does on a rasterized page.
