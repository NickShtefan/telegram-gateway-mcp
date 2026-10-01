/**
 * Extracted utility functions for the MCP server.
 * Separated from index.ts for testability.
 */

/**
 * Parse a JWT token cookie value from a Set-Cookie header string.
 * Returns the full "token=VALUE" string, or empty string if not found.
 */
export function parseTokenCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) return "";
  const match = setCookieHeader.match(/token=([^;]+)/);
  return match ? `token=${match[1]}` : "";
}

/**
 * Build a full URL with query parameters, skipping undefined values.
 */
export function buildUrl(
  base: string,
  path: string,
  params?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, base);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Build headers object with optional auth cookie.
 */
export function buildHeaders(authCookie: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (authCookie) h["Cookie"] = authCookie;
  return h;
}

/**
 * Allowed channel status values for the setChannelStatus MCP tool.
 * Note: `shortlist` is added for channels worth a second look (issue #58).
 */
export const CHANNEL_STATUSES = [
  "discovered",
  "downloaded",
  "analyzed",
  "shortlist",
  "contacted",
  "partner",
  "rejected",
] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/**
 * Build the PUT body for a channel status update.
 * `note` is mapped onto the existing `notes` field so no schema change is needed.
 */
export function buildStatusUpdate(
  status: ChannelStatus,
  note?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = { status };
  if (note !== undefined && note !== "") body.notes = note;
  return body;
}

/**
 * Client-side filter for pipeline channels.
 * Used by the filterPipeline MCP tool.
 */
export function filterChannels(
  channels: Array<Record<string, unknown>>,
  filters: {
    minScore?: number;
    maxScore?: number;
    minSubs?: number;
    maxSubs?: number;
    status?: string;
  },
): Array<Record<string, unknown>> {
  const { minScore, maxScore, minSubs, maxSubs, status } = filters;
  return channels.filter((ch) => {
    if (status && ch.status !== status) return false;
    if (minSubs !== undefined && (ch.subscriberCount as number) < minSubs) return false;
    if (maxSubs !== undefined && (ch.subscriberCount as number) > maxSubs) return false;
    const score = (ch.analytics as Record<string, unknown>)?.score as Record<string, number> | undefined;
    const total = score?.total ?? 0;
    if (minScore !== undefined && total < minScore) return false;
    if (maxScore !== undefined && total > maxScore) return false;
    return true;
  });
}
