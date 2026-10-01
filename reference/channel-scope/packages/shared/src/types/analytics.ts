import type { LinkedGroup } from './channel.js';

export type BotRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type PriceTier = 'budget' | 'mid' | 'premium';

export interface PriceEstimate {
  estimatedPostPrice: number;
  estimatedCPM: number;
  priceTier: PriceTier;
  currency: string;
  currencySymbol: string;
}

export type ChannelNiche =
  | 'crypto'
  | 'finance'
  | 'news'
  | 'entertainment'
  | 'tech'
  | 'humor'
  | 'education'
  | 'lifestyle'
  | 'politics'
  | 'sports'
  | 'unknown';

export interface AnalyticsScore {
  total: number;
  reach: number;
  engagement: number;
  stability: number;
  freshness: number;
  reactionDiversity: number;
  adLoad: number;
}

export interface ChannelAnalytics {
  avgViews: number;
  weightedAvgViews: number;
  medianViews: number;
  reachRate: number;
  err: number;
  viewsStdDev: number;
  postsPerWeek: number;
  growthTrend: 'growing' | 'stable' | 'declining';
  reactionTypes: number;
  hasDiscussion: boolean;
  adLoadPercent: number;
  /** @deprecated Use score.total instead */
  verdict: 'good' | 'review' | 'avoid';
  score: AnalyticsScore;
  niche: ChannelNiche;
  botRisk: BotRiskLevel;
  botRiskSignals: string[];
  priceEstimate: PriceEstimate | null;
  analyzedAt: string;
}

export interface ForwardSource {
  channel: {
    channelId: string;
    title: string;
    username: string;
    description: string;
    subscriberCount: number;
    hasAvatar: boolean;
    linkedGroup: LinkedGroup | null;
    alreadyAdded: boolean;
    alreadyResearched?: boolean;
    telegramId?: string;
    accessHash?: string;
  };
  forwardCount: number;
}

export type DepthPreset = '3m' | '6m' | '12m' | '2y' | '5y' | 'all';

export const DEPTH_PRESETS: readonly DepthPreset[] = ['3m', '6m', '12m', '2y', '5y', 'all'] as const;

/**
 * Convert a depth preset to a `since` Date.
 * Returns `undefined` for 'all' (no time limit).
 */
export function presetToDate(preset: DepthPreset): Date | undefined {
  const now = new Date();
  switch (preset) {
    case '3m':  return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
    case '6m':  return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
    case '12m': return new Date(now.getFullYear(), now.getMonth() - 12, now.getDate());
    case '2y':  return new Date(now.getFullYear() - 2, now.getMonth(), now.getDate());
    case '5y':  return new Date(now.getFullYear() - 5, now.getMonth(), now.getDate());
    case 'all': return undefined;
  }
}

export interface AnalysisHistoryEntry {
  depth: DepthPreset;
  analyzedAt: string;
  score: number;
}

export type ResearchStatus = 'discovered' | 'downloading' | 'downloaded' | 'analyzed' | 'shortlist' | 'contacted' | 'partner' | 'rejected';

export interface ResearchChannel {
  _id: string;
  channelId: string;
  title: string;
  username: string;
  description: string;
  subscriberCount: number;
  hasAvatar: boolean;
  linkedGroup: LinkedGroup | null;
  status: ResearchStatus;
  notes: string;
  aiReport: string;
  contactInfo: string;
  lastContactedAt: string | null;
  lastUpdatedAt: string | null;
  lastSyncPostId: number | null;
  postsCount: number;
  avgViews: number;
  analytics: ChannelAnalytics | null;
  analysisDepth: DepthPreset | null;
  analysisHistory: AnalysisHistoryEntry[];
  collectionIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResearchCollection {
  _id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}
