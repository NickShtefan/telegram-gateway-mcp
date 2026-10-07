/** Secret-free setup contracts. Never surface parser errors or raw adapter errors. */
import { z } from 'zod';

export const setupIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const clientSchema = z.enum(['none', 'codex']);
export const stageSchema = z.enum([
  'preflight_ready', 'needs_system_approval', 'needs_api_credentials', 'needs_telegram_login',
  'needs_access_selection', 'needs_client_configuration', 'needs_service_verification',
  'needs_client_reload', 'needs_client_verification', 'gateway_ready', 'ready', 'cancelled', 'failed',
]);
export const errorSchema = z.enum([
  'invalid_request', 'unsupported_platform', 'unsupported_architecture', 'port_unavailable',
  'unsupported_os_version',
  'inspection_failed', 'existing_installation_requires_review', 'update_unsupported',
  'invalid_state', 'setup_busy', 'adapter_failed', 'status_unavailable', 'unsafe_progress',
  'stale_progress', 'artifact_unverified', 'protection_unverified', 'verification_failed',
]);
export type SetupErrorCode = z.infer<typeof errorSchema>;

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode) { super(code); }
}

export const checksSchema = z.strictObject({
  artifact: z.enum(['not_checked', 'passed', 'failed']),
  installation: z.enum(['not_checked', 'passed', 'failed']),
  service: z.enum(['not_checked', 'passed', 'failed']),
  authenticated_mcp: z.enum(['not_checked', 'passed', 'failed']),
  client_configuration: z.enum(['not_selected', 'pending', 'passed', 'failed']),
  client_tools: z.enum(['not_selected', 'pending', 'passed', 'failed']),
});
export type Checks = z.infer<typeof checksSchema>;
export const statusSchema = z.strictObject({
  format_version: z.literal(1),
  setup_id: setupIdSchema,
  revision: z.number().int().nonnegative(),
  stage: stageSchema,
  outcome: z.enum(['waiting_for_owner', 'pending', 'complete', 'cancelled', 'failed']),
  error_code: errorSchema.nullable(),
  next_action: z.enum([
    'review_plan', 'open_protected_owner_application', 'verify_service', 'configure_client',
    'reload_client', 'verify_client_tools', 'resume_setup', 'review_existing_installation',
    'use_update_workflow', 'retry_inspection', 'wait_for_setup', 'none',
  ]),
  checks: checksSchema,
}).superRefine((s, ctx) => {
  const gateway = s.checks.artifact === 'passed' && s.checks.installation === 'passed'
    && s.checks.service === 'passed' && s.checks.authenticated_mcp === 'passed';
  if ((s.stage === 'ready' || s.stage === 'gateway_ready') && !gateway) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent readiness' });
  }
  if (s.stage === 'ready' && (s.checks.client_configuration !== 'passed' || s.checks.client_tools !== 'passed')) {
    ctx.addIssue({ code: 'custom', message: 'missing client evidence' });
  }
  if (s.stage === 'gateway_ready' && (s.checks.client_configuration !== 'not_selected' || s.checks.client_tools !== 'not_selected')) {
    ctx.addIssue({ code: 'custom', message: 'selected client remains pending' });
  }
  if ((s.outcome === 'complete') !== (s.stage === 'ready' || s.stage === 'gateway_ready')) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent outcome' });
  }
  if ((s.outcome === 'failed') !== (s.stage === 'failed') || (s.outcome === 'cancelled') !== (s.stage === 'cancelled')) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent terminal state' });
  }
  if ((s.stage === 'failed') !== (s.error_code !== null)) {
    ctx.addIssue({ code: 'custom', message: 'inconsistent error' });
  }
});
export type SetupStatus = z.infer<typeof statusSchema>;

export const planSchema = z.strictObject({
  format_version: z.literal(1), setup_id: setupIdSchema,
  source_sha: z.string().regex(/^[0-9a-f]{40}$/),
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Compatibility metadata only; the artifact adapter separately verifies tested LTS policy.
  node_version: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/),
  architecture: z.enum(['arm64', 'x64']),
  port: z.number().int().min(1).max(65535), client: clientSchema,
});
export type SetupPlan = z.infer<typeof planSchema>;

export function parseSafe<T>(schema: z.ZodType<T>, value: unknown, code: SetupErrorCode = 'invalid_state'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new SetupError(code);
  return result.data;
}

export function safeError(err: unknown): SetupErrorCode {
  return err instanceof SetupError && errorSchema.safeParse(err.code).success ? err.code : 'adapter_failed';
}

export function emptyChecks(client: 'none' | 'codex'): Checks {
  return {
    artifact: 'not_checked', installation: 'not_checked', service: 'not_checked', authenticated_mcp: 'not_checked',
    client_configuration: client === 'none' ? 'not_selected' : 'pending',
    client_tools: client === 'none' ? 'not_selected' : 'pending',
  };
}
