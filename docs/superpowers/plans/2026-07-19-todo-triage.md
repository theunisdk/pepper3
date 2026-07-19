# Todo Store & Hourly Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daemon-owned todo store (stable `T<n>` IDs, structural source-dedup) with `pepperctl todo` CRUD and a `/todos` Telegram view — the substrate for the hourly concierge triage job.

**Architecture:** `todos` table beside the existing jobs tables; a pure store module (`src/todos.ts`); thin control-socket commands + pepperctl verbs; `/todos` rendered by the daemon. Content (skill triage section, `triage.md` rulebook, sync tool, the cron job itself, concierge pwc config) is orchestrator-run per the spec: `docs/superpowers/specs/2026-07-19-todo-triage-design.md`.

**Tech Stack:** TypeScript (ESM, `.js` specifiers, strict + noUncheckedIndexedAccess), better-sqlite3, vitest.

## Global Constraints

- **PUBLIC repo**; `npm run audit` must pass before push. No feed/bucket identifiers in tracked files.
- **IDs are daemon-assigned and never reused** (AUTOINCREMENT); the model never invents a T-number.
- **Source dedup is structural**: `source_id` UNIQUE (nullable — manual todos unlimited); re-adding a source returns the existing todo with `created: false`, never an error and never a duplicate.
- All imports use `.js` specifiers. Reuse existing helpers; commit per task with the given message.

---

### Task 1: The todo store

**Files:**
- Modify: `src/db.ts` (SCHEMA constant)
- Create: `src/todos.ts`, `tests/todos.test.ts`

**Interfaces:**
- Consumes: `openDb` from `src/db.js` (tests), `Database` type.
- Produces (Task 2 depends on these exact signatures):
  `tId(t): string` · `parseTodoId(ref: string): number` ·
  `addTodo(db, {title, context?, sourceId?, due?}): {todo: Todo, created: boolean}` ·
  `getTodo(db, id): Todo | undefined` ·
  `listTodos(db, {status?: 'open'|'done'|'dropped'|'all', context?: string}): Todo[]` ·
  `setStatus(db, ref: string, status: TodoStatus): Todo` ·
  `updateTodo(db, ref, {title?, context?, due?}): Todo` ·
  `renderTodoList(todos: Todo[]): string` · `class TodoError`.

- [ ] **Step 1: Add the table to the schema**

In `src/db.ts`, append to the `SCHEMA` template string (after the `runs_by_job` index line, before the closing backtick):

```sql

-- Owner todo list. IDs are daemon-assigned (rendered "T<id>"); AUTOINCREMENT
-- guarantees numbers are never reused. source_id links a todo to the feed item
-- it came from — UNIQUE makes re-triaging the same item a structural no-op.
CREATE TABLE IF NOT EXISTS todos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT 'unclassified',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  source_id  TEXT UNIQUE,
  due_date   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS todos_by_status ON todos(status, context);
```

- [ ] **Step 2: Write the failing tests**

Create `tests/todos.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import {
  addTodo,
  getTodo,
  listTodos,
  parseTodoId,
  renderTodoList,
  setStatus,
  tId,
  TodoError,
  updateTodo,
} from '../src/todos.js';

function db() {
  return openDb(':memory:');
}

describe('addTodo', () => {
  it('assigns sequential T-ids starting at T1', () => {
    const d = db();
    const a = addTodo(d, { title: 'first' });
    const b = addTodo(d, { title: 'second' });
    expect(tId(a.todo)).toBe('T1');
    expect(tId(b.todo)).toBe('T2');
    expect(a.created).toBe(true);
  });

  it('never reuses an id, even after a drop', () => {
    const d = db();
    addTodo(d, { title: 'a' });
    const b = addTodo(d, { title: 'b' });
    setStatus(d, tId(b.todo), 'dropped');
    const c = addTodo(d, { title: 'c' });
    expect(tId(c.todo)).toBe('T3'); // T2 is gone forever, not recycled
  });

  it('dedups by source_id: same source returns the existing todo, created=false', () => {
    const d = db();
    const first = addTodo(d, { title: 'Reply to Jacques', sourceId: 'acct:MSG1', context: 'noldor' });
    const again = addTodo(d, { title: 'different title, same item', sourceId: 'acct:MSG1' });
    expect(again.created).toBe(false);
    expect(again.todo.id).toBe(first.todo.id);
    expect(listTodos(d, { status: 'all' })).toHaveLength(1);
  });

  it('allows unlimited manual todos with no source', () => {
    const d = db();
    addTodo(d, { title: 'a' });
    addTodo(d, { title: 'b' });
    expect(listTodos(d, {})).toHaveLength(2);
  });

  it('rejects empty titles and malformed due dates', () => {
    const d = db();
    expect(() => addTodo(d, { title: '  ' })).toThrow(TodoError);
    expect(() => addTodo(d, { title: 'x', due: 'tomorrow' })).toThrow(TodoError);
    expect(addTodo(d, { title: 'x', due: '2026-07-25' }).todo.due_date).toBe('2026-07-25');
  });
});

describe('parseTodoId', () => {
  it('accepts T14, t14, and bare 14', () => {
    expect(parseTodoId('T14')).toBe(14);
    expect(parseTodoId('t14')).toBe(14);
    expect(parseTodoId('14')).toBe(14);
  });
  it('rejects garbage', () => {
    expect(() => parseTodoId('T-1')).toThrow(TodoError);
    expect(() => parseTodoId('nope')).toThrow(TodoError);
  });
});

describe('status transitions', () => {
  it('done sets closed_at; reopen clears it', () => {
    const d = db();
    const t = addTodo(d, { title: 'x' }).todo;
    const done = setStatus(d, tId(t), 'done');
    expect(done.status).toBe('done');
    expect(done.closed_at).not.toBeNull();
    const reopened = setStatus(d, tId(t), 'open');
    expect(reopened.closed_at).toBeNull();
  });

  it('throws on an unknown id', () => {
    expect(() => setStatus(db(), 'T99', 'done')).toThrow(TodoError);
  });
});

describe('listTodos', () => {
  it('defaults to open only; filters by status and context', () => {
    const d = db();
    addTodo(d, { title: 'open-noldor', context: 'noldor' });
    const done = addTodo(d, { title: 'done-serova', context: 'serova' }).todo;
    setStatus(d, tId(done), 'done');
    expect(listTodos(d, {})).toHaveLength(1);
    expect(listTodos(d, { status: 'all' })).toHaveLength(2);
    expect(listTodos(d, { status: 'done' })).toHaveLength(1);
    expect(listTodos(d, { context: 'noldor' })).toHaveLength(1);
  });
});

describe('updateTodo', () => {
  it('patches title/context/due and bumps updated_at', () => {
    const d = db();
    const t = addTodo(d, { title: 'old', context: 'noldor' }).todo;
    const u = updateTodo(d, tId(t), { title: 'new', due: '2026-08-01' });
    expect(u.title).toBe('new');
    expect(u.context).toBe('noldor'); // untouched
    expect(u.due_date).toBe('2026-08-01');
  });
});

describe('renderTodoList', () => {
  it('groups by context and shows T-ids and due dates', () => {
    const d = db();
    addTodo(d, { title: 'ship the report', context: 'noldor', due: '2026-07-21' });
    addTodo(d, { title: 'renew passport', context: 'personal' });
    const out = renderTodoList(listTodos(d, {}));
    expect(out).toContain('*noldor*');
    expect(out).toContain('T1 · ship the report (due 2026-07-21)');
    expect(out).toContain('*personal*');
    expect(out).toContain('T2 · renew passport');
  });

  it('says so when there is nothing open', () => {
    expect(renderTodoList([])).toContain('No open todos');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/todos.test.ts` — FAIL (module not found).

- [ ] **Step 4: Implement `src/todos.ts`**

```typescript
import type Database from 'better-sqlite3';

/**
 * The owner's todo list — daemon-owned so its guarantees are structural:
 * T-numbers are assigned by the database (never by the model, never reused),
 * and feed-derived todos dedup on source_id so re-triaging the same item can
 * never create a duplicate. See docs/superpowers/specs/2026-07-19-todo-triage-design.md.
 */

export type TodoStatus = 'open' | 'done' | 'dropped';

export interface Todo {
  id: number;
  title: string;
  context: string;
  status: TodoStatus;
  source_id: string | null;
  due_date: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export class TodoError extends Error {
  override readonly name = 'TodoError';
}

export function tId(t: Pick<Todo, 'id'>): string {
  return `T${t.id}`;
}

export function parseTodoId(ref: string): number {
  const m = /^[Tt]?(\d+)$/.exec(ref.trim());
  if (!m) throw new TodoError(`"${ref}" is not a todo id — use T14 (or 14).`);
  return Number(m[1]);
}

export interface AddTodoInput {
  title: string;
  context?: string;
  sourceId?: string;
  due?: string;
}

export function addTodo(db: Database.Database, input: AddTodoInput): { todo: Todo; created: boolean } {
  const title = input.title?.trim();
  if (!title) throw new TodoError('a todo needs a title');
  if (input.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.due)) {
    throw new TodoError(`due date must be YYYY-MM-DD; got "${input.due}"`);
  }

  if (input.sourceId) {
    const existing = db.prepare('SELECT * FROM todos WHERE source_id = ?').get(input.sourceId) as Todo | undefined;
    if (existing) return { todo: existing, created: false };
  }

  const now = Date.now();
  try {
    const info = db
      .prepare(
        `INSERT INTO todos (title, context, status, source_id, due_date, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(title, input.context?.trim() || 'unclassified', input.sourceId ?? null, input.due ?? null, now, now);
    return { todo: getTodo(db, Number(info.lastInsertRowid))!, created: true };
  } catch (e) {
    // Belt-and-braces for the SELECT/INSERT gap: the UNIQUE index is the truth.
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && input.sourceId) {
      const existing = db.prepare('SELECT * FROM todos WHERE source_id = ?').get(input.sourceId) as Todo;
      return { todo: existing, created: false };
    }
    throw e;
  }
}

export function getTodo(db: Database.Database, id: number): Todo | undefined {
  return db.prepare('SELECT * FROM todos WHERE id = ?').get(id) as Todo | undefined;
}

export interface ListTodosFilter {
  status?: TodoStatus | 'all';
  context?: string;
}

export function listTodos(db: Database.Database, filter: ListTodosFilter): Todo[] {
  const status = filter.status ?? 'open';
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status !== 'all') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (filter.context) {
    clauses.push('context = ?');
    params.push(filter.context);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM todos ${where} ORDER BY context, due_date IS NULL, due_date, id`)
    .all(...params) as Todo[];
}

function requireTodo(db: Database.Database, ref: string): Todo {
  const todo = getTodo(db, parseTodoId(ref));
  if (!todo) throw new TodoError(`No todo ${ref.toUpperCase().startsWith('T') ? ref : `T${ref}`}.`);
  return todo;
}

export function setStatus(db: Database.Database, ref: string, status: TodoStatus): Todo {
  const todo = requireTodo(db, ref);
  const closedAt = status === 'open' ? null : Date.now();
  db.prepare('UPDATE todos SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?').run(
    status,
    closedAt,
    Date.now(),
    todo.id,
  );
  return getTodo(db, todo.id)!;
}

export interface UpdateTodoPatch {
  title?: string;
  context?: string;
  due?: string;
}

export function updateTodo(db: Database.Database, ref: string, patch: UpdateTodoPatch): Todo {
  const todo = requireTodo(db, ref);
  if (patch.title !== undefined && !patch.title.trim()) throw new TodoError('a todo needs a title');
  if (patch.due !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(patch.due)) {
    throw new TodoError(`due date must be YYYY-MM-DD; got "${patch.due}"`);
  }
  db.prepare('UPDATE todos SET title = ?, context = ?, due_date = ?, updated_at = ? WHERE id = ?').run(
    patch.title?.trim() ?? todo.title,
    patch.context?.trim() ?? todo.context,
    patch.due ?? todo.due_date,
    Date.now(),
    todo.id,
  );
  return getTodo(db, todo.id)!;
}

/** Telegram/pepperctl view: grouped by context, tight lines. */
export function renderTodoList(todos: Todo[]): string {
  if (todos.length === 0) return 'No open todos. 🎉';
  const byContext = new Map<string, Todo[]>();
  for (const t of todos) {
    const list = byContext.get(t.context) ?? [];
    list.push(t);
    byContext.set(t.context, list);
  }
  const lines: string[] = [];
  for (const [context, items] of byContext) {
    lines.push(`*${context}*`);
    for (const t of items) {
      lines.push(`  ${tId(t)} · ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''}`);
    }
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit` — all pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/todos.ts tests/todos.test.ts
git commit -m "feat: daemon-owned todo store — stable T-ids, structural source dedup"
```

---

### Task 2: Surfaces — control commands, pepperctl verbs, /todos

**Files:**
- Modify: `src/control/protocol.ts`, `src/control/server.ts`, `src/pepperctl.ts`, `src/chat/gateway.ts`, `src/pepperd.ts`
- Modify: `tests/integration.test.ts` (append a describe block)

**Interfaces:**
- Consumes: everything Task 1 produces (exact signatures above).
- Produces: control commands `todo.add`, `todo.list`, `todo.done`, `todo.drop`, `todo.update`; `pepperctl todo …` verbs; `/todos` Telegram command.

- [ ] **Step 1: Protocol**

In `src/control/protocol.ts`, extend `CONTROL_COMMANDS` (after `'workspace.commit'`):

```typescript
  'todo.add',
  'todo.list',
  'todo.done',
  'todo.drop',
  'todo.update',
```

- [ ] **Step 2: Server commands**

In `src/control/server.ts`: add to the todos import block at the top:

```typescript
import { addTodo, listTodos, renderTodoList, setStatus, tId, TodoError, updateTodo } from '../todos.js';
```

In `dispatch`'s switch, add before `case 'workspace.commit'`:

```typescript
        case 'todo.add': {
          const title = str(a.title, 'title');
          const r = addTodo(this.deps.db, {
            title,
            ...(typeof a.context === 'string' && a.context ? { context: a.context } : {}),
            ...(typeof a.source === 'string' && a.source ? { sourceId: a.source } : {}),
            ...(typeof a.due === 'string' && a.due ? { due: a.due } : {}),
          });
          return {
            ok: true,
            text: r.created
              ? `Created ${tId(r.todo)} · ${r.todo.title} (${r.todo.context}${r.todo.due_date ? `, due ${r.todo.due_date}` : ''})`
              : `${tId(r.todo)} already covers this item (source dedup) — status: ${r.todo.status}`,
            data: r,
          };
        }

        case 'todo.list': {
          const filter = {
            ...(a.all === true ? { status: 'all' as const } : typeof a.status === 'string' ? { status: a.status as never } : {}),
            ...(typeof a.context === 'string' && a.context ? { context: a.context } : {}),
          };
          const todos = listTodos(this.deps.db, filter);
          return { ok: true, text: renderTodoList(todos), data: todos };
        }

        case 'todo.done':
        case 'todo.drop': {
          const t = setStatus(this.deps.db, str(a.id, 'id'), req.cmd === 'todo.done' ? 'done' : 'dropped');
          return { ok: true, text: `${tId(t)} ${t.status} — ${t.title}`, data: t };
        }

        case 'todo.update': {
          const patch = {
            ...(typeof a.title === 'string' ? { title: a.title } : {}),
            ...(typeof a.context === 'string' ? { context: a.context } : {}),
            ...(typeof a.due === 'string' ? { due: a.due } : {}),
          };
          if (Object.keys(patch).length === 0) return { ok: false, error: 'nothing to update' };
          const t = updateTodo(this.deps.db, str(a.id, 'id'), patch);
          return { ok: true, text: `${tId(t)} updated · ${t.title} (${t.context}${t.due_date ? `, due ${t.due_date}` : ''})`, data: t };
        }
```

And extend the error mapping at the bottom of `dispatch`'s catch: change `if (e instanceof JobError)` to `if (e instanceof JobError || e instanceof TodoError)`.

- [ ] **Step 3: pepperctl verbs**

In `src/pepperctl.ts`, in `buildRequest` after the `commit` group, add:

```typescript
  if (group === 'todo') {
    const [sub, ...todoArgs] = rest;
    const f = parseFlags(todoArgs);
    switch (sub) {
      case 'add': {
        if (typeof f.title !== 'string' || !f.title.trim()) fail('todo add needs --title');
        return {
          cmd: 'todo.add',
          args: { title: f.title, context: f.context, source: f.source, due: f.due },
        };
      }
      case 'list':
        return { cmd: 'todo.list', args: { all: f.all === true, status: f.status, context: f.context } };
      case 'done':
      case 'drop': {
        const id = todoArgs.find((x) => !x.startsWith('--'));
        if (!id) fail(`todo ${sub} needs an id (e.g. T14)`);
        return { cmd: `todo.${sub}`, args: { id } };
      }
      case 'update': {
        const id = todoArgs.find((x) => !x.startsWith('--'));
        if (!id) fail('todo update needs an id (e.g. T14)');
        return { cmd: 'todo.update', args: { id, title: f.title, context: f.context, due: f.due } };
      }
      default:
        fail(`unknown todo subcommand "${sub ?? ''}"`);
    }
  }
```

In the USAGE constant's "Daemon control" section, after the `pepperctl commit` line add:

```
  pepperctl todo add --title <t> [--context c] [--source <item-id>] [--due YYYY-MM-DD]
  pepperctl todo list [--all|--status s] [--context c]
  pepperctl todo done|drop <T-id>
  pepperctl todo update <T-id> [--title t] [--context c] [--due d]
```

- [ ] **Step 4: /todos command**

`src/chat/gateway.ts`: `COMMANDS` becomes `['new', 'status', 'jobs', 'cancel', 'soul', 'todos'] as const;`

`src/pepperd.ts`: add to the todos import (new line with the other src imports): `import { listTodos, renderTodoList } from './todos.js';` and in `onCommand`'s switch before `default:`:

```typescript
        case 'todos':
          return renderTodoList(listTodos(db, {}));
```

- [ ] **Step 5: Integration tests**

Append to `tests/integration.test.ts`, inside the `describe('control socket + scheduler', ...)` block (after the 'reports unknown commands' test):

```typescript
  it('todo round-trip: add with source dedup, list, done', async () => {
    const add = await callControl(sock, {
      cmd: 'todo.add',
      args: { title: 'Reply to Jacques', context: 'noldor', source: 'acct:MSG1' },
    });
    expect(add.ok).toBe(true);
    expect(add.text).toContain('T1');

    const dup = await callControl(sock, {
      cmd: 'todo.add',
      args: { title: 'same item again', source: 'acct:MSG1' },
    });
    expect(dup.ok).toBe(true);
    expect(dup.text).toContain('already covers');

    const list = await callControl(sock, { cmd: 'todo.list', args: {} });
    expect(list.ok).toBe(true);
    expect(list.text).toContain('T1 · Reply to Jacques');

    const done = await callControl(sock, { cmd: 'todo.done', args: { id: 'T1' } });
    expect(done.ok).toBe(true);
    const after = await callControl(sock, { cmd: 'todo.list', args: {} });
    expect(after.text).toContain('No open todos');
  });

  it('todo errors surface cleanly over the socket', async () => {
    const bad = await callControl(sock, { cmd: 'todo.done', args: { id: 'T99' } });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('No todo T99');
  });
```

- [ ] **Step 6: Run full suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build` — all pass.

- [ ] **Step 7: Commit**

```bash
git add src/control/protocol.ts src/control/server.ts src/pepperctl.ts src/chat/gateway.ts src/pepperd.ts tests/integration.test.ts
git commit -m "feat: todo surfaces — pepperctl todo CRUD over the socket, /todos view"
```

---

### Task 3 (orchestrator-run): content, job, live acceptance

Per spec §2.2–§2.5: canonical skill triage section (concierge repo + bucket + installed); `workspace/triage.md` starter rulebook; SOUL amendments (personal-items rule supersession + sync tool doc); `workspace/tools/sync-concierge`; concierge `pwc` config (its repo, uncommitted); create the `concierge-triage` cron job; live acceptance incl. the zero-duplicates re-run and quiet-hour silence; audit + push.
