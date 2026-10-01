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

/** Отвечает ли живой процесс на сокете блокировки. */
export function isLockHeld(home: string, timeoutMs = 1_000): Promise<boolean> {
  const path = lockPath(home);
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
