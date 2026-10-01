import type { ChannelNiche } from 'channel-scope-shared';

const NICHE_KEYWORDS: Record<Exclude<ChannelNiche, 'unknown'>, string[]> = {
  crypto: [
    'crypto', 'bitcoin', 'btc', 'ethereum', 'eth', 'blockchain', 'defi', 'nft',
    'token', 'altcoin', 'web3', 'mining', 'wallet', 'binance', 'exchange',
    'крипто', 'биткоин', 'блокчейн', 'токен', 'майнинг',
  ],
  finance: [
    'finance', 'invest', 'stock', 'trading', 'forex', 'market', 'economy',
    'банк', 'инвест', 'акции', 'трейдинг', 'финанс', 'бизнес', 'business',
    'dividend', 'portfolio', 'fund',
  ],
  news: [
    'news', 'breaking', 'headline', 'report', 'journalist', 'media',
    'новости', 'сводка', 'репортаж', 'сми', 'газета',
  ],
  entertainment: [
    'movie', 'film', 'music', 'game', 'gaming', 'anime', 'series', 'show',
    'кино', 'фильм', 'музыка', 'игры', 'аниме', 'сериал',
  ],
  tech: [
    'tech', 'programming', 'software', 'developer', 'code', 'startup',
    'ai', 'machine learning', 'devops', 'linux', 'apple', 'android',
    'технолог', 'программ', 'разработ', 'стартап',
  ],
  humor: [
    'meme', 'funny', 'humor', 'joke', 'lol', 'comedy', 'laugh',
    'мем', 'юмор', 'шутк', 'прикол', 'смех', 'ржач',
  ],
  education: [
    'education', 'learn', 'course', 'tutorial', 'study', 'university',
    'обучен', 'курс', 'урок', 'учеб', 'универ', 'знани',
  ],
  lifestyle: [
    'lifestyle', 'fashion', 'food', 'travel', 'health', 'fitness', 'beauty',
    'стиль жизни', 'мода', 'еда', 'путешеств', 'здоровь', 'фитнес',
  ],
  politics: [
    'politic', 'government', 'election', 'parliament', 'democrat', 'republic',
    'полити', 'правительств', 'выбор', 'парламент', 'депутат',
  ],
  sports: [
    'sport', 'football', 'soccer', 'basketball', 'tennis', 'hockey',
    'спорт', 'футбол', 'баскетбол', 'теннис', 'хоккей',
  ],
};

/**
 * Detect the channel niche from its description and sample post texts.
 * Uses simple keyword frequency matching.
 */
export function detectNiche(description: string, postTexts: string[]): ChannelNiche {
  const combined = [description, ...postTexts.slice(0, 50)].join(' ').toLowerCase();

  const scores: Partial<Record<ChannelNiche, number>> = {};

  for (const [niche, keywords] of Object.entries(NICHE_KEYWORDS) as [Exclude<ChannelNiche, 'unknown'>, string[]][]) {
    let count = 0;
    for (const kw of keywords) {
      // Count occurrences using word boundaries to avoid partial matches (e.g. "eth" in "method")
      const re = new RegExp('\\b' + kw + '\\b', 'gi');
      const matches = combined.match(re);
      if (matches) count += matches.length;
    }
    if (count > 0) {
      scores[niche] = count;
    }
  }

  const entries = Object.entries(scores) as [ChannelNiche, number][];
  if (entries.length === 0) return 'unknown';

  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0];
}
