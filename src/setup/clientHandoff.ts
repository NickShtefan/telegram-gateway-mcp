/** Service-private token validation/receipt. Transport adapters never expose these messages as public status. */
import type { Storage } from '../storage/port.js';
import { sha256Hex } from '../core/crypto.js';
import { acknowledgeClientToken, pendingClientToken, type OwnerPlan, type OwnerResult } from './owner.js';
import { coordinatorMessageSchema } from './promptChannel.js';
import { SetupError } from './contract.js';
/** Stable correlation per source/user; it grants no authority. */
export function ownerOperationId(sourceSha: string, user: string): string {
  if (!/^[0-9a-f]{40}$/.test(sourceSha) || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(user)) throw new SetupError('invalid_request');
  const hash = sha256Hex(`telegram-gateway-owner:${sourceSha}:${user}`).slice(0, 32).split('');
  hash[12] = '4'; hash[16] = ['8', '9', 'a', 'b'][parseInt(hash[16]!, 16) & 3]!;
  const value = hash.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export async function handoffOwnerClients(plan: OwnerPlan, result: OwnerResult, storage: Storage, secret: string, port: number,
  existingToken: string | null, send: (message: unknown) => Promise<void>, receive: () => Promise<unknown>, legacySetupId?: string): Promise<OwnerResult> {
  if (result.phase === 'failed' || !plan.clients.length) return result;
  let pendingId = plan.setup_id; let pending = pendingClientToken(storage, pendingId, secret);
  if (!pending && legacySetupId) {
    const legacy = pendingClientToken(storage, legacySetupId, secret);
    if (legacy?.user === plan.user) { pending = legacy; pendingId = legacySetupId; }
  }
  const token = pending?.user === plan.user ? pending.token : existingToken;
  if (!token || storage.users.get(plan.user)?.tokenSha256 !== sha256Hex(token)) return { ...result, phase: 'needs_existing_client_credential' };
  await send({ kind: 'handoff', setup_id: plan.setup_id, port, token, clients: plan.clients });
  const ack = coordinatorMessageSchema.parse(await receive());
  if (ack.kind !== 'client_ack' || ack.setup_id !== plan.setup_id || ack.token_sha256 !== sha256Hex(token)) throw new SetupError('invalid_state');
  if (pending) acknowledgeClientToken(storage, pendingId, ack.token_sha256);
  return { ...result, phase: 'needs_service_start' };
}
