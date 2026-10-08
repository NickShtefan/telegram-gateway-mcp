/** Installed administrator terminal entry. Never exposed by the agent wrapper or MCP. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminalIo } from '../cli/io.js';
import { installedPosixProfile } from './installed.js';
import { stopPosixService } from './serviceControl.js';
import { attestDirectory, attestFile } from '../install/posixPermissions.js';
import { acquireFileLease } from '../core/fileLease.js';
import { acquireLock } from '../core/lock.js';
import { loadSessionSecret } from '../core/config.js';
import { openStorage } from '../storage/sqlite.js';
import { ApiCredentialFile } from './credentials.js';
import { ownerSetup, ownerPlanSchema } from './owner.js';
import { coordinatorMessageSchema, privateLines, sendPrivate, workerIo, workerMessageSchema, questions, nextPrivate } from './promptChannel.js';
import { SetupError } from './contract.js';
import { handoffOwnerClients, ownerOperationId } from './clientHandoff.js';
import { withTimeout } from '../core/time.js';

async function main(): Promise<number> {
  const [mode, sha, ...extra] = process.argv.slice(2);
  if (!['terminal', 'worker', 'root-channel'].includes(mode ?? '') || !/^[0-9a-f]{40}$/.test(sha ?? '') || extra.length) throw new SetupError('invalid_request');
  const { layout, receipt } = await installedPosixProfile(sha!);
  const entry = join(layout.application, 'dist/setup/ownerCli.js');
  if (fileURLToPath(import.meta.url) !== entry || process.execPath !== layout.node || receipt.identity?.kind !== 'posix') throw new SetupError('protection_unverified');
  const identity = receipt.identity;
  if (mode === 'worker') {
    // Drop supplementary administrator groups before dropping gid/uid.
    process.setgroups!([]); process.setgid!(identity.gid); process.setuid!(identity.uid); process.umask(0o077);
    const input = privateLines(process.stdin)[Symbol.asyncIterator]();
    const first = await input.next(); if (first.done) throw new SetupError('invalid_request');
    const message = coordinatorMessageSchema.parse(JSON.parse(first.value));
    if (message.kind !== 'plan') throw new SetupError('invalid_request');
    const setupLease = await acquireFileLease(layout.state, 'setup.lock');
    try {
      const sessionLease = await acquireLock(layout.state);
      try {
        const attestState = async (): Promise<void> => {
          await attestDirectory(layout.state, [identity.uid], 0o077);
          for (const name of await readdir(layout.state)) {
            const path = join(layout.state, name); const st = await lstat(path);
            if (name === 'daemon.sock' && st.isSocket() && st.uid === identity.uid) continue;
            if (!st.isFile() || st.isSymbolicLink() || st.uid !== identity.uid || st.nlink !== 1 || (st.mode & 0o077)) throw new SetupError('protection_unverified');
            await attestFile(path, st);
          }
        };
        await attestState();
        const secret = loadSessionSecret(layout.state, {});
        const storage = openStorage(join(layout.state, 'gateway.sqlite'));
        try {
          let result = await ownerSetup(message.plan, {
            authorize: async () => { if (process.getuid?.() !== identity.uid || process.getgid?.() !== identity.gid) throw new SetupError('protection_unverified'); },
            withSetupLease: work => work(), withStoppedDaemon: work => work(), storage,
            credentials: new ApiCredentialFile(layout.state, attestState), sessionSecret: secret, io: workerIo(input, process.stdout),
          });
          result = await handoffOwnerClients(message.plan, result, storage, secret, receipt.plan.port, message.existing_token,
            value => sendPrivate(process.stdout, value), async () => {
              const next = await withTimeout(input.next(), 300000, 'client configuration acknowledgement');
              if (next.done) throw new SetupError('invalid_state'); return JSON.parse(next.value) as unknown;
            }, receipt.plan.setup_id);
          await sendPrivate(process.stdout, { kind: 'result', result });
          return result.phase === 'failed' ? 1 : 0;
        } finally { storage.close(); }
      } finally { await sessionLease.release(); }
    } finally { await setupLease.release(); }
  }
  const channel = mode === 'root-channel';
  const parentInput = channel ? privateLines(process.stdin)[Symbol.asyncIterator]() : null;
  let plan; let existingToken: string | null = null;
  if (channel) {
    const uid = Number(process.env.SUDO_UID);
    if (!Number.isSafeInteger(uid) || uid <= 0 || uid === identity.uid) throw new SetupError('protection_unverified');
    await sendPrivate(process.stdout, { kind: 'profile', setup_id: receipt.plan.setup_id, port: receipt.plan.port });
    const first = await withTimeout(parentInput!.next(), 300000, 'owner plan'); if (first.done) throw new SetupError('invalid_state');
    const message = coordinatorMessageSchema.parse(JSON.parse(first.value));
    if (message.kind !== 'plan' || message.plan.setup_id !== ownerOperationId(sha!, message.plan.user)) throw new SetupError('invalid_state');
    plan = message.plan; existingToken = message.existing_token;
  } else {
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new SetupError('protection_unverified');
    terminalIo.err('Stop all agents and disable terminal capture/UI automation before continuing. Inputs are hidden, but same-user software is outside this protection.');
    if (await terminalIo.prompt('Type OWNER READY after completing those steps: ') !== 'OWNER READY') throw new SetupError('invalid_request');
    const account = await terminalIo.prompt('Gateway account id: '); const user = await terminalIo.prompt('Gateway user id: ');
    plan = ownerPlanSchema.parse({ setup_id: receipt.plan.setup_id, account, user, replace_session: false, rotate_token: false });
  }
  const rootLease = await acquireFileLease(layout.prefix, 'owner.lock');
  try {
    const stopped = await stopPosixService(layout);
    let activate = false;
    try {
      const child = spawn(layout.node, [entry, 'worker', sha!], {
        cwd: layout.release, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TG_MCP_HOME: layout.state },
        stdio: ['pipe', 'pipe', 'ignore'], timeout: 15 * 60_000, killSignal: 'SIGKILL',
      });
      // Start waiting immediately so an early worker failure cannot lose its exit event.
      const exited = once(child, 'close').then(([code]) => code as number | null);
      const inputLife = new AbortController();
      void exited.then(() => inputLife.abort(), () => inputLife.abort());
      let result: ReturnType<typeof workerMessageSchema.parse> | undefined;
      let sequence = 0;
      try {
        await sendPrivate(child.stdin, { kind: 'plan', plan, existing_token: existingToken });
        for await (const line of privateLines(child.stdout)) {
          const message = workerMessageSchema.parse(JSON.parse(line));
          if (result) throw new SetupError('invalid_state');
          if (message.kind === 'result') { result = message; continue; }
          if (message.kind === 'handoff' && channel) {
            await sendPrivate(process.stdout, message);
            const next = await nextPrivate(parentInput!, inputLife.signal); if (next.done) throw new SetupError('invalid_state');
            const ack = coordinatorMessageSchema.parse(JSON.parse(next.value));
            if (ack.kind !== 'client_ack' || ack.setup_id !== plan.setup_id) throw new SetupError('invalid_state');
            await sendPrivate(child.stdin, ack); continue;
          }
          if (message.kind !== 'prompt') throw new SetupError('invalid_state');
          if (message.sequence !== ++sequence) throw new SetupError('invalid_state');
          if (channel) {
            await sendPrivate(process.stdout, message);
            const next = await nextPrivate(parentInput!, inputLife.signal); if (next.done) throw new SetupError('invalid_state');
            const answer = coordinatorMessageSchema.parse(JSON.parse(next.value));
            if (answer.kind !== 'answer' || answer.sequence !== sequence) throw new SetupError('invalid_state');
            await sendPrivate(child.stdin, answer);
          } else {
            const value = await terminalIo.prompt(questions[message.question], { hidden: true, signal: inputLife.signal });
            await sendPrivate(child.stdin, { kind: 'answer', sequence, value });
          }
        }
        const code = await exited;
        if (result?.kind !== 'result' || result.result.setup_id !== plan.setup_id || (code === 0) !== (result.result.phase !== 'failed')) throw new SetupError('invalid_state');
        activate = result.result.phase === 'needs_service_start';
        if (channel) await sendPrivate(process.stdout, result); else terminalIo.out(JSON.stringify(result.result));
        return code === 0 ? 0 : 1;
      } finally {
        inputLife.abort();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        // Supervision is restored only after OS-confirmed worker termination.
        await exited;
      }
    } finally { await stopped.restore(activate); }
  } finally { await rootLease.release(); }
}
main().then(code => { process.exitCode = code; }).catch(() => {
  // No stack, filesystem path, Telegram library text or private answer in output.
  process.stderr.write('{"format_version":1,"error_code":"owner_step_failed"}\n'); process.exitCode = 1;
});
