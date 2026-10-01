import type { ChannelNiche, BotRiskLevel, PriceEstimate, PriceTier } from 'channel-scope-shared';

/* ---------- Currency configuration ---------- */

interface CurrencyConfig {
  code: string;
  symbol: string;
  cpmRanges: Record<ChannelNiche, { min: number; max: number }>;
}

const CURRENCIES: Record<string, CurrencyConfig> = {
  RUB: {
    code: 'RUB',
    symbol: '₽',
    cpmRanges: {
      crypto:        { min: 800,  max: 3000 },
      finance:       { min: 600,  max: 2500 },
      news:          { min: 250,  max: 900  },
      entertainment: { min: 200,  max: 750  },
      tech:          { min: 400,  max: 1400 },
      humor:         { min: 150,  max: 600  },
      education:     { min: 350,  max: 1200 },
      lifestyle:     { min: 250,  max: 900  },
      politics:      { min: 300,  max: 1000 },
      sports:        { min: 250,  max: 900  },
      unknown:       { min: 250,  max: 900  },
    },
  },
  USD: {
    code: 'USD',
    symbol: '$',
    cpmRanges: {
      crypto:        { min: 8,   max: 30  },
      finance:       { min: 6,   max: 25  },
      news:          { min: 2.5, max: 9   },
      entertainment: { min: 2,   max: 7.5 },
      tech:          { min: 4,   max: 14  },
      humor:         { min: 1.5, max: 6   },
      education:     { min: 3.5, max: 12  },
      lifestyle:     { min: 2.5, max: 9   },
      politics:      { min: 3,   max: 10  },
      sports:        { min: 2.5, max: 9   },
      unknown:       { min: 2.5, max: 9   },
    },
  },
};

function getActiveCurrency(): CurrencyConfig {
  const code = (process.env.CHANNEL_SCOPE_CURRENCY || 'USD').toUpperCase();
  const config = CURRENCIES[code];
  if (!config) {
    throw new Error(`Unsupported currency "${code}". Supported: ${Object.keys(CURRENCIES).join(', ')}`);
  }
  return config;
}

/* ---------- Helpers ---------- */

/** Quality multiplier based on total score (0–100). Maps to 0.7–1.3. */
function qualityMultiplier(scoreTotal: number): number {
  const clamped = Math.max(0, Math.min(100, scoreTotal));
  return 0.7 + (clamped / 100) * 0.6;
}

/** Bot discount based on bot risk level. Maps to 0.5–1.0. */
function botDiscount(botRisk: BotRiskLevel): number {
  switch (botRisk) {
    case 'low':      return 1.0;
    case 'medium':   return 0.85;
    case 'high':     return 0.65;
    case 'critical': return 0.5;
  }
}

/** Determine price tier from final CPM relative to niche range. */
function determineTier(
  cpm: number,
  niche: ChannelNiche,
  cpmRanges: Record<ChannelNiche, { min: number; max: number }>,
): PriceTier {
  const range = cpmRanges[niche] || cpmRanges.unknown;
  const third = (range.max - range.min) / 3;
  if (cpm >= range.min + 2 * third) return 'premium';
  if (cpm >= range.min + third) return 'mid';
  return 'budget';
}

/* ---------- Public API ---------- */

export interface PriceEstimationInput {
  niche: ChannelNiche;
  weightedAvgViews: number;
  scoreTotal: number;
  botRisk: BotRiskLevel;
}

/**
 * Estimate advertising post price based on niche CPM, channel quality, and bot risk.
 * Currency is determined by CHANNEL_SCOPE_CURRENCY env var (default: USD).
 */
export function estimatePrice(input: PriceEstimationInput): PriceEstimate {
  const { niche, weightedAvgViews, scoreTotal, botRisk } = input;
  const currency = getActiveCurrency();
  const cpmRanges = currency.cpmRanges;

  const range = cpmRanges[niche] || cpmRanges.unknown;

  // Start with the midpoint of the niche CPM range
  const baseCPM = (range.min + range.max) / 2;

  // Apply quality and bot adjustments
  const qMul = qualityMultiplier(scoreTotal);
  const bDisc = botDiscount(botRisk);
  const adjustedCPM = baseCPM * qMul * bDisc;

  // Clamp CPM within a reasonable range (50% below min to 20% above max)
  const clampedCPM = Math.max(range.min * 0.5, Math.min(range.max * 1.2, adjustedCPM));

  // Calculate post price: CPM * views / 1000
  const estimatedPostPrice = Math.round(clampedCPM * (weightedAvgViews / 1000));
  const estimatedCPM = Math.round(clampedCPM);

  const priceTier = determineTier(clampedCPM, niche, cpmRanges);

  return {
    estimatedPostPrice,
    estimatedCPM,
    priceTier,
    currency: currency.code,
    currencySymbol: currency.symbol,
  };
}
