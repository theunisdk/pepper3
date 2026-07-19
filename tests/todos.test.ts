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
