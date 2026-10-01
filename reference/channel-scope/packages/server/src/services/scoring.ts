import type { AnalyticsScore, ChannelNiche } from 'channel-scope-shared';

/**
 * Thresholds define the "ok" and "good" values for each sub-score metric.
 * Linear interpolation maps the metric value to a 0-100 sub-score:
 *   - At or below 0 (or the logical minimum) -> 0
 *   - At "ok" threshold -> 50
 *   - At "good" threshold or above -> 100
 */
interface Thresholds {
  reach: { ok: number; good: number };        // reachRate %
  engagement: { ok: number; good: number };    // ERR %
  stability: { ok: number; good: number };     // viewsStdDev % (lower is better, inverted)
  freshness: { ok: number; good: number };     // postsPerWeek
  reactionDiversity: { ok: number; good: number }; // reactionTypes count
  adLoad: { ok: number; good: number };  // adLoadPercent (lower is better, inverted)
}

const DEFAULT_THRESHOLDS: Thresholds = {
  reach: { ok: 15, good: 30 },
  engagement: { ok: 2, good: 5 },
  stability: { ok: 40, good: 20 },       // inverted: lower stdDev = better
  freshness: { ok: 2, good: 5 },
  reactionDiversity: { ok: 2, good: 5 },
  adLoad: { ok: 20, good: 5 },   // inverted: lower ad load = better
};

const NICHE_THRESHOLDS: Partial<Record<ChannelNiche, Partial<Thresholds>>> = {
  crypto: {
    reach: { ok: 12, good: 25 },
    engagement: { ok: 1.5, good: 4 },
    stability: { ok: 50, good: 25 },
  },
  finance: {
    reach: { ok: 12, good: 25 },
    engagement: { ok: 1.5, good: 4 },
  },
  news: {
    reach: { ok: 20, good: 40 },
    freshness: { ok: 5, good: 14 },
    stability: { ok: 50, good: 30 },
  },
  entertainment: {
    reach: { ok: 10, good: 25 },
    engagement: { ok: 3, good: 7 },
    reactionDiversity: { ok: 3, good: 6 },
  },
  tech: {
    reach: { ok: 10, good: 20 },
    engagement: { ok: 1.5, good: 4 },
    freshness: { ok: 1, good: 3 },
  },
  humor: {
    reach: { ok: 10, good: 20 },
    engagement: { ok: 4, good: 8 },
    reactionDiversity: { ok: 3, good: 6 },
    stability: { ok: 50, good: 30 },
  },
};

const WEIGHTS = {
  reach: 0.25,
  engagement: 0.25,
  stability: 0.20,
  freshness: 0.15,
  reactionDiversity: 0.10,
  adLoad: 0.05,
} as const;

/**
 * Linear interpolation: maps a value to 0-100 given "ok" (50) and "good" (100) anchors.
 * Values below 0 clamp to 0; values above "good" clamp to 100.
 */
export function lerp(value: number, ok: number, good: number): number {
  if (ok === good) return value >= good ? 100 : 0;

  if (ok < good) {
    // Higher is better (reach, engagement, freshness, reactionDiversity)
    if (value <= 0) return 0;
    if (value >= good) return 100;
    if (value <= ok) return Math.round((value / ok) * 50);
    return Math.round(50 + ((value - ok) / (good - ok)) * 50);
  } else {
    // Lower is better (stability, adLoad) — ok > good numerically
    if (value <= good) return 100;
    if (value >= ok) return 0;
    return Math.round(50 + ((ok - value) / (ok - good)) * 50);
  }
}

interface ScoringInput {
  reachRate: number;
  err: number;
  viewsStdDev: number;
  postsPerWeek: number;
  reactionTypes: number;
  adLoadPercent: number;
  niche: ChannelNiche;
}

/**
 * Compute the composite analytics score (0-100) with 6 weighted sub-scores.
 */
export function computeScore(input: ScoringInput): AnalyticsScore {
  const nicheOverrides = NICHE_THRESHOLDS[input.niche] || {};
  const t: Thresholds = {
    reach: nicheOverrides.reach || DEFAULT_THRESHOLDS.reach,
    engagement: nicheOverrides.engagement || DEFAULT_THRESHOLDS.engagement,
    stability: nicheOverrides.stability || DEFAULT_THRESHOLDS.stability,
    freshness: nicheOverrides.freshness || DEFAULT_THRESHOLDS.freshness,
    reactionDiversity: nicheOverrides.reactionDiversity || DEFAULT_THRESHOLDS.reactionDiversity,
    adLoad: nicheOverrides.adLoad || DEFAULT_THRESHOLDS.adLoad,
  };

  const reach = lerp(input.reachRate, t.reach.ok, t.reach.good);
  const engagement = lerp(input.err, t.engagement.ok, t.engagement.good);
  const stability = lerp(input.viewsStdDev, t.stability.ok, t.stability.good);
  const freshness = lerp(input.postsPerWeek, t.freshness.ok, t.freshness.good);
  const reactionDiversity = lerp(input.reactionTypes, t.reactionDiversity.ok, t.reactionDiversity.good);
  const adLoad = lerp(input.adLoadPercent, t.adLoad.ok, t.adLoad.good);

  const total = Math.round(
    reach * WEIGHTS.reach +
    engagement * WEIGHTS.engagement +
    stability * WEIGHTS.stability +
    freshness * WEIGHTS.freshness +
    reactionDiversity * WEIGHTS.reactionDiversity +
    adLoad * WEIGHTS.adLoad
  );

  return {
    total: Math.max(0, Math.min(100, total)),
    reach,
    engagement,
    stability,
    freshness,
    reactionDiversity,
    adLoad,
  };
}
