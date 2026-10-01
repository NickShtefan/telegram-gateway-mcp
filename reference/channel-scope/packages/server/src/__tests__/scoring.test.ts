import { describe, it, expect } from 'vitest';
import { lerp, computeScore } from '../services/scoring.js';
import { detectBotRisk } from '../services/botDetection.js';
import { detectNiche } from '../services/detectNiche.js';

// ---------------------------------------------------------------------------
// lerp
// ---------------------------------------------------------------------------
describe('lerp', () => {
  describe('normal mode (ok < good, higher is better)', () => {
    const ok = 15;
    const good = 30;

    it('returns 0 when value is 0', () => {
      expect(lerp(0, ok, good)).toBe(0);
    });

    it('returns 0 for negative values', () => {
      expect(lerp(-5, ok, good)).toBe(0);
    });

    it('returns 50 at ok boundary', () => {
      expect(lerp(ok, ok, good)).toBe(50);
    });

    it('returns 100 at good boundary', () => {
      expect(lerp(good, ok, good)).toBe(100);
    });

    it('returns 100 above good', () => {
      expect(lerp(50, ok, good)).toBe(100);
    });

    it('interpolates between 0 and ok', () => {
      const result = lerp(7.5, ok, good);
      expect(result).toBe(25);
    });

    it('interpolates between ok and good', () => {
      const result = lerp(22.5, ok, good);
      expect(result).toBe(75);
    });
  });

  describe('inverted mode (ok > good, lower is better)', () => {
    const ok = 40;
    const good = 20;

    it('returns 100 when value is at or below good', () => {
      expect(lerp(20, ok, good)).toBe(100);
      expect(lerp(10, ok, good)).toBe(100);
    });

    it('returns 0 when value is at or above ok', () => {
      expect(lerp(40, ok, good)).toBe(0);
      expect(lerp(60, ok, good)).toBe(0);
    });

    it('interpolates between good and ok', () => {
      const result = lerp(30, ok, good);
      expect(result).toBe(75);
    });
  });

  describe('edge: ok === good', () => {
    it('returns 100 when value >= threshold', () => {
      expect(lerp(10, 10, 10)).toBe(100);
      expect(lerp(15, 10, 10)).toBe(100);
    });

    it('returns 0 when value < threshold', () => {
      expect(lerp(5, 10, 10)).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// computeScore
// ---------------------------------------------------------------------------
describe('computeScore', () => {
  const baseInput = {
    reachRate: 20,
    err: 3,
    viewsStdDev: 30,
    postsPerWeek: 3,
    reactionTypes: 3,
    adLoadPercent: 10,
    niche: 'unknown' as const,
  };

  it('returns a total between 0 and 100', () => {
    const score = computeScore(baseInput);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it('all sub-scores are between 0 and 100', () => {
    const score = computeScore(baseInput);
    for (const key of ['reach', 'engagement', 'stability', 'freshness', 'reactionDiversity', 'adLoad'] as const) {
      expect(score[key]).toBeGreaterThanOrEqual(0);
      expect(score[key]).toBeLessThanOrEqual(100);
    }
  });

  it('perfect metrics yield a high total', () => {
    const score = computeScore({
      reachRate: 50,
      err: 10,
      viewsStdDev: 5,
      postsPerWeek: 10,
      reactionTypes: 8,
      adLoadPercent: 0,
      niche: 'unknown',
    });
    expect(score.total).toBeGreaterThanOrEqual(90);
  });

  it('terrible metrics yield a low total', () => {
    const score = computeScore({
      reachRate: 0,
      err: 0,
      viewsStdDev: 100,
      postsPerWeek: 0,
      reactionTypes: 0,
      adLoadPercent: 50,
      niche: 'unknown',
    });
    expect(score.total).toBeLessThanOrEqual(10);
  });

  it('applies niche overrides', () => {
    const defaultScore = computeScore({ ...baseInput, niche: 'unknown' });
    const nicheScore = computeScore({ ...baseInput, niche: 'news' });
    // news has different reach thresholds, so scores should differ
    expect(nicheScore.reach).not.toBe(defaultScore.reach);
  });
});

// ---------------------------------------------------------------------------
// detectBotRisk
// ---------------------------------------------------------------------------
describe('detectBotRisk', () => {
  const cleanChannel = {
    reachRate: 25,
    err: 3,
    avgViews: 5000,
    viewsCv: 30,
    totalReactions: 500,
    subscriberCount: 20000,
    recentAvgViews: 5000,
    olderAvgViews: 4800,
  };

  it('returns low risk for a clean channel', () => {
    const result = detectBotRisk(cleanChannel);
    expect(result.level).toBe('low');
    expect(result.signals).toHaveLength(0);
    expect(result.score).toBe(0);
  });

  it('flags anomalous reach rate', () => {
    const result = detectBotRisk({ ...cleanChannel, reachRate: 95 });
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.score).toBeGreaterThanOrEqual(20);
  });

  it('flags suspiciously stable views', () => {
    const result = detectBotRisk({ ...cleanChannel, viewsCv: 3 });
    expect(result.signals.some(s => s.includes('stable views'))).toBe(true);
  });

  it('flags zero reactions with high views', () => {
    const result = detectBotRisk({ ...cleanChannel, totalReactions: 0 });
    expect(result.signals.some(s => s.includes('Zero reactions'))).toBe(true);
  });

  it('returns high or critical for multiple red flags', () => {
    const result = detectBotRisk({
      reachRate: 95,
      err: 15,
      avgViews: 5000,
      viewsCv: 3,
      totalReactions: 0,
      subscriberCount: 200000,
      recentAvgViews: 500,
      olderAvgViews: 5000,
    });
    expect(['high', 'critical']).toContain(result.level);
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  it('flags view spike (bot purchase pattern)', () => {
    const result = detectBotRisk({
      ...cleanChannel,
      recentAvgViews: 15000,
      olderAvgViews: 5000,
    });
    expect(result.signals.some(s => s.includes('spike'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectNiche
// ---------------------------------------------------------------------------
describe('detectNiche', () => {
  it('detects crypto niche from description', () => {
    expect(detectNiche('Daily Bitcoin and Ethereum analysis', [])).toBe('crypto');
  });

  it('detects tech niche from post texts', () => {
    const posts = ['New Linux kernel release', 'Programming tutorial for developers', 'AI startup news'];
    expect(detectNiche('', posts)).toBe('tech');
  });

  it('returns unknown when no keywords match', () => {
    expect(detectNiche('Random thoughts about nothing', [])).toBe('unknown');
  });

  it('does not false-positive on short words embedded in longer words', () => {
    // "eth" should not match inside "method", "weather", etc.
    const result = detectNiche('The method for weather forecasting is complex', []);
    expect(result).not.toBe('crypto');
  });

  it('picks the niche with the most keyword hits', () => {
    const posts = [
      'Bitcoin price surges as crypto market rallies',
      'Ethereum blockchain upgrade coming soon',
      'One tech article about programming',
    ];
    expect(detectNiche('', posts)).toBe('crypto');
  });
});
