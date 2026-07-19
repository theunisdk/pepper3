/** Line-delimited JSON over a unix socket. Deliberately small and boring. */

export interface ControlRequest {
  cmd: string;
  args?: Record<string, unknown>;
}

export interface ControlResponse {
  ok: boolean;
  /** Human-readable text — pepperctl prints this straight to the agent's stdout. */
  text?: string;
  data?: unknown;
  error?: string;
}

export const CONTROL_COMMANDS = [
  'status',
  'send',
  'cron.add',
  'cron.list',
  'cron.update',
  'cron.rm',
  'cron.pause',
  'cron.resume',
  'runs',
  'workspace.commit',
  'todo.add',
  'todo.list',
  'todo.done',
  'todo.drop',
  'todo.update',
] as const;

export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
