/**
 * The permanent kernel lease owns sessions; the Unix socket is a liveness
 * endpoint retained for compatibility with older daemons. Serialize stale
 * socket reclamation under the lease so concurrent restarts cannot unlink
 * a newly acquired owner's socket. Kernel ownership ends on process death.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { GatewayError } from './errors.js';
import { acquireFileLease, isFileLeaseHeld } from './fileLease.js';

const LEASE_NAME = 'sessions.lock';

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
function isSocketHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
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

export async function isLockHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
  if (await isSocketHeld(home, timeoutMs)) return true;
  return isFileLeaseHeld(home, LEASE_NAME);
}

export interface DaemonLock {
  release(): Promise<void>;
}

/**
 * Acquire kernel ownership before probing/reclaiming the compatibility socket.
 */
export async function acquireLock(home: string): Promise<DaemonLock> {
  const path = lockPath(home);
  if (!pathFits(path)) throw pathTooLong(home);
  const held = (): GatewayError =>
    new GatewayError(
      'UNAVAILABLE',
      `Another tg-mcp process already owns the Telegram sessions in ${home}. Only one process may open them (AUTH_KEY_DUPLICATED otherwise).`,
    );

  const lease = await acquireFileLease(home, LEASE_NAME);

  const listen = (): Promise<Server> =>
    new Promise<Server>((resolve, reject) => {
      const server: Server = createServer(socket => {
        // The socket only proves liveness; close connections immediately.
        socket.end();
      });
      server.once('error', reject);
      server.listen(path, () => resolve(server));
    });

  let server: Server;
  try {
    try {
      server = await listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      // Old versions own only the socket, so they must still block new clients.
      if (await isSocketHeld(home)) throw held();
      unlinkSync(path);
      server = await listen();
    }
  } catch (err) { await lease.release(); throw err; }
  server.unref();

  let released: Promise<void> | undefined;
  return {
    // Node removes its own socket on close. Do not unlink again afterward:
    // an older daemon could already have bound a fresh compatibility socket.
    release: () => released ??= new Promise<void>((resolve, reject) => {
      server.close(err => err ? reject(err) : resolve());
    }).finally(() => lease.release()),
  };
}
