import { describe, it, expect } from 'vitest';
import { reactionKey } from '../reactionKey.js';

describe('reactionKey — единый ключ для Bot API и GramJS форм', () => {
  it('plain emoji: обе формы дают сам эмодзи', () => {
    expect(reactionKey({ type: 'emoji', emoji: '👍' })).toBe('👍');
    expect(reactionKey({ className: 'ReactionEmoji', emoticon: '👍' })).toBe('👍');
  });

  it('custom emoji: одинаковый ключ из Bot API custom_emoji_id и GramJS documentId', () => {
    const botApi = reactionKey({ type: 'custom_emoji', custom_emoji_id: '5368324170671202286' });
    const gramJs = reactionKey({ className: 'ReactionCustomEmoji', documentId: BigInt('5368324170671202286') });
    expect(botApi).toBe('custom:5368324170671202286');
    expect(gramJs).toBe(botApi);
  });

  it('устаревшая форма типов проекта (type=custom_emoji_id) тоже нормализуется', () => {
    expect(reactionKey({ type: 'custom_emoji_id', custom_emoji_id: '123' })).toBe('custom:123');
  });

  it('paid: обе формы дают "paid"', () => {
    expect(reactionKey({ type: 'paid' })).toBe('paid');
    expect(reactionKey({ className: 'ReactionPaid' })).toBe('paid');
  });

  it('неизвестная форма — детерминированный JSON-fallback', () => {
    expect(reactionKey({ weird: true })).toBe('{"weird":true}');
    expect(reactionKey(null)).toBe('null');
  });
});
