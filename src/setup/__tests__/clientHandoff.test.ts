import { describe, expect, it, vi } from 'vitest';
import { SqliteStorage } from '../../storage/sqlite.js';
import { addUser } from '../../cli/admin.js';
import { seal, sha256Hex } from '../../core/crypto.js';
import { pendingClientToken, ownerPlanSchema, type OwnerResult } from '../owner.js';
import { handoffOwnerClients, ownerOperationId } from '../clientHandoff.js';
const secret = 'synthetic-session-secret'; const sha = 'a'.repeat(40);
const plan = ownerPlanSchema.parse({ setup_id: ownerOperationId(sha, 'owner'), account: 'account', user: 'owner', clients: ['codex','claude'] });
const result: OwnerResult = { format_version: 1, setup_id: plan.setup_id, phase: 'needs_client_configuration', error_code: null };
function fixture() {
  const storage = new SqliteStorage({ path: ':memory:' }); storage.accounts.upsert({ id: 'account', status: 'active', tgUserId: '1', username: null, displayName: null });
  const { token } = addUser(storage, { id: 'owner', accounts: ['account'], defaultAccount: 'account' });
  storage.kv.set(`setup.handoff.${plan.setup_id}`, JSON.stringify({ user: 'owner', sealed: seal(token, secret) }));
  return { storage, token };
}
describe('direct credential handoff receipts', () => {
  it('clears pending bytes only after all selected clients acknowledge the exact token', async () => {
    const { storage, token } = fixture(); const send = vi.fn(async () => undefined);
    try {
      const done = await handoffOwnerClients(plan, result, storage, secret, 7777, null, send, async () => ({ kind: 'client_ack', setup_id: plan.setup_id, token_sha256: sha256Hex(token) }));
      expect(send.mock.calls[0]).toEqual([{kind:'handoff',setup_id:plan.setup_id,port:7777,token,clients:['codex','claude']}]);
      expect(done.phase).toBe('needs_service_start'); expect(JSON.stringify(done)).not.toContain(token);
      expect(pendingClientToken(storage, plan.setup_id, secret)).toBeNull();
    } finally { storage.close(); }
  });
  it('retains sealed pending data on a failed or wrong acknowledgement', async () => {
    const { storage, token } = fixture();
    try {
      await expect(handoffOwnerClients(plan, result, storage, secret, 7777, null, async () => undefined,
        async () => ({ kind: 'client_ack', setup_id: plan.setup_id, token_sha256: 'b'.repeat(64) }))).rejects.toThrow('invalid_state');
      expect(pendingClientToken(storage, plan.setup_id, secret)?.token).toBe(token);
    } finally { storage.close(); }
  });
  it('validates reused credentials against the selected gateway user hash', async () => {
    const { storage, token } = fixture(); storage.kv.set(`setup.handoff.${plan.setup_id}`, ''); const send = vi.fn(async () => undefined);
    try {
      expect((await handoffOwnerClients(plan, result, storage, secret, 7777, 'wrong'.repeat(10), send, async () => undefined)).phase).toBe('needs_existing_client_credential');
      expect(send).not.toHaveBeenCalled();
      expect((await handoffOwnerClients(plan, result, storage, secret, 7777, token, send,
        async () => ({kind:'client_ack',setup_id:plan.setup_id,token_sha256:sha256Hex(token)}))).phase).toBe('needs_service_start');
    } finally { storage.close(); }
  });
  it('keeps per-user operation identities distinct and stable without treating them as authorization', () => {
    expect(ownerOperationId(sha,'owner')).toBe(plan.setup_id); expect(ownerOperationId(sha,'wife')).not.toBe(plan.setup_id);
    expect(plan.setup_id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
});
