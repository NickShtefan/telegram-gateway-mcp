/** Bounded private pipe protocol. Only fixed prompts and closed public results cross the worker boundary. */
import { z } from 'zod';
import type { Readable, Writable } from 'node:stream';
import type { CliIo } from '../cli/io.js';
import { ownerPlanSchema } from './owner.js';
import { setupIdSchema, SetupError } from './contract.js';

export const questions = {
  api_id: 'Telegram application id: ', api_hash: 'Telegram application hash: ',
  phone: 'Telegram phone (international format): ', code: 'Telegram verification code: ', password: 'Telegram two-factor password: ',
} as const;
const questionSchema = z.enum(['api_id', 'api_hash', 'phone', 'code', 'password']);
export const ownerResultSchema = z.strictObject({ format_version: z.literal(1), setup_id: setupIdSchema,
  phase: z.enum(['needs_client_configuration', 'needs_existing_client_credential', 'failed']),
  error_code: z.enum(['invalid_owner_input', 'owner_step_failed']).nullable() });
export const workerMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prompt'), sequence: z.number().int().positive(), question: questionSchema }),
  z.strictObject({ kind: z.literal('result'), result: ownerResultSchema }),
]);
export const coordinatorMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('plan'), plan: ownerPlanSchema }),
  z.strictObject({ kind: z.literal('answer'), sequence: z.number().int().positive(), value: z.string().max(512) }),
]);
/** No readline buffering: reject oversized/partial/multiple queued messages before allocating more. */
export function privateLines(input: Readable, maximum = 2048): AsyncIterable<string> {
  return { async *[Symbol.asyncIterator]() {
    let pending = Buffer.alloc(0);
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // A sender may coalesce frames, but each frame is bounded independently.
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        if (pending.length + i - start > maximum) throw new SetupError('invalid_state');
        const line = Buffer.concat([pending, bytes.subarray(start, i)]).toString('utf8');
        pending = Buffer.alloc(0); start = i + 1; yield line;
      }
      if (pending.length + bytes.length - start > maximum) throw new SetupError('invalid_state');
      pending = Buffer.concat([pending, bytes.subarray(start)]);
    }
    if (pending.length) throw new SetupError('invalid_state');
  } };
}
export async function sendPrivate(output: Writable, message: unknown): Promise<void> {
  const bytes = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(bytes) > 2049) throw new SetupError('invalid_state');
  await new Promise<void>((resolve, reject) => output.write(bytes, err => err ? reject(new SetupError('invalid_state')) : resolve()));
}
export function workerIo(input: AsyncIterator<string>, output: Writable): CliIo {
  let sequence = 0;
  return { out: () => { throw new SetupError('invalid_state'); }, err: () => undefined,
    prompt: async (question, options) => {
      const key = (Object.keys(questions) as Array<keyof typeof questions>).find(k => questions[k] === question);
      if (!key || !options?.hidden) throw new SetupError('invalid_state');
      const current = ++sequence;
      await sendPrivate(output, { kind: 'prompt', sequence: current, question: key });
      const next = await input.next(); if (next.done) throw new SetupError('invalid_state');
      const answer = coordinatorMessageSchema.parse(JSON.parse(next.value));
      if (answer.kind !== 'answer' || answer.sequence !== current) throw new SetupError('invalid_state');
      return answer.value;
    } };
}
