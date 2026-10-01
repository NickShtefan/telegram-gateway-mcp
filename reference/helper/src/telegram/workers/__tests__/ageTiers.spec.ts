import { describe, it, expect } from 'vitest';
import { getRefreshInterval, getNextRefreshAt } from '../ageTiers.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('getRefreshInterval', () => {
  const now = new Date('2026-04-15T12:00:00Z');

  it('returns 15 min when post is younger than 1 hour', () => {
    const postDate = new Date(now.getTime() - 30 * MIN);
    expect(getRefreshInterval(postDate, now)).toBe(15 * MIN);
  });

  it('tier boundary: exactly 1 hour old moves to next tier', () => {
    const postDate = new Date(now.getTime() - HOUR);
    expect(getRefreshInterval(postDate, now)).toBe(HOUR);
  });

  it('returns 1 hour when post is between 1 and 6 hours old', () => {
    const postDate = new Date(now.getTime() - 3 * HOUR);
    expect(getRefreshInterval(postDate, now)).toBe(HOUR);
  });

  it('tier boundary: exactly 6 hours old moves to next tier', () => {
    const postDate = new Date(now.getTime() - 6 * HOUR);
    expect(getRefreshInterval(postDate, now)).toBe(3 * HOUR);
  });

  it('returns 3 hours when post is between 6 and 24 hours old', () => {
    const postDate = new Date(now.getTime() - 12 * HOUR);
    expect(getRefreshInterval(postDate, now)).toBe(3 * HOUR);
  });

  it('tier boundary: exactly 24 hours old moves to next tier', () => {
    const postDate = new Date(now.getTime() - DAY);
    expect(getRefreshInterval(postDate, now)).toBe(12 * HOUR);
  });

  it('returns 12 hours when post is between 1 and 7 days old', () => {
    const postDate = new Date(now.getTime() - 3 * DAY);
    expect(getRefreshInterval(postDate, now)).toBe(12 * HOUR);
  });

  it('tier boundary: exactly 7 days old moves to next tier', () => {
    const postDate = new Date(now.getTime() - 7 * DAY);
    expect(getRefreshInterval(postDate, now)).toBe(48 * HOUR);
  });

  it('returns 48 hours when post is between 7 and 30 days old', () => {
    const postDate = new Date(now.getTime() - 15 * DAY);
    expect(getRefreshInterval(postDate, now)).toBe(48 * HOUR);
  });

  it('tier boundary: exactly 30 days old returns null (past cutoff)', () => {
    const postDate = new Date(now.getTime() - 30 * DAY);
    expect(getRefreshInterval(postDate, now)).toBeNull();
  });

  it('returns null when post is older than 30 days', () => {
    const postDate = new Date(now.getTime() - 45 * DAY);
    expect(getRefreshInterval(postDate, now)).toBeNull();
  });
});

describe('getNextRefreshAt', () => {
  const now = new Date('2026-04-15T12:00:00Z');

  it('adds interval to now for a fresh post', () => {
    const postDate = new Date(now.getTime() - 5 * MIN);
    const next = getNextRefreshAt(postDate, now);
    expect(next).not.toBeNull();
    expect(next!.getTime() - now.getTime()).toBe(15 * MIN);
  });

  it('returns null for posts past the cutoff', () => {
    const postDate = new Date(now.getTime() - 40 * DAY);
    expect(getNextRefreshAt(postDate, now)).toBeNull();
  });
});
