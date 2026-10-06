/**
 * Enforce one process owning gateway sessions. The daemon listens on a Unix
 * socket in its home; while it responds, no second process opens sessions.
 *
 * A socket avoids stale PID files and PID reuse by unrelated processes.
 * A dead process leaves a nonresponding socket
 * (ECONNREFUSED), which can be detected immediately.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { GatewayError } from './errors.js';

export function lockPath(home: string): string {
  return join(home, 'daemon.sock');
}

/** Unix socket sun_path limits: 104 bytes on macOS, 108 on Linux, including the NUL terminator. */
const SOCKET_PATH_MAX = process.platform === 'darwin' ? 103 : 107;

function pathFits(path: string): boolean {
  return Buffer.byteLength(path) <= SOCKET_PATH_MAX;
}

function pathTooLong(home: string): GatewayError {
  return new GatewayError(
    'INVALID_ARGUMENT',
    `The gateway folder path is too long for the lock socket (${Buffer.byteLength(lockPath(home))} bytes, the system limit is ${SOCKET_PATH_MAX}): ${home}. Set TG_MCP_HOME to a shorter path.`,
  );
}

/** Whether a live process answers on the lock socket. */
export function isLockHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
  const path = lockPath(home);
  // The path cannot host a socket, so it cannot have an owner.
  if (!pathFits(path)) return Promise.resolve(false);
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const socket = connect(path);
    const done = (held: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface DaemonLock {
  release(): Promise<void>;
}

/**
 * Acquire the lock or throw if a live process owns it.
 * Remove and rebind a dead process's socket.
 */
export async function acquireLock(home: string): Promise<DaemonLock> {
  const path = lockPath(home);
  if (!pathFits(path)) throw pathTooLong(home);
  const held = (): GatewayError =>
    new GatewayError(
      'UNAVAILABLE',
      `Another tg-mcp process already owns the Telegram sessions in ${home}. Only one process may open them (AUTH_KEY_DUPLICATED otherwise).`,
    );

  const listen = (): Promise<Server> =>
    new Promise<Server>((resolve, reject) => {
      const server: Server = createServer(socket => {
        // The socket only proves liveness; close connections immediately.
        socket.end();
      });
      server.once('error', reject);
      server.listen(path, () => resolve(server));
    });

  // Try binding first: bind is atomic, so two processes cannot own the socket.
  // Probe the owner only if the socket path is already occupied.
  let server: Server;
  try {
    server = await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await isLockHeld(home)) throw held();
    // The socket belonged to a dead process.
    try {
      unlinkSync(path);
    } catch {
      // Another process may already have removed it.
    }
    try {
      server = await listen();
    } catch (again) {
      if ((again as NodeJS.ErrnoException).code === 'EADDRINUSE') throw held();
      throw again;
    }
  }
  server.unref();

  let released = false;
  return {
    release: () =>
      new Promise<void>(resolve => {
        if (released) return resolve();
        released = true;
        server.close(() => {
          try {
            if (existsSync(path)) unlinkSync(path);
          } catch {
            // Already removed.
          }
          resolve();
        });
      }),
  };
}
