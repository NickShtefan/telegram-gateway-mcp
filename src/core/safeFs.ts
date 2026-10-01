/**
 * Безопасная работа с общей папкой шлюза. Её читают агенты под другим
 * пользователем macOS, поэтому демон не доверяет тому, что в ней лежит:
 * не ходит по символическим ссылкам и не трогает чужие файлы. Иначе
 * подложенная ссылка заставила бы демон отдать ключ сессии как «картинку»
 * или перезаписать свой `.env` выгрузкой.
 */
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { GatewayError } from './errors.js';

const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

function untrusted(path: string, why: string): GatewayError {
  return new GatewayError('UNAVAILABLE', `The gateway files directory is not safe to use: ${path} ${why}. The owner has to check who created it.`);
}

/** Папка существует, это не ссылка, она принадлежит процессу и чужим в неё писать нельзя. */
export function assertTrustedDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw untrusted(path, 'is a symbolic link');
  if (!st.isDirectory()) throw untrusted(path, 'is not a directory');
  if (uid() !== -1 && st.uid !== uid()) throw untrusted(path, 'belongs to another user');
  if ((st.mode & 0o022) !== 0) throw untrusted(path, 'is writable by other users');
}

/** Создаёт папку (и недостающих родителей до `root`) и проверяет каждую. Права 755: агенты читают, пишет только демон. */
export function ensureTrustedDir(path: string, root: string): void {
  const chain: string[] = [];
  for (let current = path; current.startsWith(root) && current.length >= root.length; current = dirname(current)) {
    chain.unshift(current);
    if (current === root) break;
  }
  if (chain[0] !== root) throw untrusted(path, 'is outside the files directory');
  for (const dir of chain) {
    try {
      mkdirSync(dir, { mode: 0o755 });
      chmodSync(dir, 0o755);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    assertTrustedDir(dir);
  }
}

/** Обычный файл, принадлежащий процессу: не ссылка и не чужой. */
export function isOwnRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && (uid() === -1 || st.uid === uid());
  } catch {
    return false;
  }
}

/**
 * Открывает новый файл на запись. Существующий свой файл заменяется, чужой
 * файл или ссылка дают ошибку: по ссылке запись не идёт никогда.
 */
export function openNewFile(path: string, mode = 0o644): number {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  try {
    return openSync(path, flags, mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!isOwnRegularFile(path)) throw untrusted(path, 'exists and is not a file of the gateway');
    unlinkSync(path);
    return openSync(path, flags, mode);
  }
}

export function writeNewFile(path: string, data: Buffer, mode = 0o644): void {
  const fd = openNewFile(path, mode);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

/** Читает свой обычный файл, не переходя по ссылкам. null, если файла нет, он чужой или больше предела. */
export function readOwnFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (uid() !== -1 && st.uid !== uid()) || st.size > maxBytes) return null;
    const buffer = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const read = readSync(fd, buffer, offset, st.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
