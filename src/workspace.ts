import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { logger } from './logger.js';
import type { PepperConfig } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

/** The shipped starting workspace. Copied once, then it's the owner's to edit. */
export function templateDir(): string {
  // dist/workspace.ts -> repo root; src/workspace.ts -> repo root
  for (const candidate of [resolve(here, '..', 'workspace.template'), resolve(here, '..', '..', 'workspace.template')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('workspace.template/ not found — is the repo intact?');
}

export interface WorkspaceStatus {
  created: boolean;
  skillsLinked: boolean;
  skillsDetail: string;
}

/**
 * Prepare the workspace and wire skills into Codex.
 *
 * Skills: the spike established that Codex discovers them at $CODEX_HOME/skills.
 * Because Pepper owns a dedicated CODEX_HOME, we can point that at the owner's
 * workspace/skills with a symlink instead of copying. A skill edited in the
 * workspace is therefore live on the very next turn — there is no sync step to
 * run and none to forget, which matters because "I edited it and it ignored me"
 * is exactly the class of bug this project exists to avoid.
 */
export function initWorkspace(cfg: PepperConfig): WorkspaceStatus {
  let created = false;

  if (!existsSync(cfg.workspacePath)) {
    mkdirSync(dirname(cfg.workspacePath), { recursive: true });
    cpSync(templateDir(), cfg.workspacePath, { recursive: true });
    created = true;
    logger.info({ workspace: cfg.workspacePath }, 'created workspace from template');
  }

  for (const sub of ['notes', 'skills', 'tools', 'run']) {
    mkdirSync(join(cfg.workspacePath, sub), { recursive: true });
  }
  mkdirSync(cfg.codexHome, { recursive: true });

  // Existing workspaces predate SOUL.md: create it from the template so the
  // self-edit protocol always has its target file.
  const soulPath = join(cfg.workspacePath, 'SOUL.md');
  if (!existsSync(soulPath)) {
    const templateSoul = join(templateDir(), 'SOUL.md');
    if (existsSync(templateSoul)) {
      copyFileSync(templateSoul, soulPath);
      logger.info({ soulPath }, 'created SOUL.md from template');
    }
  }

  // Migrated workspaces also predate the workspace .gitignore; without it a
  // stale run/ socket can make the startup drift-sweep commit nothing and log
  // a spurious failure.
  const ignorePath = join(cfg.workspacePath, '.gitignore');
  if (!existsSync(ignorePath)) {
    const templateIgnore = join(templateDir(), '.gitignore');
    if (existsSync(templateIgnore)) copyFileSync(templateIgnore, ignorePath);
  }

  // AGENTS.md is mechanical and not the agent's to edit. 0444 is an accident
  // barrier (file tools fail on write), not a security boundary — the agent
  // owns the file and chmod is not sandbox-governed. The workspace git history
  // below is the detection layer.
  const agentsPath = join(cfg.workspacePath, 'AGENTS.md');
  if (existsSync(agentsPath)) chmodSync(agentsPath, 0o444);

  initWorkspaceGit(cfg.workspacePath);

  const { linked, detail } = linkSkills(cfg);
  return { created, skillsLinked: linked, skillsDetail: detail };
}

function linkSkills(cfg: PepperConfig): { linked: boolean; detail: string } {
  const target = join(cfg.workspacePath, 'skills');
  const link = join(cfg.codexHome, 'skills');

  try {
    if (existsSync(link) || isSymlink(link)) {
      if (isSymlink(link)) {
        if (readlinkSync(link) === target) return { linked: true, detail: `${link} -> ${target}` };
        rmSync(link); // repoint a stale link
      } else {
        // A real directory here means someone put skills in CODEX_HOME directly.
        // Refuse to delete their files; report instead of guessing.
        return {
          linked: false,
          detail: `${link} is a real directory, not a symlink — move its contents into ${target} and delete it`,
        };
      }
    }
    symlinkSync(target, link, 'dir');
    logger.info({ link, target }, 'linked skills into CODEX_HOME');
    return { linked: true, detail: `${link} -> ${target}` };
  } catch (e) {
    return { linked: false, detail: `could not link skills: ${(e as Error).message}` };
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Commit current workspace changes with the given message. Called by the
 * control server on the agent's behalf: the Codex sandbox blocks writes to
 * .git (verified live), so the agent authors the message but the daemon —
 * outside the sandbox — performs the write. Same principle as the scheduler:
 * the daemon owns the history, not the model.
 */
export function commitWorkspace(ws: string, message: string): { committed: boolean; detail: string } {
  const git = (args: string) => execSync(`git -C "${ws}" ${args}`, { stdio: 'pipe' }).toString();
  if (!existsSync(join(ws, '.git'))) {
    return { committed: false, detail: 'workspace is not a git repo (restart pepperd to initialise it)' };
  }
  if (git('status --porcelain').trim().length === 0) {
    return { committed: false, detail: 'nothing to commit' };
  }
  git('add -A');
  execSync(`git -C "${ws}" commit -q -F -`, { input: message, stdio: ['pipe', 'pipe', 'pipe'] });
  const hash = git('rev-parse --short HEAD').trim();
  return { committed: true, detail: `committed ${hash}: ${message.split('\n')[0] ?? message}` };
}

/**
 * The workspace is a standalone, LOCAL-ONLY git repo: behaviour edits become
 * commits (audit + undo). No remote is ever configured here — this history
 * contains the owner's memory and rules and must never leave the box unless
 * the owner adds a private remote themselves.
 */
function initWorkspaceGit(ws: string): void {
  const git = (args: string) => execSync(`git -C "${ws}" ${args}`, { stdio: 'pipe' }).toString();
  try {
    if (!existsSync(join(ws, '.git'))) {
      git('init -q');
      // Repo-local identity so commits never depend on global git config.
      git('config user.name Pepper');
      git('config user.email pepper@localhost');
      git('add -A');
      git('commit -q -m "workspace created"');
      logger.info({ ws }, 'initialised local workspace git repo');
      return;
    }
    if (git('status --porcelain').trim().length > 0) {
      git('add -A');
      git('commit -q -m "uncommitted workspace changes found at startup"');
      logger.info({ ws }, 'committed workspace drift found at startup');
    }
  } catch (e) {
    // Never let bookkeeping stop the assistant from starting.
    logger.warn({ ws, err: (e as Error).message }, 'workspace git bookkeeping failed');
  }
}
