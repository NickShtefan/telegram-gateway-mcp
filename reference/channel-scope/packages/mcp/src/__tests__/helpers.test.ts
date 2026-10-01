import { describe, it, expect } from 'vitest';
import {
  parseTokenCookie,
  buildUrl,
  buildHeaders,
  filterChannels,
  buildStatusUpdate,
  CHANNEL_STATUSES,
} from '../helpers.js';

describe('parseTokenCookie', () => {
  it('extracts token from simple Set-Cookie header', () => {
    expect(parseTokenCookie('token=abc123')).toBe('token=abc123');
  });

  it('extracts token from Set-Cookie with attributes', () => {
    expect(parseTokenCookie('token=abc123; Path=/; HttpOnly; Secure; SameSite=Lax'))
      .toBe('token=abc123');
  });

  it('extracts token when header has multiple cookies', () => {
    expect(parseTokenCookie('token=jwt.value.here; Path=/, other=foo'))
      .toBe('token=jwt.value.here');
  });

  it('handles JWT-style token values with dots', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(parseTokenCookie(`token=${jwt}; HttpOnly`)).toBe(`token=${jwt}`);
  });

  it('returns empty string for null header', () => {
    expect(parseTokenCookie(null)).toBe('');
  });

  it('returns empty string when no token cookie present', () => {
    expect(parseTokenCookie('session=abc; Path=/')).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(parseTokenCookie('')).toBe('');
  });
});

describe('buildUrl', () => {
  const base = 'http://localhost:3001';

  it('builds URL without params', () => {
    expect(buildUrl(base, '/api/channels')).toBe('http://localhost:3001/api/channels');
  });

  it('appends query params', () => {
    const url = buildUrl(base, '/api/search', { q: 'crypto', limit: 20 });
    expect(url).toContain('q=crypto');
    expect(url).toContain('limit=20');
  });

  it('skips undefined params', () => {
    const url = buildUrl(base, '/api/search', { q: 'test', limit: undefined });
    expect(url).toContain('q=test');
    expect(url).not.toContain('limit');
  });

  it('converts numbers to strings', () => {
    const url = buildUrl(base, '/api/test', { page: 5 });
    expect(url).toContain('page=5');
  });

  it('encodes special characters in params', () => {
    const url = buildUrl(base, '/api/search', { q: '@username' });
    expect(url).toContain('q=%40username');
  });
});

describe('buildHeaders', () => {
  it('returns empty object when no auth cookie', () => {
    expect(buildHeaders('')).toEqual({});
  });

  it('includes Cookie header when auth cookie is set', () => {
    expect(buildHeaders('token=abc')).toEqual({ Cookie: 'token=abc' });
  });
});

describe('filterChannels', () => {
  const mockChannels = [
    {
      channelId: 'ch1',
      status: 'analyzed',
      subscriberCount: 50000,
      analytics: { score: { total: 85 } },
    },
    {
      channelId: 'ch2',
      status: 'discovered',
      subscriberCount: 1000,
      analytics: null,
    },
    {
      channelId: 'ch3',
      status: 'analyzed',
      subscriberCount: 200000,
      analytics: { score: { total: 45 } },
    },
    {
      channelId: 'ch4',
      status: 'downloaded',
      subscriberCount: 10000,
      analytics: { score: { total: 72 } },
    },
  ] as Array<Record<string, unknown>>;

  it('returns all channels with no filters', () => {
    expect(filterChannels(mockChannels, {})).toHaveLength(4);
  });

  it('filters by status', () => {
    const result = filterChannels(mockChannels, { status: 'analyzed' });
    expect(result).toHaveLength(2);
    expect(result.every(ch => ch.status === 'analyzed')).toBe(true);
  });

  it('filters by minScore', () => {
    const result = filterChannels(mockChannels, { minScore: 70 });
    expect(result).toHaveLength(2);
    expect(result.map(ch => ch.channelId)).toEqual(['ch1', 'ch4']);
  });

  it('filters by maxScore', () => {
    const result = filterChannels(mockChannels, { maxScore: 50 });
    // ch2 has no analytics (score=0), ch3 has 45
    expect(result).toHaveLength(2);
    expect(result.map(ch => ch.channelId)).toEqual(['ch2', 'ch3']);
  });

  it('filters by minSubs', () => {
    const result = filterChannels(mockChannels, { minSubs: 50000 });
    expect(result).toHaveLength(2);
    expect(result.map(ch => ch.channelId)).toEqual(['ch1', 'ch3']);
  });

  it('filters by maxSubs', () => {
    const result = filterChannels(mockChannels, { maxSubs: 10000 });
    expect(result).toHaveLength(2);
    expect(result.map(ch => ch.channelId)).toEqual(['ch2', 'ch4']);
  });

  it('combines multiple filters', () => {
    const result = filterChannels(mockChannels, {
      status: 'analyzed',
      minScore: 50,
    });
    expect(result).toHaveLength(1);
    expect(result[0].channelId).toBe('ch1');
  });

  it('handles channels without analytics (score defaults to 0)', () => {
    const result = filterChannels(mockChannels, { minScore: 1 });
    // ch2 has no analytics, so score=0, should be excluded
    expect(result.find(ch => ch.channelId === 'ch2')).toBeUndefined();
  });

  it('returns empty array when no channels match', () => {
    const result = filterChannels(mockChannels, { minScore: 99 });
    expect(result).toHaveLength(0);
  });

  it('handles empty input array', () => {
    expect(filterChannels([], { minScore: 50 })).toHaveLength(0);
  });
});

describe('buildStatusUpdate', () => {
  it('returns status only when no note provided', () => {
    expect(buildStatusUpdate('shortlist')).toEqual({ status: 'shortlist' });
  });

  it('includes notes when note is provided', () => {
    expect(buildStatusUpdate('contacted', 'sent DM')).toEqual({
      status: 'contacted',
      notes: 'sent DM',
    });
  });

  it('omits notes when note is an empty string', () => {
    expect(buildStatusUpdate('rejected', '')).toEqual({ status: 'rejected' });
  });

  it('supports the new shortlist status', () => {
    expect(CHANNEL_STATUSES).toContain('shortlist');
    expect(buildStatusUpdate('shortlist', 'worth a closer look')).toEqual({
      status: 'shortlist',
      notes: 'worth a closer look',
    });
  });

  it('covers all pipeline stages in enum', () => {
    expect([...CHANNEL_STATUSES]).toEqual([
      'discovered',
      'downloaded',
      'analyzed',
      'shortlist',
      'contacted',
      'partner',
      'rejected',
    ]);
  });
});
