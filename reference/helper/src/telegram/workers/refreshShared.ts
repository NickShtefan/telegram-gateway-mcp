import { runExclusive } from '../client/gramGate.js';
import { requestGramProcessRestart } from '../client/gramFatalRecovery.js';
import { reactionKey } from '../processors/reactionKey.js';
import type { GramJSReactions, IReaction } from '../../types/index.js';

export { envNumber } from '../utils/env.js';

/**
 * Общий каркас фоновых воркеров (StatsRefresher / CommentsRefresher):
 * дедлайны на GramJS-вызовы, FLOOD_WAIT-парсинг, нормализация реакций.
 * Вынесено из statsRefresher.ts без изменения поведения (#82 остаётся в силе).
 */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class StageTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(`${stage} timed out after ${timeoutMs}ms`);
    this.name = 'StageTimeoutError';
  }
}

/**
 * Ограничивает внешний await дедлайном: GramJS-промисы при сетевых/DNS сбоях
 * могут не сеттлиться вообще, и тогда re-entrancy guard воркера никогда не
 * снимается (#81).
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StageTimeoutError(stage, timeoutMs)), timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Один MTProto-этап: сериализация через gramGate + дедлайн + warn-лог таймаута.
 * Таймаут ВНУТРИ гейта — зависший вызов освобождает полосу по дедлайну.
 */
export async function runStage<T>(
  workerTag: string,
  stage: string,
  label: string,
  timeoutMs: number,
  op: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await runExclusive(`${workerTag} ${stage}`, () => withTimeout(op(), timeoutMs, stage));
  } catch (err) {
    if (err instanceof StageTimeoutError) {
      console.warn(
        `${workerTag} ${stage} timed out for ${label} after ${Date.now() - startedAt}ms (limit ${timeoutMs}ms)`
      );
      requestGramProcessRestart(
        `${workerTag.replace(/^\[|\]$/g, '')} ${stage} timed out for ${label}`
      );
    }
    throw err;
  }
}

interface FloodWaitLike {
  seconds?: number;
  message?: string;
}

export function getFloodWaitSeconds(err: unknown): number | null {
  const e = err as FloodWaitLike | null;
  if (!e) return null;
  if (typeof e.seconds === 'number' && Number.isFinite(e.seconds)) {
    return e.seconds;
  }
  const msg = typeof e.message === 'string' ? e.message : '';
  if (msg.includes('FLOOD_WAIT')) {
    const m = msg.match(/FLOOD_WAIT[_ ]?(\d+)/);
    if (m) return parseInt(m[1], 10);
    return 0;
  }
  return null;
}

export function isChannelInvalid(err: unknown): boolean {
  const e = err as FloodWaitLike | null;
  const msg = e && typeof e.message === 'string' ? e.message : '';
  return msg.includes('CHANNEL_INVALID') || msg.includes('PEER_ID_INVALID');
}

export function isMsgIdInvalid(err: unknown): boolean {
  const e = err as FloodWaitLike | null;
  const msg = e && typeof e.message === 'string' ? e.message : '';
  return msg.includes('MSG_ID_INVALID');
}

/** CHANNEL_PRIVATE — исправимо владельцем (юзербот не участник приватной группы), НЕ терминально. */
export function isChannelPrivate(err: unknown): boolean {
  const e = err as FloodWaitLike | null;
  const msg = e && typeof e.message === 'string' ? e.message : '';
  return msg.includes('CHANNEL_PRIVATE');
}

/**
 * Нормализует reactions с message.reactions (GramJS MTProto) в IReaction[]
 * для ПОСТОВ — исторический формат ключей (JSON.stringify для кастомных)
 * сохранён, чтобы откат не чередовал форматы в stats.reactions.
 */
export function processGramReactions(messageReactions: GramJSReactions | undefined | null): IReaction[] {
  if (
    !messageReactions ||
    !Array.isArray(messageReactions.results) ||
    messageReactions.results.length === 0
  ) {
    return [];
  }
  const reactionsArray: IReaction[] = [];
  for (const result of messageReactions.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      const reactionKeyStr = result.reaction.emoticon
        ? result.reaction.emoticon.toString()
        : JSON.stringify(result.reaction);
      reactionsArray.push({ reaction: reactionKeyStr, count: result.count });
    }
  }
  return reactionsArray;
}

/**
 * То же для КОММЕНТАРИЕВ — через общий reactionKey(), чтобы GramJS-воркер и
 * Bot API-realtime давали идентичные ключи (custom:<id> / paid / эмодзи).
 */
export function processGramCommentReactions(messageReactions: GramJSReactions | undefined | null): IReaction[] {
  if (
    !messageReactions ||
    !Array.isArray(messageReactions.results) ||
    messageReactions.results.length === 0
  ) {
    return [];
  }
  const reactionsArray: IReaction[] = [];
  for (const result of messageReactions.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      reactionsArray.push({ reaction: reactionKey(result.reaction), count: result.count });
    }
  }
  return reactionsArray;
}
