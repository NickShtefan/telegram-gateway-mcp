import type { BotRiskLevel } from 'channel-scope-shared';

export interface BotDetectionResult {
  level: BotRiskLevel;
  signals: string[];
  score: number; // 0 = clean, 100 = definitely botted
}

interface BotDetectionInput {
  reachRate: number;
  err: number;
  avgViews: number;
  viewsCv: number; // coefficient of variation (stdDev / mean) as percentage
  totalReactions: number;
  subscriberCount: number;
  recentAvgViews: number;
  olderAvgViews: number;
}

/**
 * Detect bot/fraud signals from channel metrics.
 * Returns a risk level, list of triggered signals, and a numeric score 0-100.
 */
export function detectBotRisk(input: BotDetectionInput): BotDetectionResult {
  const signals: string[] = [];
  let score = 0;

  // 1. Anomalous reach (>90%)
  if (input.reachRate > 90) {
    signals.push(`Anomalous reach rate: ${input.reachRate.toFixed(1)}% (>90%)`);
    score += 25;
  }

  // 2. High ERR with low reach — fake engagement
  if (input.err > 10 && input.reachRate < 15) {
    signals.push(`High engagement (${input.err.toFixed(2)}%) with low reach (${input.reachRate.toFixed(1)}%)`);
    score += 20;
  }

  // 3. Suspiciously stable views (CV < 5% at >1000 avg views)
  if (input.viewsCv < 5 && input.avgViews > 1000) {
    signals.push(`Suspiciously stable views: CV=${input.viewsCv.toFixed(1)}% with ${Math.round(input.avgViews)} avg views`);
    score += 25;
  }

  // 4. Zero reactions with high views
  if (input.totalReactions === 0 && input.avgViews > 500) {
    signals.push(`Zero reactions with ${Math.round(input.avgViews)} avg views`);
    score += 15;
  }

  // 5. Sudden view drops between recent and older posts
  if (input.olderAvgViews > 0 && input.recentAvgViews > 0) {
    const dropPercent = ((input.olderAvgViews - input.recentAvgViews) / input.olderAvgViews) * 100;
    if (dropPercent > 50) {
      signals.push(`View drop: recent avg ${Math.round(input.recentAvgViews)} vs older avg ${Math.round(input.olderAvgViews)} (${dropPercent.toFixed(0)}% decline)`);
      score += 20;
    }
  }

  // 6. Sudden view SPIKE — recent avg > older avg by >100% (indicative of bot view purchase)
  if (input.olderAvgViews > 0 && input.recentAvgViews > 0) {
    const spikePercent = ((input.recentAvgViews - input.olderAvgViews) / input.olderAvgViews) * 100;
    if (spikePercent > 100) {
      signals.push(`View spike: recent avg ${Math.round(input.recentAvgViews)} vs older avg ${Math.round(input.olderAvgViews)} (${spikePercent.toFixed(0)}% increase)`);
      score += 25;
    }
  }

  // 7. Dead subscriber base (subscribers > avgViews * 15)
  if (input.subscriberCount > input.avgViews * 15 && input.avgViews > 0) {
    const ratio = Math.round(input.subscriberCount / input.avgViews);
    signals.push(`Dead subscriber base: ${input.subscriberCount} subs but only ${Math.round(input.avgViews)} avg views (${ratio}x ratio)`);
    score += 20;
  }

  // Clamp score to 0-100
  score = Math.min(100, Math.max(0, score));

  let level: BotRiskLevel;
  if (score >= 60) level = 'critical';
  else if (score >= 40) level = 'high';
  else if (score >= 20) level = 'medium';
  else level = 'low';

  return { level, signals, score };
}
