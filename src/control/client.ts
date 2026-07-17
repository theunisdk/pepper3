import { connect } from 'node:net';
import type { ControlRequest, ControlResponse } from './protocol.js';

export async function callControl(
  socketPath: string,
  req: ControlRequest,
  timeoutMs = 10_000,
): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`control socket timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const done = (fn: () => void) => {
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        try {
          const res = JSON.parse(buf.slice(0, idx)) as ControlResponse;
          done(() => resolve(res));
        } catch (e) {
          done(() => reject(e as Error));
        }
      }
    });
    sock.on('error', (e) =>
      done(() =>
        reject(
          new Error(
            `${e.message}\nIs pepperd running? The socket should be at ${socketPath}.`,
          ),
        ),
      ),
    );
    sock.on('end', () => done(() => reject(new Error('control socket closed without replying'))));
  });
}
