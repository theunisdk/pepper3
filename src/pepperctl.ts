#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadConfig, socketPath } from './config.js';
import { callControl } from './control/client.js';
import type { ControlRequest } from './control/protocol.js';
import { runLogin } from './cli/login.js';
import { runDoctor } from './cli/doctor.js';

/**
 * The agent's hands on the daemon.
 *
 * This is deliberately a CLI rather than an MCP server: the M1 spike research
 * turned up a headless approval bug for MCP tool calls (openai/codex#24135),
 * and a shell command is a path Codex takes without ceremony. It is also
 * trivially testable and readable in the logs.
 */

const USAGE = `pepperctl — control the running pepperd

  pepperctl status
  pepperctl send <text>                       Message the owner proactively
  pepperctl cron list [--all]
  pepperctl cron add --name <n> (--cron '<expr>' | --at <iso>) --prompt <text>
                     [--mode main|isolated] [--tz <zone>]
  pepperctl cron update --name <n> [--cron '<expr>'|--at <iso>] [--prompt <t>] [--mode m] [--tz z]
  pepperctl cron rm|pause|resume --name <n>
  pepperctl runs --name <n> [--limit N]
  pepperctl login [--device-auth]             Log in to Codex against Pepper's CODEX_HOME
  pepperctl doctor                            Health checks: auth, skills link, daemon, roots

Modes:
  main      (default) Ask on the owner's own thread; their reply continues it.
            Use for anything expecting an answer.
  isolated  Fresh throwaway thread; result is delivered and the thread dropped.
            Use for reports that need no follow-up.

Examples:
  pepperctl cron add --name standup --cron '30 8 * * 1-5' --prompt 'Ask what I am working on today.'
  pepperctl cron add --name call-mum --at 2026-07-20T18:00:00+02:00 --prompt 'Remind me to call Mum.'
`;

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function buildRequest(argv: string[]): ControlRequest {
  const [group, ...rest] = argv;

  if (group === 'status') return { cmd: 'status' };

  if (group === 'send') {
    const text = rest.join(' ').trim();
    if (!text) fail('send needs a message');
    return { cmd: 'send', args: { text } };
  }

  if (group === 'runs') {
    const f = parseFlags(rest);
    if (typeof f.name !== 'string') fail('runs needs --name');
    return { cmd: 'runs', args: { name: f.name, limit: f.limit ? Number(f.limit) : 10 } };
  }

  if (group === 'cron') {
    const [sub, ...cronArgs] = rest;
    const f = parseFlags(cronArgs);

    switch (sub) {
      case 'list':
        return { cmd: 'cron.list', args: { all: f.all === true } };

      case 'add':
      case 'update': {
        const args: Record<string, unknown> = {};
        if (typeof f.name === 'string') args.name = f.name;
        if (typeof f.prompt === 'string') args.prompt = f.prompt;
        if (typeof f.mode === 'string') args.mode = f.mode;
        if (typeof f.tz === 'string') args.tz = f.tz;
        if (typeof f.cron === 'string') {
          args.schedule = f.cron;
          args.kind = 'cron';
        } else if (typeof f.at === 'string') {
          args.schedule = f.at;
          args.kind = 'at';
        }
        if (sub === 'add' && (!args.name || !args.prompt || !args.schedule)) {
          fail('cron add needs --name, --prompt, and one of --cron/--at');
        }
        if (sub === 'update' && !args.name) fail('cron update needs --name');
        return { cmd: sub === 'add' ? 'cron.add' : 'cron.update', args };
      }

      case 'rm':
      case 'pause':
      case 'resume':
        if (typeof f.name !== 'string') fail(`cron ${sub} needs --name`);
        return { cmd: `cron.${sub}`, args: { name: f.name } };

      default:
        fail(`unknown cron subcommand "${sub ?? ''}"`);
    }
  }

  fail(`unknown command "${group ?? ''}"`);
}

function fail(msg: string): never {
  process.stderr.write(`pepperctl: ${msg}\n\n${USAGE}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (argv[0] === 'login') {
    const cfg = loadConfig(resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json'));
    process.exit(runLogin(cfg, { deviceAuth: argv.includes('--device-auth') }));
  }

  if (argv[0] === 'doctor') {
    const cfg = loadConfig(resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json'));
    process.exit(await runDoctor(cfg));
  }

  const cfg = loadConfig(resolve(process.env.PEPPER_CONFIG ?? 'pepper.config.json'));
  const res = await callControl(socketPath(cfg), buildRequest(argv));

  if (!res.ok) {
    process.stderr.write(`${res.error ?? 'failed'}\n`);
    process.exit(1);
  }
  process.stdout.write((res.text ?? 'ok') + '\n');
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
