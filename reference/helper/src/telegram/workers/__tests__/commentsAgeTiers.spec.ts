import { describe, it, expect, afterEach } from 'vitest';
import { getCommentsRefreshInterval, getNextCommentsRefreshAt } from '../commentsAgeTiers.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('commentsAgeTiers', () => {
  afterEach(() => {
    delete process.env.COMMENTS_REFRESH_CUTOFF_DAYS;
  });

  it('лесенка по возрасту', () => {
    const now = new Date('2026-08-13T12:00:00Z');
    const at = (ageMs: number): Date => new Date(now.getTime() - ageMs);

    expect(getCommentsRefreshInterval(at(30 * MIN), now)).toBe(10 * MIN);
    expect(getCommentsRefreshInterval(at(3 * HOUR), now)).toBe(30 * MIN);
    expect(getCommentsRefreshInterval(at(12 * HOUR), now)).toBe(2 * HOUR);
    expect(getCommentsRefreshInterval(at(2 * DAY), now)).toBe(6 * HOUR);
    expect(getCommentsRefreshInterval(at(5 * DAY), now)).toBe(24 * HOUR);
    expect(getCommentsRefreshInterval(at(10 * DAY), now)).toBe(48 * HOUR);
    // после 14 дней — НЕ парковка, а еженедельная проверка до cutoff
    expect(getCommentsRefreshInterval(at(20 * DAY), now)).toBe(7 * DAY);
    expect(getCommentsRefreshInterval(at(31 * DAY), now)).toBeNull();
  });

  it('границы ярусов: ровно на границе действует следующий ярус', () => {
    const now = new Date('2026-08-13T12:00:00Z');
    const at = (ageMs: number): Date => new Date(now.getTime() - ageMs);

    expect(getCommentsRefreshInterval(at(HOUR), now)).toBe(30 * MIN);
    expect(getCommentsRefreshInterval(at(14 * DAY), now)).toBe(7 * DAY);
    expect(getCommentsRefreshInterval(at(30 * DAY), now)).toBeNull();
  });

  it('COMMENTS_REFRESH_CUTOFF_DAYS переопределяет горизонт', () => {
    process.env.COMMENTS_REFRESH_CUTOFF_DAYS = '14';
    const now = new Date('2026-08-13T12:00:00Z');
    expect(getCommentsRefreshInterval(new Date(now.getTime() - 20 * DAY), now)).toBeNull();
  });

  it('эффективный возраст: свежий комментарий на старом посте держит тред в расписании', () => {
    const now = new Date('2026-08-13T12:00:00Z');
    const postDate = new Date(now.getTime() - 20 * DAY);
    const freshComment = new Date(now.getTime() - 3 * HOUR);

    // без комментариев: еженедельный ярус
    const weekly = getNextCommentsRefreshAt(postDate, null, now);
    expect(weekly?.getTime()).toBe(now.getTime() + 7 * DAY);

    // с активным тредом: ярус <6ч
    const active = getNextCommentsRefreshAt(postDate, freshComment, now);
    expect(active?.getTime()).toBe(now.getTime() + 30 * MIN);
  });

  it('за cutoff -> null (парковка)', () => {
    const now = new Date('2026-08-13T12:00:00Z');
    expect(getNextCommentsRefreshAt(new Date(now.getTime() - 45 * DAY), null, now)).toBeNull();
  });
});
