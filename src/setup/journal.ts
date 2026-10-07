/** Protected native adapter storage primitive. No directory creation or automatic adoption. */
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireFileLease, FileLeaseBusyError } from '../core/fileLease.js';
import { parseSafe, SetupError } from './contract.js';
import { journalSchema, type SetupJournal } from './engine.js';

export class FileSetupJournal {
  private leased = false;
  /** Native adapter must attest UID/ACL/ancestors and reject agent-writable directories every time. */
  constructor(private readonly directory: string, private readonly assertProtected: () => Promise<void>) {}

  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new SetupError('unsupported_platform');
    await this.assertProtected();
    let lock;
    try {
      lock = await acquireFileLease(this.directory, 'setup.lock');
    } catch (err) {
      throw new SetupError(err instanceof FileLeaseBusyError ? 'setup_busy' : 'protection_unverified');
    }
    this.leased = true;
    try { return await work(); } finally { this.leased = false; await lock.release(); }
  }

  async readJournal(): Promise<unknown | null> {
    await this.assertProtected();
    let file;
    try { file = await open(join(this.directory, 'journal.json'), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new SetupError('invalid_state');
    }
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > 16_384 || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) {
        throw new SetupError('invalid_state');
      }
      const buffer = Buffer.alloc(16_385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16_384) throw new SetupError('invalid_state');
      try { return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown; } catch { throw new SetupError('invalid_state'); }
    } finally { await file.close(); }
  }

  async writeJournal(journal: SetupJournal): Promise<void> {
    if (!this.leased) throw new SetupError('setup_busy');
    const safe = parseSafe(journalSchema, journal);
    await this.assertProtected();
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify(safe) + '\n');
      await file.sync();
      await file.close();
      await rename(temporary, join(this.directory, 'journal.json'));
      const directory = await open(this.directory, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await file.close();
      await unlink(temporary).catch(() => undefined);
    }
  }
}
