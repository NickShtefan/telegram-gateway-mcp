import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlan, reconcile, resumeSetup, selectClient, type SetupAdapter, type SetupEvidence, type SetupJournal } from '../engine.js';
import { emptyChecks, SetupError, statusSchema } from '../contract.js';
import { FileSetupJournal } from '../journal.js';
import { preflight, type PreflightProbe } from '../preflight.js';
import { decodeProgress } from '../progress.js';
import { main } from '../../cli/main.js';
import type { CliIo } from '../../cli/io.js';

const id = '12345678-1234-4234-8234-123456789012';
const plan = { ...createPlan({ source_sha: 'a'.repeat(40), artifact_sha256: 'b'.repeat(64), node_version: '24.10.0', architecture: 'arm64', port: 7777, client: 'none' }), setup_id: id };
const complete: SetupEvidence = {
  artifact_verified: true, protection_verified: true, installation: 'installed',
  credentials: true, session: true, grants: true, service: 'passed', authenticated_mcp: 'passed',
  client_configuration: 'passed', client_tools: 'passed', client_reload_needed: false,
};
const journal = (client: 'none' | 'codex' = 'none'): SetupJournal => ({ format_version: 1, revision: 1, plan: { ...plan, client }, cancelled: false });
const probe = (overrides: Partial<PreflightProbe> = {}): PreflightProbe => ({
  platform: 'darwin', architecture: 'arm64', darwinMajor: 22, installation: vi.fn(async () => 'absent' as const),
  portAvailable: vi.fn(async () => true), clientConfiguration: vi.fn(async () => 'present' as const), ...overrides,
});
const memory = (evidence = complete): SetupAdapter & { stored: unknown | null } => ({
  stored: null,
  withExclusive: async work => work(),
  async readJournal() { return this.stored; },
  async writeJournal(value) { this.stored = value; },
  inspect: vi.fn(async () => evidence),
});
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'tg-setup-')); directories.push(dir); return dir; }

describe('read-only preflight and CLI', () => {
  it('uses safe defaults and never inspects a client when none is selected', async () => {
    const p = probe();
    const result = await preflight({ port: 7777, client: 'none' }, p);
    expect(result).toMatchObject({ phase: 'preflight_ready', runtime: 'installer_managed', artifact: 'requires_verified_package', client_configuration: 'not_selected', defaults: { toolsets: ['core'], private_chats: 'closed', writes: 'disabled' } });
    expect(p.clientConfiguration).not.toHaveBeenCalled();
  });
  it.each([
    [{ platform: 'linux' }, 'unsupported_platform'],
    [{ darwinMajor: 21 }, 'unsupported_os_version'],
    [{ architecture: 'ia32' }, 'unsupported_architecture'],
    [{ installation: async () => 'legacy' as const }, 'existing_installation_requires_review'],
    [{ portAvailable: async () => false }, 'port_unavailable'],
  ] as const)('rejects unsafe/unavailable prerequisites', async (overrides, code) => {
    const result = await preflight({ port: 7777, client: 'none' }, probe(overrides));
    expect(result).toMatchObject({ phase: 'failed', error_code: code });
  });
  it('does not expose inspection errors or paths', async () => {
    const result = await preflight({ port: 7777, client: 'codex' }, probe({ clientConfiguration: async () => { throw new Error('fixture-secret https://user:password@host'); } }));
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result.error_code).toBe('inspection_failed');
  });
  it.each(['codex', 'claude', 'opencode', 'hermes'] as const)('allows selected client %s without assuming its config path', async client => {
    const p = probe({ clientConfiguration: async () => 'not_inspected' });
    expect(await preflight({ port: 7777, client }, p)).toMatchObject({ phase: 'preflight_ready', client, client_configuration: 'not_inspected' });
  });
  it('bypasses config, database, credentials and IO prompts even with secret environment inputs', async () => {
    const root = directory();
    const home = join(root, 'must-not-exist');
    const out: string[] = []; const err: string[] = [];
    const io: CliIo = { out: s => out.push(s), err: s => err.push(s), prompt: vi.fn(async () => { throw new Error('unexpected prompt'); }) };
    expect(await main(['setup', 'preflight', '--json'], { io, env: { TG_MCP_HOME: home, TG_API_HASH: 'fixture-secret' }, setup: { probe: probe() } })).toBe(0);
    expect(readdirSync(root)).toEqual([]);
    expect(io.prompt).not.toHaveBeenCalled();
    expect(out.join('')).not.toContain('fixture-secret');
    expect(err).toEqual([]);
    expect(await main(['setup', 'status', '--setup-id', id], { io, env: { TG_MCP_HOME: home }, setup: { readProgress: async () => { throw new SetupError('status_unavailable'); } } })).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });
  it.each([['--port', 'fixture-secret'], ['--client', 'fixture-secret'], ['--fixture-secret']])('redacts parse errors', async (...args) => {
    const lines: string[] = []; const io: CliIo = { out: s => lines.push(s), err: s => lines.push(s), prompt: vi.fn() };
    expect(await main(['setup', 'preflight', ...args], { io })).toBe(1);
    expect(lines.join('')).not.toContain('fixture-secret');
    expect(lines).toEqual(['{"format_version":1,"error_code":"invalid_request"}']);
  });
  it('reports status as cached evidence and rejects arbitrary provider output', async () => {
    const lines: string[] = []; const io: CliIo = { out: s => lines.push(s), err: s => lines.push(s), prompt: vi.fn() };
    const snapshot = { observed_at_ms: Date.now(), status: reconcile(journal(), complete) };
    expect(await main(['setup', 'status', '--json', '--setup-id', id], { io, setup: { readProgress: async () => snapshot } })).toBe(0);
    expect(JSON.parse(lines[0]!).evidence).toBe('cached_snapshot');
    lines.length = 0;
    expect(await main(['setup', 'status', '--json', '--setup-id', id], { io, setup: { readProgress: async () => ({ ...snapshot, secret: 'fixture-secret' }) } })).toBe(1);
    expect(lines.join('')).not.toContain('fixture-secret');
  });
});

describe('truthful reconciliation and resume', () => {
  it.each([
    [{ installation: 'absent' }, 'needs_system_approval'],
    [{ installation: 'partial' }, 'needs_system_approval'],
    [{ credentials: false }, 'needs_api_credentials'],
    [{ session: false }, 'needs_telegram_login'],
    [{ grants: false }, 'needs_access_selection'],
    [{ service: 'not_checked' }, 'needs_service_verification'],
    [{ authenticated_mcp: 'not_checked' }, 'needs_service_verification'],
  ] as const)('ignores downstream/stale readiness when a prerequisite is missing', (changes, stage) => {
    expect(reconcile(journal(), { ...complete, ...changes }).stage).toBe(stage);
  });
  it.each([
    [{ installation: 'foreign' }, 'existing_installation_requires_review'],
    [{ installation: 'different_release' }, 'update_unsupported'],
    [{ protection_verified: false }, 'protection_unverified'],
    [{ artifact_verified: false }, 'artifact_unverified'],
    [{ service: 'failed' }, 'verification_failed'],
    [{ authenticated_mcp: 'failed' }, 'verification_failed'],
  ] as const)('never reports readiness for invalid installation/evidence', (changes, error_code) => {
    expect(reconcile(journal(), { ...complete, ...changes })).toMatchObject({ stage: 'failed', error_code });
  });
  it('separates gateway completion, client configuration, reload, observation and ready', () => {
    expect(reconcile(journal(), complete).stage).toBe('gateway_ready');
    expect(reconcile(journal('codex'), { ...complete, client_configuration: 'pending' }).stage).toBe('needs_client_configuration');
    expect(reconcile(journal('codex'), { ...complete, client_reload_needed: true }).stage).toBe('needs_client_reload');
    expect(reconcile(journal('codex'), { ...complete, client_tools: 'pending' }).stage).toBe('needs_client_verification');
    expect(reconcile(journal('codex'), complete).stage).toBe('ready');
  });
  it('cancellation and resume preserve completed work and never execute setup side effects', async () => {
    const adapter = memory();
    expect((await resumeSetup(adapter, plan, 'cancel')).stage).toBe('cancelled');
    expect((await resumeSetup(adapter, plan)).stage).toBe('gateway_ready');
    expect(adapter.stored).toEqual({ ...journal(), revision: 2 });
    expect((await resumeSetup(adapter, plan)).stage).toBe('gateway_ready');
  });
  it('permits later owner-approved client selection without resetting credentials/session/grants', async () => {
    const adapter = memory(); await resumeSetup(adapter, plan);
    expect((await selectClient(adapter, plan, 'codex')).stage).toBe('ready');
    const nextPlan = { ...plan, client: 'codex' as const };
    expect((await resumeSetup(adapter, nextPlan)).stage).toBe('ready');
    expect((adapter.stored as SetupJournal).revision).toBe(3);
  });
  it('rejects corrupt/future/extra-secret journals without overwriting them', async () => {
    for (const stored of [{ ...journal(), format_version: 2 }, { ...journal(), token: 'fixture-secret' }, { random: 'fixture-secret' }]) {
      const adapter = memory(); adapter.stored = stored;
      const result = await resumeSetup(adapter, plan);
      expect(result.error_code).toBe('invalid_state'); expect(adapter.stored).toBe(stored);
      expect(JSON.stringify(result)).not.toContain('fixture-secret');
    }
  });
  it('requires explicit approval for plan changes and never adopts a different installation', async () => {
    const adapter = memory(); await resumeSetup(adapter, plan);
    const before = adapter.stored;
    expect((await resumeSetup(adapter, { ...plan, port: 8888 })).error_code).toBe('invalid_state');
    expect(adapter.stored).toBe(before);
    const foreign = memory({ ...complete, installation: 'foreign' });
    expect((await resumeSetup(foreign, plan)).error_code).toBe('existing_installation_requires_review');
    expect(foreign.stored).toBeNull();
  });
  it('redacts adapter errors and clears evidence if persistence fails', async () => {
    const adapter = memory(); adapter.writeJournal = async () => { throw new Error('fixture-secret'); };
    const result = await resumeSetup(adapter, plan);
    expect(result).toMatchObject({ stage: 'failed', error_code: 'adapter_failed', checks: emptyChecks('none') });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
  });
});

describe('progress validation', () => {
  it.each(['token', 'api_hash', 'phone', 'code', 'password', 'session', 'key', 'url', 'telegram_text'])('rejects unknown secret field %s', key => {
    const status = { ...reconcile(journal(), complete), [key]: 'fixture-secret' };
    expect(() => decodeProgress({ observed_at_ms: 1000, status }, id, 1000)).toThrow('unsafe_progress');
  });
  it('rejects incorrect IDs, future timestamps, stale and internally inconsistent readiness', () => {
    const status = reconcile(journal(), complete);
    expect(() => decodeProgress({ observed_at_ms: 1000, status }, id.replace('12345678', '87654321'), 1000)).toThrow('status_unavailable');
    expect(() => decodeProgress({ observed_at_ms: 1001, status }, id, 1000)).toThrow('stale_progress');
    expect(() => decodeProgress({ observed_at_ms: 1000, status }, id, 61_001)).toThrow('stale_progress');
    expect(() => decodeProgress({ observed_at_ms: 1000, status: { ...status, checks: emptyChecks('none') } }, id, 1000)).toThrow('unsafe_progress');
    expect(statusSchema.safeParse({ ...status, stage: 'needs_client_reload' }).success).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('protected journal primitives', () => {
  it('persists and resumes atomically in an already-provisioned directory', async () => {
    const dir = directory(); const storage = new FileSetupJournal(dir, async () => undefined);
    const adapter: SetupAdapter = { withExclusive: f => storage.withExclusive(f), readJournal: () => storage.readJournal(), writeJournal: j => storage.writeJournal(j), inspect: async () => complete };
    expect((await resumeSetup(adapter, plan)).stage).toBe('gateway_ready');
    expect((await resumeSetup(adapter, plan)).revision).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['journal.json', 'setup.lock']);
    expect(JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8'))).toEqual({ ...journal(), revision: 2 });
    await expect(storage.writeJournal(journal())).rejects.toThrow('setup_busy');
  });
  it('requires native protection attestation before reading, writing or acquiring a lease', async () => {
    const dir = directory(); const deny = async (): Promise<void> => { throw new SetupError('protection_unverified'); };
    const storage = new FileSetupJournal(dir, deny);
    await expect(storage.readJournal()).rejects.toThrow('protection_unverified');
    await expect(storage.withExclusive(async () => undefined)).rejects.toThrow('protection_unverified');
    expect(readdirSync(dir)).toEqual([]);
  });
  it('rejects symlink, malformed and world-readable journal files without changing them', async () => {
    const dir = directory(); const storage = new FileSetupJournal(dir, async () => undefined);
    const file = join(dir, 'journal.json');
    symlinkSync(join(dir, 'missing'), file);
    await expect(storage.readJournal()).rejects.toThrow('invalid_state');
    rmSync(file); writeFileSync(file, 'fixture-secret', { mode: 0o600 });
    await expect(storage.readJournal()).rejects.toThrow('invalid_state');
    writeFileSync(file, JSON.stringify(journal())); chmodSync(file, 0o644);
    await expect(storage.readJournal()).rejects.toThrow('invalid_state');
  });
  it('excludes a second process and recovers after its crash without deleting the journal', async () => {
    const dir = directory(); const storage = new FileSetupJournal(dir, async () => undefined);
    const script = "import {openSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const fd=openSync(process.argv[1],'a',0o600); const mac=process.platform==='darwin';const result=spawnSync(mac?'/usr/bin/lockf':'/usr/bin/flock',mac?['-s','-t','0','3']:['-n','3'],{stdio:['ignore','ignore','ignore',fd]}); if(result.status!==0)process.exit(1);process.stdout.write('locked\\n');setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(dir, 'setup.lock')], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await once(child.stdout!, 'data');
      await expect(storage.withExclusive(async () => undefined)).rejects.toThrow('setup_busy');
    } finally {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await expect(storage.withExclusive(async () => 'resumed')).resolves.toBe('resumed');
  });
  it('two concurrent workers cannot both obtain the setup lease', async () => {
    const dir = directory(); const first = new FileSetupJournal(dir, async () => undefined); const second = new FileSetupJournal(dir, async () => undefined);
    let release!: () => void; let entered!: () => void;
    const running = first.withExclusive(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
    await new Promise<void>(resolve => { entered = resolve; });
    try { await expect(second.withExclusive(async () => undefined)).rejects.toThrow('setup_busy'); }
    finally { release(); await running; }
  });
  it('concurrent crash recovery never overlaps setup workers', async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const dir = directory();
      const script = "import {openSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; const fd=openSync(process.argv[1],'a',0o600); const mac=process.platform==='darwin';const result=spawnSync(mac?'/usr/bin/lockf':'/usr/bin/flock',mac?['-s','-t','0','3']:['-n','3'],{stdio:['ignore','ignore','ignore',fd]}); if(result.status!==0)process.exit(1);process.stdout.write('locked\\n');setInterval(()=>{},1000);";
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(dir, 'setup.lock')], { stdio: ['ignore', 'pipe', 'pipe'] });
      await once(child.stdout!, 'data');
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
      let active = 0; let peak = 0;
      const work = async (): Promise<void> => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 10)); active--;
      };
      const first = new FileSetupJournal(dir, async () => undefined); const second = new FileSetupJournal(dir, async () => undefined);
      await Promise.allSettled([first.withExclusive(work), second.withExclusive(work)]);
      expect(peak).toBe(1);
    }
  });
});
