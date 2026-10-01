/**
 * Нормализация реакций. Ключ реакции един для MTProto и Bot API:
 * обычный эмодзи это сам эмодзи, кастомный `custom:<id>`, платная `paid`.
 * Перенесено из helper `processors/reactionKey.ts` и `refreshShared.ts`.
 */

interface ReactionLike {
  // Bot API ReactionType
  type?: string;
  emoji?: string;
  custom_emoji_id?: string;
  // teleproto Api.Reaction*
  className?: string;
  emoticon?: string;
  documentId?: unknown;
}

export interface ReactionCount {
  reaction: string;
  count: number;
}

export function reactionKey(reaction: unknown): string {
  const r = reaction as ReactionLike | null | undefined;
  if (!r || typeof r !== 'object') return JSON.stringify(r ?? null);

  if (typeof r.emoji === 'string' && r.emoji) return r.emoji;
  if (typeof r.emoticon === 'string' && r.emoticon) return r.emoticon;

  if (typeof r.custom_emoji_id === 'string' && r.custom_emoji_id) {
    return `custom:${r.custom_emoji_id}`;
  }
  if (r.documentId !== undefined && r.documentId !== null) {
    return `custom:${String(r.documentId)}`;
  }

  if (r.type === 'paid' || r.className === 'ReactionPaid') return 'paid';

  return JSON.stringify(r);
}

interface MessageReactionsLike {
  results?: Array<{ reaction?: unknown; count?: unknown } | null | undefined>;
}

/** `message.reactions` из teleproto -> список счётчиков, по убыванию. */
export function normalizeReactions(messageReactions: unknown): ReactionCount[] {
  const mr = messageReactions as MessageReactionsLike | null | undefined;
  if (!mr || !Array.isArray(mr.results) || mr.results.length === 0) return [];
  const out: ReactionCount[] = [];
  for (const result of mr.results) {
    if (result && result.reaction && typeof result.count === 'number') {
      out.push({ reaction: reactionKey(result.reaction), count: result.count });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

export function totalReactions(reactions: ReactionCount[]): number {
  return reactions.reduce((sum, r) => sum + r.count, 0);
}
