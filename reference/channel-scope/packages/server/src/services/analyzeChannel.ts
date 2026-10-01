import Post from '../db/models/Post.js';
import ResearchChannel from '../db/models/ResearchChannel.js';
import type { IChannelAnalytics } from '../db/models/ResearchChannel.js';
import { computeScore } from './scoring.js';
import { detectBotRisk } from './botDetection.js';
import { detectNiche } from './detectNiche.js';
import { estimatePrice } from './priceEstimation.js';

const AD_PATTERNS = /(?:#ad|#реклама|#промо|#promo|реклама|advertis)/i;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compute a weighted average where more recent posts count more.
 * Uses linearly decaying weights from newest (weight=n) to oldest (weight=1).
 */
function weightedAverage(viewsList: number[]): number {
  if (viewsList.length === 0) return 0;
  const n = viewsList.length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < n; i++) {
    const weight = n - i; // newest first, so first element gets highest weight
    weightedSum += viewsList[i] * weight;
    weightTotal += weight;
  }
  return weightedSum / weightTotal;
}

/**
 * Compute the median of a numeric array.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Analyze a research channel's downloaded posts and compute quality metrics.
 * Returns the analytics object and updates the ResearchChannel document.
 */
export async function analyzeChannel(researchChannelId: string): Promise<IChannelAnalytics> {
  const channel = await ResearchChannel.findById(researchChannelId);
  if (!channel) throw new Error('Research channel not found');

  // Posts may be stored under channelId (numeric) or username depending on how download was initiated
  const lookupIds = [channel.channelId];
  if (channel.username) lookupIds.push(channel.username);

  const posts = await Post.find({ channelId: { $in: lookupIds } })
    .sort({ date: -1 })
    .lean();

  if (posts.length === 0) {
    throw new Error('No posts found — download the channel first');
  }

  const subscribers = channel.subscriberCount || 1;
  const now = Date.now();
  const thirtyAgo = now - THIRTY_DAYS_MS;
  const sixtyAgo = now - 2 * THIRTY_DAYS_MS;

  // --- Basic metrics ---

  const viewsList = posts.map(p => p.stats?.views ?? 0);
  const totalViews = viewsList.reduce((s, v) => s + v, 0);
  const avgViews = totalViews / posts.length;
  const weightedAvgViews = weightedAverage(viewsList);
  const medianViews = median(viewsList);

  // Reach rate
  const reachRate = (avgViews / subscribers) * 100;

  // ERR (Engagement Rate by Reach)
  let totalReactions = 0;
  const reactionTypeSet = new Set<string>();
  for (const post of posts) {
    if (post.stats?.reactions) {
      for (const r of post.stats.reactions) {
        totalReactions += r.count;
        reactionTypeSet.add(r.reaction);
      }
    }
  }
  const err = totalViews > 0 ? (totalReactions / totalViews) * 100 : 0;

  // Views coefficient of variation (CV = stdDev / mean * 100, expressed as percentage)
  // Note: named "viewsStdDev" for legacy compatibility but this is actually CV
  const meanViews = avgViews || 1;
  const variance = viewsList.reduce((s, v) => s + (v - meanViews) ** 2, 0) / viewsList.length;
  const viewsStdDev = (Math.sqrt(variance) / meanViews) * 100;

  // --- Time-based metrics ---

  const recentPosts = posts.filter(p => new Date(p.date).getTime() >= thirtyAgo);
  const weeks = Math.max(1, (now - thirtyAgo) / (7 * 24 * 60 * 60 * 1000));
  const postsPerWeek = recentPosts.length / weeks;

  // Growth trend: compare last 30d avg views vs previous 30d
  const prevPosts = posts.filter(p => {
    const t = new Date(p.date).getTime();
    return t >= sixtyAgo && t < thirtyAgo;
  });

  let growthTrend: 'growing' | 'stable' | 'declining' = 'stable';
  const recentAvg = recentPosts.length > 0
    ? recentPosts.reduce((s, p) => s + (p.stats?.views ?? 0), 0) / recentPosts.length
    : 0;
  const prevAvg = prevPosts.length > 0
    ? prevPosts.reduce((s, p) => s + (p.stats?.views ?? 0), 0) / prevPosts.length
    : 0;

  if (recentPosts.length >= 3 && prevPosts.length >= 3) {
    const change = prevAvg > 0 ? ((recentAvg - prevAvg) / prevAvg) * 100 : 0;
    if (change > 10) growthTrend = 'growing';
    else if (change < -10) growthTrend = 'declining';
  }

  // Reaction diversity
  const reactionTypes = reactionTypeSet.size;

  // Has discussion group
  const hasDiscussion = !!channel.linkedGroup;

  // Ad load: % of posts that look like ads (forwarded or contain ad markers)
  let adCount = 0;
  for (const post of posts) {
    const text = post.text || '';
    if (AD_PATTERNS.test(text)) {
      adCount++;
    }
  }
  const adLoadPercent = posts.length > 0 ? (adCount / posts.length) * 100 : 0;

  // --- Niche detection ---
  const postTexts = posts.map(p => p.text || '');
  const niche = detectNiche(channel.description || '', postTexts);

  // --- Bot detection ---
  const botResult = detectBotRisk({
    reachRate,
    err,
    avgViews,
    viewsCv: viewsStdDev, // viewsStdDev is already CV as percentage
    totalReactions,
    subscriberCount: subscribers,
    recentAvgViews: recentAvg,
    olderAvgViews: prevAvg,
  });

  // --- Score ---
  const score = computeScore({
    reachRate,
    err,
    viewsStdDev,
    postsPerWeek,
    reactionTypes,
    adLoadPercent,
    niche,
  });

  // --- Price estimation ---
  const priceEstimate = estimatePrice({
    niche,
    weightedAvgViews,
    scoreTotal: score.total,
    botRisk: botResult.level,
  });

  // --- Legacy verdict (kept for backwards compatibility) ---
  let redFlags = 0;
  let yellowFlags = 0;

  if (reachRate < 10) redFlags++;
  else if (reachRate < 15 || reachRate > 80) yellowFlags++;

  if (err < 1) redFlags++;
  else if (err < 2 || err > 15) yellowFlags++;

  if (viewsStdDev > 50) redFlags++;
  else if (viewsStdDev > 30) yellowFlags++;

  if (postsPerWeek < 0.5) redFlags++;
  else if (postsPerWeek < 2) yellowFlags++;

  if (growthTrend === 'declining') yellowFlags++;

  if (adLoadPercent > 40) redFlags++;
  else if (adLoadPercent > 20) yellowFlags++;

  if (reactionTypes === 0) yellowFlags++;
  else if (reactionTypes === 1) yellowFlags++;

  let verdict: 'good' | 'review' | 'avoid';
  if (redFlags > 0) verdict = 'avoid';
  else if (yellowFlags > 0) verdict = 'review';
  else verdict = 'good';

  const analytics: IChannelAnalytics = {
    avgViews: Math.round(avgViews),
    weightedAvgViews: Math.round(weightedAvgViews),
    medianViews: Math.round(medianViews),
    reachRate: Math.round(reachRate * 10) / 10,
    err: Math.round(err * 100) / 100,
    viewsStdDev: Math.round(viewsStdDev * 10) / 10,
    postsPerWeek: Math.round(postsPerWeek * 10) / 10,
    growthTrend,
    reactionTypes,
    hasDiscussion,
    adLoadPercent: Math.round(adLoadPercent * 10) / 10,
    verdict,
    score,
    niche,
    botRisk: botResult.level,
    botRiskSignals: botResult.signals,
    priceEstimate,
    analyzedAt: new Date(),
  };

  await ResearchChannel.findByIdAndUpdate(researchChannelId, {
    analytics,
    status: channel.status === 'downloaded' ? 'analyzed' : channel.status,
    postsCount: posts.length,
    avgViews: Math.round(avgViews),
  });

  return analytics;
}
