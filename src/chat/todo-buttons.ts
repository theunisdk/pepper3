import type Database from 'better-sqlite3';
import type { InlineKeyboardMarkup } from 'grammy/types';
import { getTodo, listTodos, renderTodoList, setStatus, tId, type Todo } from '../todos.js';

/**
 * Tap-to-done todo buttons.
 *
 * The whole point: a tap is a Telegram callback_query, NOT a chat message, so it
 * is handled deterministically in the gateway (mark the row done, edit the
 * message) and NEVER goes through the Engine or the turn queue. That is why fast
 * taps can't race or coalesce — the failure mode the Hermes version had, where
 * a click was fed back through the model.
 *
 * Two modes, distinguished by callback-data prefix:
 * - `list`  (`tdl:<id>`): buttons under the managed `/todos` list. Tapping
 *   re-renders the whole list, so done rows vanish.
 * - `annotate` (`td:<id>`): buttons auto-attached to any other message that
 *   mentions open todos (triage reports, the brief). Tapping just removes that
 *   button; the model-authored text is left alone.
 */

export type TodoButtonMode = 'list' | 'annotate';

/** Max buttons on one message — keep annotated messages from ballooning. */
export const MAX_BUTTONS = 12;
const PER_ROW = 3;

function prefixFor(mode: TodoButtonMode): string {
  return mode === 'list' ? 'tdl:' : 'td:';
}

/** One "✓ Tn" button per todo, PER_ROW to a row. undefined if the list is empty. */
export function todoKeyboard(todos: Todo[], mode: TodoButtonMode): InlineKeyboardMarkup | undefined {
  const capped = todos.slice(0, MAX_BUTTONS);
  if (capped.length === 0) return undefined;
  const buttons = capped.map((t) => ({ text: `✓ ${tId(t)}`, callback_data: `${prefixFor(mode)}${t.id}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += PER_ROW) rows.push(buttons.slice(i, i + PER_ROW));
  return { inline_keyboard: rows };
}

/** Numeric todo ids mentioned as `T<n>` in a message, deduped, first-seen order. */
export function extractTodoIds(text: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const m of text.matchAll(/\bT(\d+)\b/g)) {
    const id = Number(m[1]);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export interface TodoCallback {
  mode: TodoButtonMode;
  id: number;
}

/** Parse `tdl:<id>` / `td:<id>` callback data. undefined if it isn't ours. */
export function parseTodoCallback(data: string): TodoCallback | undefined {
  const m = /^(tdl|td):(\d+)$/.exec(data);
  if (!m) return undefined;
  return { mode: m[1] === 'tdl' ? 'list' : 'annotate', id: Number(m[2]) };
}

/** Daemon-owned todo actions the gateway drives directly — never via the Engine. */
export interface TodoGatewayHooks {
  /** Buttons for the open todos a message mentions (annotate mode), or undefined. */
  annotate: (text: string) => InlineKeyboardMarkup | undefined;
  /** Mark a todo done. Returns its label ("T3"), or undefined if it wasn't open. */
  markDone: (id: number) => string | undefined;
  /** The managed `/todos` view: current text + list-mode buttons. */
  renderList: () => { text: string; keyboard?: InlineKeyboardMarkup };
}

/** Wire the hooks to a database. A tap resolves straight against the store. */
export function todoHooks(db: Database.Database): TodoGatewayHooks {
  return {
    annotate: (text) => {
      const open = extractTodoIds(text)
        .map((id) => getTodo(db, id))
        .filter((t): t is Todo => !!t && t.status === 'open');
      return todoKeyboard(open, 'annotate');
    },
    markDone: (id) => {
      const t = getTodo(db, id);
      if (!t || t.status !== 'open') return undefined; // already closed, or gone
      setStatus(db, String(id), 'done');
      return tId(t);
    },
    renderList: () => {
      const open = listTodos(db, {});
      return { text: renderTodoList(open), keyboard: todoKeyboard(open, 'list') };
    },
  };
}
