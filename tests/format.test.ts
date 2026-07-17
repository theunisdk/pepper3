import { describe, expect, it } from 'vitest';
import { markdownToTelegramHtml, renderReply, splitForTelegram, TELEGRAM_LIMIT } from '../src/chat/format.js';

describe('markdownToTelegramHtml', () => {
  it('escapes HTML in plain prose', () => {
    expect(markdownToTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('does not interpret markup inside code fences', () => {
    const out = markdownToTelegramHtml('```\n**not bold** <tag>\n```');
    expect(out).toContain('<pre><code>**not bold** &lt;tag&gt;</code></pre>');
  });

  it('converts bold, italics, inline code and links', () => {
    expect(markdownToTelegramHtml('**b**')).toBe('<b>b</b>');
    expect(markdownToTelegramHtml('*i*')).toBe('<i>i</i>');
    expect(markdownToTelegramHtml('`x`')).toContain('<code>x</code>');
    expect(markdownToTelegramHtml('[t](https://e.com)')).toBe('<a href="https://e.com">t</a>');
  });

  it('leaves intra-word underscores alone', () => {
    expect(markdownToTelegramHtml('some_var_name')).toBe('some_var_name');
  });
});

describe('splitForTelegram', () => {
  it('leaves short text as one chunk', () => {
    expect(splitForTelegram('hello')).toEqual(['hello']);
  });

  it('prefers paragraph boundaries', () => {
    const a = 'a'.repeat(3000);
    const b = 'b'.repeat(3000);
    const chunks = splitForTelegram(`${a}\n\n${b}`);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(a);
    expect(chunks[1]).toBe(b);
  });

  it('hard-splits a single oversized paragraph rather than dropping it', () => {
    // The naive implementation loses content here.
    const chunks = splitForTelegram('x'.repeat(10_000));
    expect(chunks.join('')).toHaveLength(10_000);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
  });
});

describe('renderReply', () => {
  it('returns nothing for an empty reply', () => {
    expect(renderReply('   ').chunks).toEqual([]);
  });

  it('repairs a code fence severed by a split', () => {
    const { chunks } = renderReply('```\n' + 'y'.repeat(9000) + '\n```');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const opens = (c.match(/<pre>/g) ?? []).length;
      const closes = (c.match(/<\/pre>/g) ?? []).length;
      // Telegram rejects the whole message if tags are unbalanced.
      expect(opens).toBe(closes);
    }
  });
});
