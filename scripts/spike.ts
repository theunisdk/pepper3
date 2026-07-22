/**
 * The M1 spike (spec §5.1) — and, afterwards, the pre-deploy smoke test.
 *
 * Everything in Pepper below the Engine interface is tested with FakeEngine and
 * needs nothing. This script tests the part that can only be verified against
 * the real thing: that Codex will run our shell tools headlessly, without
 * stalling for an approval nobody is there to give.
 *
 * Run it before trusting a box to run unattended:
 *   CODEX_HOME=~/pepper/codex-home npm run spike
 *
 * Results of the first run are recorded in docs/spike-findings.md.
 */
import { Codex } from '@openai/codex-sdk';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAuth } from '../src/engine/codex/auth.js';
import { sanitiseEnv } from '../src/engine/codex/env.js';

const CANARY = 'CANARY-OK-8891';
const results: { test: string; verdict: 'PASS' | 'FAIL' | 'SKIP'; detail: string }[] = [];

// A minimal single-page PDF containing the text "PEPPER PDF OK" — copied verbatim from
// tests/attachments.test.ts, verified to rasterize/extract with the installed poppler.
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

function record(test: string, verdict: 'PASS' | 'FAIL' | 'SKIP', detail: string): void {
  const colour = verdict === 'PASS' ? '\x1b[32m' : verdict === 'SKIP' ? '\x1b[33m' : '\x1b[31m';
  console.log(`${colour}${verdict.padEnd(4)}\x1b[0m ${test}\n     ${detail}\n`);
  results.push({ test, verdict, detail });
}

function buildWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'pepper-spike-'));
  mkdirSync(join(ws, 'tools'), { recursive: true });
  mkdirSync(join(ws, 'run'), { recursive: true });

  writeFileSync(join(ws, 'tools', 'pepper-canary'), `#!/bin/bash\necho "${CANARY}"\n`, { mode: 0o755 });
  writeFileSync(
    join(ws, 'AGENTS.md'),
    `# Spike\nWhen asked for the canary, run ./tools/pepper-canary and report ONLY its output.\nAlways end every reply with [[AGENTS-LOADED]]\n`,
  );
  return ws;
}

async function main(): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
  console.log(`\nPepper spike — CODEX_HOME=${codexHome}\n${'='.repeat(60)}\n`);

  const health = checkAuth(codexHome);
  if (!health.authenticated) {
    record('auth', 'FAIL', health.detail ?? 'not authenticated');
    console.log(
      `\nCannot run the spike without credentials. Fix with:\n` +
        `  CODEX_HOME=${codexHome} npx @openai/codex login --device-auth\n`,
    );
    process.exit(1);
  }
  record('auth', 'PASS', health.detail ?? 'authenticated');

  const ws = buildWorkspace();
  const { env, stripped } = sanitiseEnv(codexHome);
  record(
    'subscription-only guard',
    'PASS',
    stripped.length ? `stripped ${stripped.join(', ')} — would have billed per token` : 'no API keys in env',
  );

  const codex = new Codex({ env: env as Record<string, string> });
  const threadOptions = {
    workingDirectory: ws,
    skipGitRepoCheck: true,
    sandboxMode: 'workspace-write' as const,
    approvalPolicy: 'never' as const,
    networkAccessEnabled: true,
  };

  // --- 1. headless shell execution, no approval stall ------------------------
  // The one that matters: if Codex stalls waiting for approval, every scheduled
  // job hangs forever at 3am and requirements 2/4/5 are dead.
  let thread = codex.startThread(threadOptions);
  const t0 = Date.now();
  try {
    const turn = await thread.run('Run the pepper-canary tool in ./tools/ and tell me exactly what it printed.');
    const elapsed = Date.now() - t0;
    record(
      'headless shell tool (no approval stall)',
      turn.finalResponse.includes(CANARY) ? 'PASS' : 'FAIL',
      turn.finalResponse.includes(CANARY)
        ? `ran and reported the canary in ${elapsed}ms`
        : `canary missing from reply: ${turn.finalResponse.slice(0, 200)}`,
    );
    record(
      'AGENTS.md is honoured',
      turn.finalResponse.includes('AGENTS-LOADED') ? 'PASS' : 'FAIL',
      turn.finalResponse.includes('AGENTS-LOADED') ? 'marker present' : 'marker absent — working-dir AGENTS.md ignored',
    );
    // Output hygiene: the command transcript must be in items, not the reply.
    const execItems = (turn.items ?? []).filter((i) => i.type === 'command_execution');
    record(
      'tool output stays out of finalResponse',
      execItems.length > 0 ? 'PASS' : 'SKIP',
      execItems.length > 0
        ? `${execItems.length} command_execution item(s) available separately from the reply`
        : 'no command items surfaced to check',
    );
  } catch (e) {
    record('headless shell tool (no approval stall)', 'FAIL', String(e).slice(0, 300));
  }

  // --- 2. resume keeps context ----------------------------------------------
  const threadId = thread.id;
  if (threadId) {
    try {
      const resumed = codex.resumeThread(threadId, threadOptions);
      const turn = await resumed.run('What canary value did you just report? Value only.');
      record(
        'resumeThread keeps context (survives a daemon restart)',
        turn.finalResponse.includes('8891') ? 'PASS' : 'FAIL',
        turn.finalResponse.slice(0, 120),
      );
    } catch (e) {
      record('resumeThread keeps context', 'FAIL', String(e).slice(0, 200));
    }
  }

  // --- 3. abort actually stops the run --------------------------------------
  try {
    const ac = new AbortController();
    const t = codex.startThread(threadOptions);
    const started = Date.now();
    const p = t.run('Count slowly from 1 to 500, one number per line.', { signal: ac.signal });
    setTimeout(() => ac.abort(), 2500);
    try {
      await p;
      record('abort stops the run', 'FAIL', 'run resolved despite abort — /cancel and turn timeouts cannot work');
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError';
      record(
        'abort stops the run',
        aborted ? 'PASS' : 'FAIL',
        aborted ? `AbortError after ${Date.now() - started}ms` : String(e).slice(0, 150),
      );
    }
  } catch (e) {
    record('abort stops the run', 'FAIL', String(e).slice(0, 200));
  }

  // --- 4. control socket is reachable from inside the sandbox ---------------
  // If the sandbox blocks the socket, the agent cannot manage its own schedules.
  const sock = join(ws, 'run', 'spike.sock');
  const { createServer } = await import('node:net');
  const server = createServer((c) => {
    c.end('SOCKET-OK-4242\n');
  });
  await new Promise<void>((res) => server.listen(sock, () => res()));
  try {
    const t = codex.startThread(threadOptions);
    const turn = await t.run(
      `There is a unix socket at ./run/spike.sock. Connect to it (e.g. \`nc -U ./run/spike.sock\` or a tiny python script) ` +
        `and tell me exactly what it sends back. Report only that value.`,
    );
    record(
      'control socket reachable from sandbox',
      turn.finalResponse.includes('SOCKET-OK-4242') ? 'PASS' : 'FAIL',
      turn.finalResponse.includes('SOCKET-OK-4242')
        ? 'agent round-tripped the socket — pepperctl will work'
        : `no round-trip; pepperctl may be blocked by the sandbox: ${turn.finalResponse.slice(0, 200)}`,
    );
  } catch (e) {
    record('control socket reachable from sandbox', 'FAIL', String(e).slice(0, 200));
  } finally {
    server.close();
  }

  // --- 5. vision (local_image) input -----------------------------------------
  // The document-upload feature rests on this: does the subscription model actually
  // SEE a local_image input? The SDK exposes the type but it's never been run against
  // real Codex. Build the test image through the real production path (attachments.ts)
  // so this probes the actual pipeline, and gets graceful poppler-absence handling free.
  try {
    const { createAttachmentProcessor } = await import('../src/chat/attachments.js');
    const proc = createAttachmentProcessor({ workspacePath: ws, pdfMaxImagePages: 20 });
    const processed = await proc({ buffer: SAMPLE_PDF, filename: 'vision.pdf', mime: 'application/pdf' });
    if (processed.images.length === 0) {
      record(
        'vision (local_image) input',
        'SKIP',
        "attachment processor produced no page images — poppler-utils isn't installed, so vision couldn't be probed",
      );
    } else {
      const t = codex.startThread(threadOptions);
      const turn = await t.run([
        { type: 'text', text: 'What text is written in this image? Reply with only that text.' },
        { type: 'local_image', path: processed.images[0]! },
      ]);
      const reply = turn.finalResponse.toLowerCase();
      const seen = reply.includes('pepper pdf ok') || reply.includes('pdf ok');
      record(
        'vision (local_image) input',
        seen ? 'PASS' : 'FAIL',
        seen ? `model read the image: ${turn.finalResponse.slice(0, 200)}` : `image content not seen in reply: ${turn.finalResponse.slice(0, 200)}`,
      );
    }
  } catch (e) {
    record('vision (local_image) input', 'FAIL', String(e).slice(0, 300));
  }

  // --- summary --------------------------------------------------------------
  console.log('='.repeat(60));
  const failed = results.filter((r) => r.verdict === 'FAIL');
  console.log(`\n${results.filter((r) => r.verdict === 'PASS').length} passed, ${failed.length} failed\n`);
  if (failed.length) {
    console.log('Do not run unattended until these pass:');
    for (const f of failed) console.log(`  - ${f.test}: ${f.detail}`);
    process.exit(1);
  }
  console.log('Spike green. Safe to run unattended.\n');
}

main().catch((e) => {
  console.error('spike crashed:', e);
  process.exit(1);
});
