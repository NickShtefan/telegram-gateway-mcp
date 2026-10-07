/** Attest complete ancestry and reject ACLs conservatively before privileged file work. */
import { lstat, mkdir, chmod, chown, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
export class ProtectionError extends Error { constructor() { super('protection_unverified'); } }

export async function attestDirectory(path: string, owners: readonly number[], modeMask = 0o022): Promise<void> {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || !owners.includes(st.uid) || (st.mode & modeMask) !== 0) throw new ProtectionError();
  if (process.platform === 'darwin') {
    const { stdout } = await runFile('/bin/ls', ['-lde', path], { maxBuffer: 8192, timeout: 1000 });
    if (/\n\s*\d+:/.test(stdout) || stdout.split('\n')[0]?.[10] === '+') throw new ProtectionError();
  } else if (process.platform === 'linux') {
    // POSIX modes do not attest extended ACLs. Require an explicit system ACL query.
    const { stdout } = await runFile('/usr/bin/getfacl', ['-cp', path], { maxBuffer: 8192, timeout: 1000 });
    if (stdout.split('\n').some(line => line && !/^(user::[rwx-]{3}|group::[rwx-]{3}|other::[rwx-]{3})$/.test(line))) throw new ProtectionError();
  } else throw new ProtectionError();
}
export async function attestAncestry(path: string, allowSystemTemporary = false): Promise<void> {
  for (let current = resolve(path); ; current = dirname(current)) {
    const st = await lstat(current);
    const temporary = allowSystemTemporary && ['/tmp', '/private/tmp'].includes(current) && st.uid === 0 && (st.mode & 0o1000) !== 0;
    await attestDirectory(current, [0], temporary ? 0 : 0o022); if (current === '/') break;
  }
}
/** Never recursively chmod/chown preexisting or foreign trees. */
export async function newProtectedDirectory(path: string, uid: number, gid: number, mode: number): Promise<void> {
  await attestAncestry(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await chown(path, uid, gid); await chmod(path, mode);
  await attestDirectory(path, [uid]);
}
export async function writeProtectedFile(directory: string, name: string, bytes: Buffer, mode: number): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ProtectionError();
  await attestAncestry(directory);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    await file.writeFile(bytes); await file.sync(); await file.close();
    // No overwrite: existing definitions/commands need an explicit verified resume path.
    try { await lstat(join(directory, name)); throw new ProtectionError(); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await rename(temporary, join(directory, name));
  } finally { await file.close(); await unlink(temporary).catch(() => undefined); }
}
