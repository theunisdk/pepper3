import { cpSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
