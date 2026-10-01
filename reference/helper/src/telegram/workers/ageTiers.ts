/**
 * Возвращает интервал (мс) до следующего обновления статистики поста.
 * Чем старше пост — тем реже обновляем, потому что views/reactions у старых
 * постов практически не меняются. Вернёт null, если пост перешагнул cutoff
 * и обновлять его больше не нужно.
 */
export function getRefreshInterval(postDate: Date, now: Date = new Date()): number | null {
  const ageMs = now.getTime() - postDate.getTime();
  if (ageMs < 60 * 60 * 1000) return 15 * 60 * 1000;
  if (ageMs < 6 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (ageMs < 24 * 60 * 60 * 1000) return 3 * 60 * 60 * 1000;
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return 12 * 60 * 60 * 1000;
  if (ageMs < 30 * 24 * 60 * 60 * 1000) return 48 * 60 * 60 * 1000;
  return null;
}

/**
 * Возвращает конкретный Date следующего обновления (now + interval) либо null,
 * если пост уже за cutoff — тогда обновления прекращаются.
 */
export function getNextRefreshAt(postDate: Date, now: Date = new Date()): Date | null {
  const interval = getRefreshInterval(postDate, now);
  if (interval === null) return null;
  return new Date(now.getTime() + interval);
}
