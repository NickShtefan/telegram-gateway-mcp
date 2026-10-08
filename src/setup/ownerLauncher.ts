/** Original-user human terminal. Privileged children receive only closed private protocol messages. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { terminalIo } from '../cli/io.js';
import { sha256Hex } from '../core/crypto.js';
import { installLayout } from '../install/platform.js';
import { ownerPlanSchema } from './owner.js';
import { originalOwnerProfile } from './ownerProfile.js';
import { configureClient, readSelectedClientTokens } from './clientFile.js';
import { ClientEntryConflict, type ClientKind } from './clientConfig.js';
import { privateLines, sendPrivate, workerMessageSchema, questions } from './promptChannel.js';
import { probeConfiguredGateway } from './clientProbe.js';
import { SetupError } from './contract.js';
import { withTimeout } from '../core/time.js';
import { ownerOperationId, validatedClientHandoff } from './clientHandoff.js';

async function main(): Promise<number> {
  if (process.argv.length !== 2 || !process.stdin.isTTY || !process.stderr.isTTY || !['darwin', 'linux', 'win32'].includes(process.platform)) throw new SetupError('protection_unverified');
  const sha = dirname(process.execPath).split(/[\\/]/).at(-1)!;
  const layout = installLayout(process.platform as 'darwin' | 'linux' | 'win32', sha);
  if (fileURLToPath(import.meta.url) !== join(layout.application, 'dist/setup/ownerLauncher.js') || process.execPath !== layout.node) throw new SetupError('protection_unverified');
  terminalIo.err('Stop all agents and disable terminal capture/UI automation. Same-user software can read your input and client credentials.');
  if (await terminalIo.prompt('Type OWNER READY after completing those steps: ') !== 'OWNER READY') throw new SetupError('invalid_request');
  terminalIo.err('Obtain your own Telegram application credentials at https://my.telegram.org/apps. Enter them only in this terminal.');
  const account = await terminalIo.prompt('Gateway account id: '); const user = await terminalIo.prompt('Gateway user id: ');
  const chosen = await terminalIo.prompt('Clients (codex,claude,opencode,hermes; comma-separated; empty to skip): ');
  const clients = chosen ? chosen.split(',').map(s => s.trim()) as ClientKind[] : [];
  const preview = ownerPlanSchema.parse({ setup_id: randomUUID(), account, user, clients });
  const owner = originalOwnerProfile(preview.clients); await owner.authorize();
  let input: Readable; let output: Writable; let close: () => Promise<number | null>;
  if (process.platform !== 'win32') {
    const child = spawn('/usr/bin/sudo', ['--', layout.node, join(layout.application, 'dist/setup/ownerCli.js'), 'root-channel', sha],
      { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = once(child, 'close').then(([code]) => code as number | null);
    input = child.stdout; output = child.stdin;
    close = async () => { child.stdin.end(); return withTimeout(exited, 30000, 'owner coordinator exit'); };
  } else {
    const id = randomUUID(); const pipeName = `\\\\.\\pipe\\TelegramMCPSetup-${id}`;
    const server = createServer(); server.maxConnections = 1;
    const connected = once(server, 'connection').then(([socket]) => socket as Socket);
    server.listen(pipeName); await once(server, 'listening');
    const helper = join(layout.application, 'dist/native/service-host.exe');
    const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    // Only validated fixed-path/hex arguments appear in the elevation request.
    const quote = (value: string): string => "'" + value.replace(/'/g, "''") + "'";
    const launch = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath ${quote(helper)} -ArgumentList 'owner-broker ${id} ${sha}' -Verb RunAs -Wait`],
      { windowsHide: true, env: { SystemRoot: 'C:\\Windows' }, stdio: 'ignore' });
    const launchExit = once(launch, 'close').then(([code]) => code as number | null);
    let socket: Socket;
    try { socket = await withTimeout(Promise.race([connected, launchExit.then(() => { throw new SetupError('protection_unverified'); })]), 120000, 'system approval'); }
    catch { server.close(); throw new SetupError('protection_unverified'); }
    input = socket; output = socket;
    close = async () => { socket.end(); server.close(); return withTimeout(launchExit, 30000, 'owner coordinator exit'); };
  }
  const life = new AbortController(); input.once('end', () => life.abort()); input.once('close', () => life.abort()); input.once('error', () => life.abort());
  let result: Extract<ReturnType<typeof workerMessageSchema.parse>, { kind: 'result' }> | null = null;
  let setupId: string | null = null; let port = 0; let token: string | null = null; let sequence = 0; let verified=false;
  try {
    for await (const line of privateLines(input)) {
      const message = workerMessageSchema.parse(JSON.parse(line));
      if (result) throw new SetupError('invalid_state');
      if (message.kind === 'profile') {
        if (setupId) throw new SetupError('invalid_state'); setupId = ownerOperationId(sha, preview.user); port = message.port;
        const existingTokens = await readSelectedClientTokens(owner, preview.clients, port);
        await sendPrivate(output, { kind: 'plan', plan: { ...preview, setup_id: setupId }, existing_tokens: existingTokens });
      } else if (message.kind === 'prompt') {
        if (!setupId || message.sequence !== ++sequence) throw new SetupError('invalid_state');
        const value = await terminalIo.prompt(questions[message.question], { hidden: true, signal: life.signal });
        await sendPrivate(output, { kind: 'answer', sequence, value });
      } else if (message.kind === 'handoff') {
        if (!setupId || token) throw new SetupError('invalid_state');
        token = validatedClientHandoff(message, setupId, port, preview.clients);
        for (const client of message.clients) {
          try { await configureClient(owner, client, port, token); }
          catch (err) {
            if (!(err instanceof ClientEntryConflict)) throw err;
            terminalIo.err(`Client ${client} has a different gateway entry. Replacement preserves unrelated settings and requires your choice.`);
            if (await terminalIo.prompt(`Type REPLACE to update this gateway entry for ${client}, or cancel: `, { signal: life.signal }) !== 'REPLACE') throw new SetupError('invalid_state');
            await configureClient(owner, client, port, token, true);
          }
        }
        verified=await probeConfiguredGateway(port,token);if(!verified) throw new SetupError('invalid_state');
        await sendPrivate(output, { kind: 'client_ack', setup_id: setupId, token_sha256: sha256Hex(token) });
      } else {
        if (!setupId || message.result.setup_id !== setupId) throw new SetupError('invalid_state'); result = message;
      }
    }
    const code = await close();
    if (!result || code !== 0 || result.result.phase === 'failed') throw new SetupError('invalid_state');
    terminalIo.out(JSON.stringify({ ...result.result, sdk_connectivity_verified: !!verified, model_tool_loading_verified: false, clients: preview.clients }));
    return result.result.phase === 'needs_service_start' && !verified ? 1 : 0;
  } finally { life.abort(); token = null; await close().catch(() => undefined); }
}
main().then(code => { process.exitCode = code; }).catch(() => {
  process.stderr.write('{"format_version":1,"error_code":"owner_setup_failed"}\n'); process.exitCode = 1;
});
