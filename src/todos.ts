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
