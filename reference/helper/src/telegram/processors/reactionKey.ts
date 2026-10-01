/**
 * Единый нормализатор ключа реакции для КОММЕНТАРИЕВ.
 * Комментарии пишутся двумя стеками (Bot API realtime и GramJS-воркер), и один и тот же
 * ключ обязан получаться из обеих форм, иначе счётчики будут дрожать между писателями:
 *   обычный эмодзи  -> сам эмодзи ('👍')
 *   кастомный эмодзи -> 'custom:<document_id>'
 *   платная (звёзды) -> 'paid'
 *   неизвестная форма -> JSON.stringify (детерминированный fallback)
 *
 * ВАЖНО: у постов исторически другой формат (JSON.stringify для кастомных) — его не
 * трогаем, чтобы откат не чередовал форматы в одном поле (design §4.1).
 */

interface ReactionLike {
  // Bot API ReactionType
  type?: string;
  emoji?: string;
  custom_emoji_id?: string;
  // GramJS Api.Reaction*
  className?: string;
  emoticon?: string;
  documentId?: unknown;
}

export function reactionKey(reaction: unknown): string {
  const r = reaction as ReactionLike | null | undefined;
  if (!r || typeof r !== 'object') return JSON.stringify(r ?? null);

  // Обычный эмодзи: Bot API {type:'emoji', emoji} / GramJS ReactionEmoji {emoticon}
  if (typeof r.emoji === 'string' && r.emoji) return r.emoji;
  if (typeof r.emoticon === 'string' && r.emoticon) return r.emoticon;

  // Кастомный эмодзи: Bot API {type:'custom_emoji', custom_emoji_id} /
  // GramJS ReactionCustomEmoji {documentId: BigInteger}
  if (typeof r.custom_emoji_id === 'string' && r.custom_emoji_id) {
    return `custom:${r.custom_emoji_id}`;
  }
  if (r.documentId !== undefined && r.documentId !== null) {
    return `custom:${String(r.documentId)}`;
  }

  // Платная реакция: Bot API {type:'paid'} / GramJS ReactionPaid
  if (r.type === 'paid' || r.className === 'ReactionPaid') return 'paid';

  return JSON.stringify(r);
}
