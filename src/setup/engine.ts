/** Reconcile actual adapter evidence; never replay login/grants/token issuance from a journal marker. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  emptyChecks, parseSafe, planSchema, safeError, SetupError, statusSchema,
  type SetupPlan, type SetupStatus, type ClientSelection,
} from './contract.js';

export const journalSchema = z.strictObject({
  format_version: z.literal(1), revision: z.number().int().nonnegative(),
  plan: planSchema, cancelled: z.boolean(),
});
export type SetupJournal = z.infer<typeof journalSchema>;

export const evidenceSchema = z.strictObject({
  artifact_verified: z.boolean(), protection_verified: z.boolean(),
  installation: z.enum(['absent', 'partial', 'installed', 'foreign', 'different_release']),
  credentials: z.boolean(), session: z.boolean(), grants: z.boolean(),
  service: z.enum(['not_checked', 'passed', 'failed']),
  authenticated_mcp: z.enum(['not_checked', 'passed', 'failed']),
  client_configuration: z.enum(['pending', 'passed', 'failed']),
  client_tools: z.enum(['pending', 'passed', 'failed']),
  client_reload_needed: z.boolean(),
});
export type SetupEvidence = z.infer<typeof evidenceSchema>;

/** Implemented by a protected platform adapter, not by MCP callers or progress readers. */
export interface SetupAdapter {
  withExclusive<T>(work: () => Promise<T>): Promise<T>;
  readJournal(): Promise<unknown | null>;
  writeJournal(journal: SetupJournal): Promise<void>;
  /** Fresh checks bound to this exact plan; no Telegram calls or secret data in the result. */
  inspect(plan: SetupPlan): Promise<SetupEvidence>;
}

function initial(plan: SetupPlan, revision: number): SetupStatus {
  return {
    format_version: 1, setup_id: plan.setup_id, revision,
    stage: 'needs_system_approval', outcome: 'waiting_for_owner', error_code: null,
    next_action: 'open_owner_terminal', checks: emptyChecks(plan.client),
  };
}

function failure(status: SetupStatus, code: ReturnType<typeof safeError>): SetupStatus {
  return parseSafe(statusSchema, {
    ...status, stage: 'failed', outcome: 'failed', error_code: code,
    next_action: code === 'update_unsupported' ? 'use_update_workflow'
      : code === 'existing_installation_requires_review' ? 'review_existing_installation'
      : code === 'setup_busy' ? 'wait_for_setup' : 'resume_setup',
  });
}

export function reconcile(journal: SetupJournal, evidence: SetupEvidence): SetupStatus {
  const j = parseSafe(journalSchema, journal);
  const e = parseSafe(evidenceSchema, evidence);
  const s = initial(j.plan, j.revision);
  if (e.installation === 'foreign') return failure(s, 'existing_installation_requires_review');
  if (e.installation === 'different_release') return failure(s, 'update_unsupported');
  if (!e.artifact_verified) return failure(s, 'artifact_unverified');
  s.checks.artifact = 'passed';
  if (e.installation !== 'absent' && !e.protection_verified) return failure(s, 'protection_unverified');
  if (e.installation === 'installed') s.checks.installation = 'passed';
  if (j.cancelled) return parseSafe(statusSchema, { ...s, stage: 'cancelled', outcome: 'cancelled', next_action: 'resume_setup' });
  if (e.installation !== 'installed') return parseSafe(statusSchema, s);
  if (!e.credentials) return parseSafe(statusSchema, { ...s, stage: 'needs_api_credentials' });
  if (!e.session) return parseSafe(statusSchema, { ...s, stage: 'needs_telegram_login' });
  if (!e.grants) return parseSafe(statusSchema, { ...s, stage: 'needs_access_selection' });
  s.checks.service = e.service;
  s.checks.authenticated_mcp = e.authenticated_mcp;
  if (e.service === 'failed' || e.authenticated_mcp === 'failed') return failure(s, 'verification_failed');
  if (e.service !== 'passed' || e.authenticated_mcp !== 'passed') {
    return parseSafe(statusSchema, { ...s, stage: 'needs_service_verification', outcome: 'pending', next_action: 'verify_service' });
  }
  if (j.plan.client === 'none') {
    return parseSafe(statusSchema, { ...s, stage: 'gateway_ready', outcome: 'complete', next_action: 'none' });
  }
  s.checks.client_configuration = e.client_configuration;
  s.checks.client_tools = e.client_configuration === 'passed' ? e.client_tools : 'pending';
  if (e.client_configuration === 'failed' || s.checks.client_tools === 'failed') return failure(s, 'verification_failed');
  if (e.client_configuration !== 'passed') {
    return parseSafe(statusSchema, { ...s, stage: 'needs_client_configuration', outcome: 'waiting_for_owner', next_action: 'configure_client' });
  }
  if (e.client_reload_needed) {
    s.checks.client_tools = 'pending';
    return parseSafe(statusSchema, { ...s, stage: 'needs_client_reload', outcome: 'waiting_for_owner', next_action: 'reload_client' });
  }
  if (e.client_tools !== 'passed') {
    return parseSafe(statusSchema, { ...s, stage: 'needs_client_verification', outcome: 'pending', next_action: 'verify_client_tools' });
  }
  return parseSafe(statusSchema, { ...s, stage: 'ready', outcome: 'complete', next_action: 'none' });
}

/** Owner-approved plan only. Setup IDs do not authorize this in-process API. */
export async function resumeSetup(adapter: SetupAdapter, plan: SetupPlan, action: 'resume' | 'cancel' = 'resume'): Promise<SetupStatus> {
  const p = parseSafe(planSchema, plan, 'invalid_request');
  if (action !== 'resume' && action !== 'cancel') throw new SetupError('invalid_request');
  let status = initial(p, 0);
  try {
    return await adapter.withExclusive(async () => {
      const raw = await adapter.readJournal();
      const previous = raw === null ? null : parseSafe(journalSchema, raw);
      if (previous && JSON.stringify(previous.plan) !== JSON.stringify(p)) throw new SetupError('invalid_state');
      const evidence = parseSafe(evidenceSchema, await adapter.inspect(p));
      const journal: SetupJournal = {
        format_version: 1, revision: (previous?.revision ?? 0) + 1,
        plan: p, cancelled: action === 'cancel',
      };
      status = reconcile(journal, evidence);
      // Never overwrite a damaged journal or adopt a foreign installation.
      if (status.error_code === null) await adapter.writeJournal(journal);
      return status;
    });
  } catch (err) {
    return failure({ ...status, checks: emptyChecks(p.client) }, safeError(err));
  }
}

/** Switching client selection needs an explicitly approved new plan and is handled by the platform adapter. */
export function createPlan(input: Omit<SetupPlan, 'format_version' | 'setup_id'>): SetupPlan {
  return parseSafe(planSchema, { ...input, format_version: 1, setup_id: randomUUID() }, 'invalid_request');
}

/** Called only after owner approval; changing a client never issues a token or repeats login. */
export async function selectClient(adapter: SetupAdapter, plan: SetupPlan, client: ClientSelection): Promise<SetupStatus> {
  const p = parseSafe(planSchema, { ...plan, client }, 'invalid_request');
  let status = initial(p, 0);
  try {
    return await adapter.withExclusive(async () => {
      const previous = parseSafe(journalSchema, await adapter.readJournal());
      if (JSON.stringify({ ...previous.plan, client }) !== JSON.stringify(p)) throw new SetupError('invalid_state');
      const journal = { ...previous, plan: p, revision: previous.revision + 1, cancelled: false };
      status = reconcile(journal, await adapter.inspect(p));
      if (status.error_code === null) await adapter.writeJournal(journal);
      return status;
    });
  } catch (err) {
    return failure({ ...status, checks: emptyChecks(p.client) }, safeError(err));
  }
}
