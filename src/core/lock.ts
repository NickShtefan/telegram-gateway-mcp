/**
 * Блокировка «один процесс на сессии шлюза». Демон слушает unix-сокет в своей
 * домашней папке; пока сокет отвечает, второй процесс сессии не открывает.
 *
 * Почему сокет, а не PID-файл: PID-файл переживает падение процесса, а PID
 * может достаться чужому процессу. Сокет мёртвого процесса не отвечает
 * (ECONNREFUSED), и это видно сразу.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { GatewayError } from './errors.js';

export function lockPath(home: string): string {
  return join(home, 'daemon.sock');
}

/** Предел длины пути unix-сокета (sun_path): 104 байта на macOS, 108 на Linux, вместе с завершающим нулём. */
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

/** Отвечает ли живой процесс на сокете блокировки. */
export function isLockHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
  const path = lockPath(home);
  // По такому пути сокет создать нельзя, значит и владельца у него быть не может.
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
 * Берёт блокировку или бросает ошибку, если её держит живой процесс.
 * Сокет от умершего процесса удаляется и занимается заново.
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
        // Сокет нужен только как признак жизни: соединение сразу закрывается.
        socket.end();
      });
      server.once('error', reject);
      server.listen(path, () => resolve(server));
    });

  // Сначала пробуем занять сокет: bind атомарен, два процесса одновременно его не получат.
  // Проверка «жив ли владелец» нужна, только когда файл сокета уже есть.
  let server: Server;
  try {
    server = await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await isLockHeld(home)) throw held();
    // Сокет остался от умершего процесса.
    try {
      unlinkSync(path);
    } catch {
      // файл уже убрал другой процесс
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
            // файл уже убран
          }
          resolve();
        });
      }),
  };
}
