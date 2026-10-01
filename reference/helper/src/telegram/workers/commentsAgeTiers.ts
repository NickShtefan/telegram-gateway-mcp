import { envNumber } from '../utils/env.js';

const DEFAULT_CUTOFF_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Интервал (мс) до следующего обхода треда комментариев. Дискуссия — не views:
 * активность фронт-лоадится в первые сутки-двое, поэтому лесенка короче
 * статистической, но НЕ паркуется жёстко на 14 днях — после них тред
 * проверяется раз в неделю до cutoff (COMMENTS_REFRESH_CUTOFF_DAYS, 30 дн).
 * Ранние ярусы реже статистических: новизну несёт realtime-слой, воркер —
 * сверщик (удаления, точные счётчики реакций, пропуски).
 */
export function getCommentsRefreshInterval(effectiveDate: Date, now: Date = new Date()): number | null {
  const cutoffDays = envNumber('COMMENTS_REFRESH_CUTOFF_DAYS', DEFAULT_CUTOFF_DAYS);
  const ageMs = now.getTime() - effectiveDate.getTime();
  if (ageMs >= cutoffDays * DAY_MS) return null;
  if (ageMs < 60 * 60 * 1000) return 10 * 60 * 1000;
  if (ageMs < 6 * 60 * 60 * 1000) return 30 * 60 * 1000;
  if (ageMs < 24 * 60 * 60 * 1000) return 2 * 60 * 60 * 1000;
  if (ageMs < 3 * DAY_MS) return 6 * 60 * 60 * 1000;
  if (ageMs < 7 * DAY_MS) return 24 * 60 * 60 * 1000;
  if (ageMs < 14 * DAY_MS) return 48 * 60 * 60 * 1000;
  return 7 * DAY_MS;
}

/**
 * Следующий Date обхода. Возраст — ЭФФЕКТИВНЫЙ: max(дата поста, дата самого
 * свежего сохранённого комментария), чтобы живой тред на старом посте не
 * выпадал из расписания.
 */
export function getNextCommentsRefreshAt(
  postDate: Date,
  newestCommentDate: Date | null,
  now: Date = new Date()
): Date | null {
  const effective =
    newestCommentDate && newestCommentDate.getTime() > postDate.getTime()
      ? newestCommentDate
      : postDate;
  const interval = getCommentsRefreshInterval(effective, now);
  if (interval === null) return null;
  return new Date(now.getTime() + interval);
}
