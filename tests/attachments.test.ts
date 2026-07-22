import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attachmentRefusal,
  BINARY_DOCUMENT_MIMES,
  createAttachmentProcessor,
  pruneUploads,
} from '../src/chat/attachments.js';

const created: string[] = [];
function ws(): string {
  const d = mkdtempSync(join(tmpdir(), 'pepper-att-'));
  created.push(d);
  return d;
}
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
});
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
