#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  parseTokenCookie,
  buildUrl,
  buildHeaders,
  buildStatusUpdate,
  CHANNEL_STATUSES,
} from "./helpers.js";

const API_BASE = process.env.CHANNEL_SCOPE_API || "http://localhost:3001";
const CS_USERNAME = process.env.CHANNEL_SCOPE_USERNAME || "";
const CS_PASSWORD = process.env.CHANNEL_SCOPE_PASSWORD || "";

let authCookie = "";

// --- Auth ---

async function login(): Promise<void> {
  if (!CS_USERNAME || !CS_PASSWORD) {
    console.error(
      "Warning: CHANNEL_SCOPE_USERNAME/PASSWORD not set — API calls may fail with 401"
    );
    return;
  }
  try {
    const res = await fetch(new URL("/api/auth/login", API_BASE).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: CS_USERNAME, password: CS_PASSWORD }),
    });
    if (!res.ok) {
      console.error(`Login failed: ${res.status} ${await res.text()}`);
      return;
    }
    const setCookie = res.headers.get("set-cookie");
    const parsed = parseTokenCookie(setCookie);
    if (parsed) authCookie = parsed;
    console.error("Authenticated with Channel Scope API");
  } catch (err) {
    console.error(`Login error (will retry on first API call): ${err}`);
  }
}

// --- HTTP helper ---

function headers(): Record<string, string> {
  return buildHeaders(authCookie);
}

async function api<T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>
): Promise<T> {
  const url = buildUrl(API_BASE, path, params);
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T = unknown>(
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(new URL(path, API_BASE).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiPut<T = unknown>(
  path: string,
  body?: Record<string, unknown>
): Promise<T> {
  const res = await fetch(new URL(path, API_BASE).toString(), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- MCP Server ---

const server = new McpServer(
  { name: "channel-scope", version: "0.1.0" },
  {
    instructions: [
      "Channel Scope — Telegram channel discovery and analytics tool.",
      "Workflow: searchChannels → getChannelDetails (enrich) → getRecommendations → addToPipeline → startDataCollection → getChannelPosts / getChannelAnalytics.",
      "searchChannels returns light results (no descriptions/subscribers). Use getChannelDetails to enrich a specific channel.",
      "Pipeline stages: discovered → downloaded → analyzed → shortlist → contacted → partner → rejected.",
      "startDataCollection is async — it returns immediately. Use getPipeline to check download progress.",
      "Use setChannelStatus to move a channel between stages (e.g. promote to shortlist, mark contacted, reject).",
    ].join("\n"),
  }
);

// --- Tool: searchChannels ---

server.registerTool(
  "searchChannels",
  {
    description:
      "Search Telegram channels by keyword, @username, or #hashtag. " +
      "Returns light results (title, username, subscriberCount may be 0). " +
      "Use getChannelDetails to enrich a channel with full info and scoring. " +
      "Combine with getRecommendations for broader discovery.",
    inputSchema: {
      query: z.string().describe("Search query: keyword, @username, or #hashtag"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results. Default 20."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, limit }) => {
    const results = await api("/api/channels/search/universal", {
      q: query,
      limit,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Tool: getChannelDetails ---

server.registerTool(
  "getChannelDetails",
  {
    description:
      "Enrich a channel with full details: description, subscriber count, avatar. " +
      "Call this after searchChannels to get complete info on a specific channel. " +
      "Requires channelId from search results. Optionally pass telegramId and accessHash " +
      "for channels without a username.",
    inputSchema: {
      channelId: z.string().describe("Channel ID or @username from search results"),
      telegramId: z
        .string()
        .optional()
        .describe("Numeric Telegram ID (for channels without username)"),
      accessHash: z
        .string()
        .optional()
        .describe("Access hash from search results (for channels without username)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelId, telegramId, accessHash }) => {
    const result = await api(`/api/channels/${encodeURIComponent(channelId)}/enrich`, {
      telegramId,
      accessHash,
    });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: getRecommendations ---

server.registerTool(
  "getRecommendations",
  {
    description:
      "Get similar channels via Telegram's recommendation graph. " +
      "BFS crawl through recommended channels at configurable depth (1-3). " +
      "Depth 1: ~10 channels. Depth 2: ~30-40. Depth 3: ~50+. " +
      "Results are light — use getChannelDetails to enrich.",
    inputSchema: {
      channelId: z
        .string()
        .describe("Channel ID or @username to get recommendations for"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(2)
        .describe("Crawl depth 1-3. Higher = more results but slower. Default 2."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelId, depth }) => {
    const results = await api(
      `/api/channels/${encodeURIComponent(channelId)}/recommendations`,
      { depth }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Tool: analyzeForwards ---

server.registerTool(
  "analyzeForwards",
  {
    description:
      "Analyze which channels forward posts FROM a given channel. " +
      "Shows the citation graph — who reposts this channel's content. " +
      "Useful for understanding a channel's reach and influence.",
    inputSchema: {
      channelId: z.string().describe("Channel ID or @username"),
      limit: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(100)
        .describe("Number of recent posts to analyze. Default 100."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelId, limit }) => {
    const results = await api(
      `/api/channels/${encodeURIComponent(channelId)}/forwards`,
      { limit }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Tool: getPipeline ---

server.registerTool(
  "getPipeline",
  {
    description:
      "Get the current research pipeline — all channels being tracked. " +
      "Shows status (discovered/downloaded/analyzed/contacted/partner/rejected), " +
      "scores, download progress. Use this to check what's in your pipeline.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const results = await api("/api/research/channels");
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Tool: addToPipeline ---

server.registerTool(
  "addToPipeline",
  {
    description:
      "Add a channel to the research pipeline for tracking and analysis. " +
      "After adding, use startDataCollection to download posts, then the channel " +
      "will be auto-analyzed (scoring, bot detection, niche, price estimation).",
    inputSchema: {
      channelId: z.string().describe("Channel ID or @username to add"),
      title: z.string().describe("Channel title"),
      username: z.string().optional().describe("Channel @username if available"),
      subscriberCount: z.number().optional().describe("Subscriber count if known"),
    },
  },
  async ({ channelId, title, username, subscriberCount }) => {
    const result = await apiPost("/api/research/channels", {
      channelId,
      title,
      username,
      subscriberCount,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// --- Tool: startDataCollection ---

server.registerTool(
  "startDataCollection",
  {
    description:
      "Start downloading posts from a channel in the pipeline. " +
      "This is async — returns immediately. Posts are downloaded in background. " +
      "After download completes, channel is auto-analyzed (scoring, bot detection, etc.). " +
      "Use getPipeline to check progress. " +
      "Preset controls the time window: 3m (quick scan), 6m, 12m, 2y, 5y, or all. " +
      "By default skips media download (text + metadata only). " +
      "Set skipMedia=false to also download media files (much slower).",
    inputSchema: {
      researchChannelId: z
        .string()
        .describe("Research channel ID (from getPipeline results, the _id field)"),
      preset: z
        .enum(["3m", "6m", "12m", "2y", "5y", "all"])
        .default("3m")
        .describe("Time window for post download. Default '3m' (3 months)."),
      skipMedia: z
        .boolean()
        .default(true)
        .describe("Skip media file downloads (default true). Set false to download images/videos."),
    },
  },
  async ({ researchChannelId, preset, skipMedia }) => {
    const result = await apiPost(
      `/api/research/channels/${encodeURIComponent(researchChannelId)}/download`,
      { preset, skipMedia }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: getChannelAnalytics ---

server.registerTool(
  "getChannelAnalytics",
  {
    description:
      "Get full analytics for a channel that has been downloaded and analyzed. " +
      "Returns scoring (0-100), bot risk level, niche classification, price estimation, " +
      "engagement metrics (ERR, reach rate, views stability, growth trend, ad load). " +
      "Channel must be in the pipeline with downloaded posts — use startDataCollection first.",
    inputSchema: {
      researchChannelId: z
        .string()
        .describe("Research channel ID (from getPipeline results)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ researchChannelId }) => {
    const result = await apiPost(
      `/api/research/channels/${encodeURIComponent(researchChannelId)}/analyze`
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// --- Tool: getChannelPosts ---

server.registerTool(
  "getChannelPosts",
  {
    description:
      "Read downloaded posts from a channel in the pipeline. " +
      "Returns post text, views, reactions, and date. " +
      "Channel must have downloaded posts — use startDataCollection first.",
    inputSchema: {
      researchChannelId: z
        .string()
        .describe("Research channel ID (from getPipeline results, the _id field)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(20)
        .describe("Max posts to return. Default 20."),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Skip first N posts (pagination). Default 0."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ researchChannelId, limit, offset }) => {
    const results = await api(
      `/api/research/channels/${encodeURIComponent(researchChannelId)}/posts`,
      { limit, offset }
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Tool: filterPipeline ---

server.registerTool(
  "filterPipeline",
  {
    description:
      "Filter pipeline channels by score, subscribers, status, or niche. " +
      "Returns a filtered list of channels with their scores and metadata. " +
      "All params are optional — omit any to skip that filter. Filtering is done server-side.",
    inputSchema: {
      minScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Minimum score (0-100)"),
      maxScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Maximum score (0-100)"),
      minSubs: z.number().int().min(0).optional().describe("Minimum subscriber count"),
      maxSubs: z.number().int().min(0).optional().describe("Maximum subscriber count"),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: discovered, downloaded, analyzed, shortlist, contacted, partner, rejected"
        ),
      niche: z
        .string()
        .optional()
        .describe("Filter by niche classification"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ minScore, maxScore, minSubs, maxSubs, status, niche }) => {
    const params: Record<string, string | number | undefined> = {};
    if (minScore !== undefined) params.minScore = minScore;
    if (maxScore !== undefined) params.maxScore = maxScore;
    if (minSubs !== undefined) params.minSubs = minSubs;
    if (maxSubs !== undefined) params.maxSubs = maxSubs;
    if (status !== undefined) params.status = status;
    if (niche !== undefined) params.niche = niche;
    const filtered = await api("/api/research/channels", params);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(filtered, null, 2) }],
    };
  }
);

// --- Tool: getChannelReport ---

server.registerTool(
  "getChannelReport",
  {
    description:
      "Get comprehensive channel data for AI analysis: metadata, analytics, and recent posts bundled together. " +
      "Use this before writing an AI report. Channel must be in the pipeline with downloaded posts.",
    inputSchema: {
      channelId: z.string().describe("Research channel ID (_id, channelId, or username)"),
      postsLimit: z.number().optional().default(30).describe("Number of recent posts to include"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelId, postsLimit }) => {
    // 1. Get all channels, find the matching one
    const channels: Array<Record<string, unknown>> = await api("/api/research/channels");
    const ch = channels.find(
      (c) =>
        c._id === channelId ||
        c.channelId === channelId ||
        c.username === channelId
    );
    if (!ch) {
      return {
        content: [
          { type: "text" as const, text: `Channel "${channelId}" not found in pipeline` },
        ],
      };
    }

    // 2. Get posts
    const postsData = await api<{ posts?: Array<Record<string, unknown>>; total?: number }>(
      `/api/research/channels/${ch._id}/posts`,
      { limit: postsLimit }
    );
    const posts: Array<Record<string, unknown>> = postsData.posts ?? [];

    // 3. Extract analytics
    const analytics = (ch.analytics ?? {}) as Record<string, unknown>;
    const score = (analytics.score as Record<string, unknown>) ?? {};
    const engagement = (analytics.engagement as Record<string, unknown>) ?? {};

    // 4. Format output
    const lines: string[] = [];
    lines.push(`=== Channel: ${ch.title} (@${ch.username ?? "N/A"}) ===`);
    lines.push(`Subscribers: ${ch.subscriberCount ?? "N/A"} | Score: ${score.total ?? "N/A"}/100 | Niche: ${analytics.niche ?? "N/A"}`);
    lines.push(`Bot Risk: ${analytics.botRisk ?? "N/A"} | Ad Load: ${analytics.adLoadPercent ?? "N/A"}% | Growth: ${analytics.trend ?? "N/A"}`);
    lines.push(`Reach: ${engagement.reachRate ?? "N/A"}% | ERR: ${engagement.err ?? "N/A"} | Posts/week: ${engagement.postsPerWeek ?? "N/A"}`);
    lines.push(`Status: ${ch.status ?? "N/A"} | ID: ${ch._id}`);
    if (ch.description) lines.push(`Description: ${ch.description}`);
    lines.push("");
    lines.push(`=== Recent Posts (${posts.length}) ===`);

    for (const post of posts) {
      const date = post.date ? new Date(post.date as string).toISOString().slice(0, 10) : "N/A";
      const text = ((post.text as string) ?? "").slice(0, 500);
      const views = post.views ?? 0;
      const reactions = post.reactions;
      const reactionCount =
        Array.isArray(reactions)
          ? (reactions as Array<Record<string, unknown>>).reduce(
              (sum, r) => sum + ((r.count as number) ?? 0),
              0
            )
          : 0;
      lines.push(`[${date}] ${text}`);
      lines.push(`Views: ${views} | Reactions: ${reactionCount}`);
      lines.push("---");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
    };
  }
);

// --- Tool: compareChannels ---

server.registerTool(
  "compareChannels",
  {
    description:
      "Compare 2 or more research channels side-by-side on key metrics. " +
      "Returns a formatted comparison table. Channels must be in the pipeline.",
    inputSchema: {
      channelIds: z.array(z.string()).min(2).describe("Channel IDs to compare (_id, channelId, or username)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ channelIds }) => {
    const channels: Array<Record<string, unknown>> = await api("/api/research/channels");
    const matched: Array<Record<string, unknown>> = [];
    const notFound: string[] = [];

    for (const id of channelIds) {
      const ch = channels.find(
        (c) => c._id === id || c.channelId === id || c.username === id
      );
      if (ch) {
        matched.push(ch);
      } else {
        notFound.push(id);
      }
    }

    if (matched.length < 2) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Need at least 2 channels to compare. Found ${matched.length}. Not found: ${notFound.join(", ")}`,
          },
        ],
      };
    }

    // Build comparison table
    const headers = ["Metric", ...matched.map((c) => String(c.title ?? c.username ?? c._id))];
    const rows: string[][] = [];

    function val(ch: Record<string, unknown>, path: string): string {
      const parts = path.split(".");
      let current: unknown = ch;
      for (const p of parts) {
        if (current && typeof current === "object") {
          current = (current as Record<string, unknown>)[p];
        } else {
          return "N/A";
        }
      }
      return current !== undefined && current !== null ? String(current) : "N/A";
    }

    const metrics: [string, string][] = [
      ["Username", "username"],
      ["Subscribers", "subscriberCount"],
      ["Score", "analytics.score.total"],
      ["Reach %", "analytics.engagement.reachRate"],
      ["ERR", "analytics.engagement.err"],
      ["Posts/week", "analytics.engagement.postsPerWeek"],
      ["Trend", "analytics.trend"],
      ["Ad Load %", "analytics.adLoadPercent"],
      ["Bot Risk", "analytics.botRisk"],
      ["Niche", "analytics.niche"],
      ["Status", "status"],
    ];

    for (const [label, path] of metrics) {
      rows.push([label, ...matched.map((ch) => val(ch, path))]);
    }

    // Format as aligned text table
    const allRows = [headers, ...rows];
    const colWidths = headers.map((_, i) =>
      Math.max(...allRows.map((r) => (r[i] ?? "").length))
    );
    const sep = colWidths.map((w) => "-".repeat(w)).join(" | ");
    const formatted = allRows
      .map((row) =>
        row.map((cell, i) => cell.padEnd(colWidths[i])).join(" | ")
      )
      .join("\n");

    const parts = formatted.split("\n");
    const table = [parts[0], sep, ...parts.slice(1)].join("\n");

    let result = table;
    if (notFound.length > 0) {
      result += `\n\nNot found in pipeline: ${notFound.join(", ")}`;
    }

    return {
      content: [{ type: "text" as const, text: result }],
    };
  }
);

// --- Tool: saveChannelReport ---

server.registerTool(
  "saveChannelReport",
  {
    description:
      "Save an AI-generated report for a research channel in the pipeline. " +
      "Accepts channel ID (MongoDB _id, channelId, or @username) and report text. " +
      "Pass an empty string to clear the report.",
    inputSchema: {
      channelId: z
        .string()
        .describe("Channel ID (MongoDB _id, channelId, or @username)"),
      report: z.string().describe("The AI report text to save (empty string to clear)"),
    },
  },
  async ({ channelId, report }) => {
    const channels: Array<Record<string, unknown>> = await api(
      "/api/research/channels"
    );
    const ch = channels.find(
      (c) =>
        c._id === channelId ||
        c.channelId === channelId ||
        c.username === channelId
    );
    if (!ch) {
      return {
        content: [
          { type: "text" as const, text: `Channel ${channelId} not found in pipeline` },
        ],
      };
    }
    const result = await apiPut(
      `/api/research/channels/${ch._id}`,
      { aiReport: report }
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Report ${report ? "saved" : "cleared"} for ${ch.title}`,
        },
      ],
    };
  }
);

// --- Tool: setChannelStatus ---

server.registerTool(
  "setChannelStatus",
  {
    description:
      "Update the pipeline status of a research channel. " +
      "Use to promote a channel (e.g. analyzed → shortlist), mark it contacted, " +
      "convert to partner, or reject. Optional `note` is appended to the channel's " +
      "notes field (visible in the UI) so a reason can be recorded alongside the move.",
    inputSchema: {
      researchChannelId: z
        .string()
        .describe("Research channel ID (MongoDB _id from getPipeline)"),
      status: z
        .enum(CHANNEL_STATUSES)
        .describe(
          "New status: discovered | downloaded | analyzed | shortlist | contacted | partner | rejected",
        ),
      note: z
        .string()
        .optional()
        .describe("Optional note/reason for the status change (saved to channel notes)"),
    },
  },
  async ({ researchChannelId, status, note }) => {
    const body = buildStatusUpdate(status, note);
    const result = await apiPut(
      `/api/research/channels/${encodeURIComponent(researchChannelId)}`,
      body,
    );
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Channel Scope MCP server running on stdio");

  // Login in background — transport is already connected so tools are registered.
  // If login fails, tools will return auth errors when called.
  login();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
