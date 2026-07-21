import { describe, expect, it } from 'vitest';
import { extractTodoIds, parseTodoCallback, todoHooks, todoKeyboard, MAX_BUTTONS } from '../src/chat/todo-buttons.js';
import { openDb } from '../src/db.js';
import { addTodo, getTodo, type Todo } from '../src/todos.js';

const todo = (id: number): Todo => ({
  id,
  title: `task ${id}`,
  context: 'work',
  status: 'open',
  source_id: null,
  due_date: null,
  created_at: 0,
  updated_at: 0,
  closed_at: null,
});

describe('extractTodoIds', () => {
  it('pulls deduped ids in first-seen order', () => {
    expect(extractTodoIds('Do T3, then T10, then T3 again')).toEqual([3, 10]);
  });

  it('ignores things that are not standalone T<n> tokens', () => {
    expect(extractTodoIds('PART3 xT5 T4x TODO T7')).toEqual([7]);
  });

  it('returns empty when there are no ids', () => {
    expect(extractTodoIds('nothing here')).toEqual([]);
  });
});

describe('todoKeyboard', () => {
  it('is undefined for an empty list', () => {
    expect(todoKeyboard([], 'list')).toBeUndefined();
  });

  it('uses the list prefix and lays out rows of three', () => {
    const kb = todoKeyboard([todo(1), todo(2), todo(3), todo(4)], 'list')!;
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]).toHaveLength(3);
    expect(kb.inline_keyboard[0]![0]).toMatchObject({ text: '✓ T1', callback_data: 'tdl:1' });
  });

  it('uses the annotate prefix in annotate mode', () => {
    const kb = todoKeyboard([todo(7)], 'annotate')!;
    expect(kb.inline_keyboard[0]![0]).toMatchObject({ text: '✓ T7', callback_data: 'td:7' });
  });

  it('caps the number of buttons', () => {
    const many = Array.from({ length: 30 }, (_, i) => todo(i + 1));
    const kb = todoKeyboard(many, 'annotate')!;
    expect(kb.inline_keyboard.flat()).toHaveLength(MAX_BUTTONS);
  });
});

describe('parseTodoCallback', () => {
  it('parses list-mode data', () => {
    expect(parseTodoCallback('tdl:12')).toEqual({ mode: 'list', id: 12 });
  });

  it('parses annotate-mode data', () => {
    expect(parseTodoCallback('td:5')).toEqual({ mode: 'annotate', id: 5 });
  });

  it('rejects anything else', () => {
    expect(parseTodoCallback('other:5')).toBeUndefined();
    expect(parseTodoCallback('td:')).toBeUndefined();
    expect(parseTodoCallback('tdlx:5')).toBeUndefined();
  });
});

describe('todoHooks', () => {
  it('annotates only the open todos a message mentions', () => {
    const db = openDb(':memory:');
    addTodo(db, { title: 'a' }); // T1 open
    addTodo(db, { title: 'b' }); // T2 open
    const hooks = todoHooks(db);
    hooks.markDone(2); // close T2

    const kb = hooks.annotate('remember T1, T2 and the nonexistent T9')!;
    const datas = kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
    expect(datas).toEqual(['td:1']); // T2 closed, T9 absent — only T1 gets a button
  });

  it('markDone is idempotent — a second (racing) tap is a no-op that returns undefined', () => {
    const db = openDb(':memory:');
    addTodo(db, { title: 'a' }); // T1
    const hooks = todoHooks(db);

    expect(hooks.markDone(1)).toBe('T1'); // first tap closes it
    expect(hooks.markDone(1)).toBeUndefined(); // second tap: already closed, no error
    expect(getTodo(db, 1)!.status).toBe('done');
  });

  it('renderList carries list-mode buttons for open todos and empties out', () => {
    const db = openDb(':memory:');
    addTodo(db, { title: 'a' });
    const hooks = todoHooks(db);

    const before = hooks.renderList();
    expect(before.keyboard!.inline_keyboard.flat()[0]).toMatchObject({ callback_data: 'tdl:1' });

    hooks.markDone(1);
    const after = hooks.renderList();
    expect(after.keyboard).toBeUndefined();
    expect(after.text).toContain('No open todos');
  });
});
