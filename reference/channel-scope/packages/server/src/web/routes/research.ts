import { Router } from 'express';
import type { Request, Response } from 'express';
import mongoose from 'mongoose';
import { execSync, spawn } from 'child_process';
import { DEPTH_PRESETS } from 'channel-scope-shared';
import type { DepthPreset } from 'channel-scope-shared';
import ResearchChannel from '../../db/models/ResearchChannel.js';
import ResearchCollection, { DEFAULT_COLLECTION_NAME } from '../../db/models/ResearchCollection.js';
import { analyzeChannel } from '../../services/analyzeChannel.js';
import { archiveService } from '../../services/archiveService.js';
import { startResearchDownload, updateChannel, startDownloadAll, stopAutoQueue, isAutoQueueActive } from '../../services/researchService.js';
import { refreshViewsAndReactions } from '../../services/refreshService.js';

/** Parse and validate a depth preset from request body, falling back to default. */
function parsePreset(body: Record<string, unknown> | undefined, fallback: DepthPreset = '3m'): DepthPreset {
  const raw = body?.preset as string | undefined;
  if (raw && (DEPTH_PRESETS as readonly string[]).includes(raw)) return raw as DepthPreset;
  return fallback;
}

const router = Router();

/** Validate that :id param is a valid MongoDB ObjectId */
function validateObjectId(req: Request, res: Response): boolean {
  const id = req.params.id as string;
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ error: 'Invalid channel ID' });
    return false;
  }
  return true;
}

// List all research channels (with optional server-side filtering)
router.get('/api/research/channels', async (req: Request, res: Response) => {
  try {
    const query: Record<string, unknown> = {};

    // Filter by status
    const status = req.query.status as string | undefined;
    if (status) query.status = status;

    // Filter by niche
    const niche = req.query.niche as string | undefined;
    if (niche) query['analytics.niche'] = niche;

    // Filter by score
    const minScore = parseFloat(req.query.minScore as string);
    const maxScore = parseFloat(req.query.maxScore as string);
    if (!isNaN(minScore) || !isNaN(maxScore)) {
      const scoreFilter: Record<string, number> = {};
      if (!isNaN(minScore)) scoreFilter.$gte = minScore;
      if (!isNaN(maxScore)) scoreFilter.$lte = maxScore;
      query['analytics.score.total'] = scoreFilter;
    }

    // Filter by subscribers
    const minSubs = parseInt(req.query.minSubs as string, 10);
    const maxSubs = parseInt(req.query.maxSubs as string, 10);
    if (!isNaN(minSubs) || !isNaN(maxSubs)) {
      const subsFilter: Record<string, number> = {};
      if (!isNaN(minSubs)) subsFilter.$gte = minSubs;
      if (!isNaN(maxSubs)) subsFilter.$lte = maxSubs;
      query.subscriberCount = subsFilter;
    }

    // Filter by collection (#59)
    const { collectionId } = req.query;
    if (typeof collectionId === 'string' && collectionId.length > 0) {
      if (!mongoose.Types.ObjectId.isValid(collectionId)) {
        res.status(400).json({ error: 'Invalid collectionId' });
        return;
      }
      query.collectionIds = new mongoose.Types.ObjectId(collectionId);
    }

    const channels = await ResearchChannel.find(query).sort({ createdAt: -1 });
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Add channel to research
router.post('/api/research/channels', async (req: Request, res: Response) => {
  try {
    const { channelId, title, username, description, subscriberCount, hasAvatar, linkedGroup } = req.body;
    if (!channelId || !title) {
      res.status(400).json({ error: 'channelId and title are required' });
      return;
    }
    const defaultCollection = await ResearchCollection.findOne({ name: DEFAULT_COLLECTION_NAME });
    const channel = await ResearchChannel.create({
      channelId, title, username, description, subscriberCount, hasAvatar, linkedGroup,
      collectionIds: defaultCollection ? [defaultCollection._id] : [],
    });
    res.status(201).json(channel);
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      res.status(409).json({ error: 'Channel already in research' });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  }
});

// Download all discovered channels (auto-queue)
router.post('/api/research/channels/download-all', async (req: Request, res: Response) => {
  try {
    const preset = parsePreset(req.body);
    const skipMedia = req.body?.skipMedia !== undefined ? Boolean(req.body.skipMedia) : true;
    const result = await startDownloadAll(preset, skipMedia);
    res.json(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    res.status(statusCode).json({ error: (err as Error).message });
  }
});

// Stop auto-queue
router.post('/api/research/channels/stop-queue', async (_req: Request, res: Response) => {
  stopAutoQueue();
  res.json({ ok: true, message: 'Auto-queue stopped' });
});

// Get auto-queue status
router.get('/api/research/channels/queue-status', async (_req: Request, res: Response) => {
  res.json({ active: isAutoQueueActive() });
});

// Generate AI report for a channel via MCP harness (Claude Code CLI)
router.post('/api/research/channels/:id/generate-report', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;

  // Check if claude CLI is available
  try {
    execSync('which claude', { timeout: 5000 });
  } catch {
    res.status(501).json({ error: 'MCP harness (claude) not available. Install Claude Code CLI.' });
    return;
  }

  try {
    const channel = await ResearchChannel.findById(req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Research channel not found' });
      return;
    }

    const channelIdentifier = channel.username || channel.channelId;
    const prompt = `You are a Telegram channel analyst. Use the getChannelReport tool to get data for channel "${channelIdentifier}", then analyze it and write a structured report in Russian. The report should include:

📊 Вердикт: РЕКОМЕНДУЕТСЯ / ВОЗМОЖНО / НЕ РЕКОМЕНДУЕТСЯ (for ad placement of a crypto news channel and crypto portfolio tracker)

Контент: [brief description of content type]
Аудитория: [who reads, view counts]
Рекламная нагрузка: [percent]
Активность: [posts per week, trend]

✅ Плюсы:
• ...

⚠️ Минусы/Риски:
• ...

💡 Рекомендация для размещения:
[specific recommendation]

After writing the report, use the saveChannelReport tool to save it for channel "${channelIdentifier}".
Only output "done" when finished.`;

    const projectRoot = process.cwd();

    const child = spawn('claude', [
      '-p', prompt,
      '--mcp-config', `${projectRoot}/.mcp.json`,
      '--dangerously-skip-permissions',
      '--model', 'sonnet',
      '--output-format', 'text',
    ], {
      cwd: projectRoot,
      timeout: 120000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

    child.on('close', async (code: number | null) => {
      if (code === 0) {
        // Reload channel to get updated aiReport
        const updated = await ResearchChannel.findById(req.params.id);
        res.json(updated);
      } else {
        console.error(`[AI Report] Claude CLI failed (code ${code}):`, stderr);
        res.status(500).json({ error: 'Report generation failed', details: stderr.slice(0, 500) });
      }
    });

    child.on('error', (err: Error) => {
      console.error('[AI Report] Failed to spawn claude:', err);
      res.status(500).json({ error: 'Failed to start report generation', details: err.message });
    });

  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Delete research channel
router.delete('/api/research/channels/:id', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const channel = await ResearchChannel.findByIdAndDelete(req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Research channel not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Download research channel posts
router.post('/api/research/channels/:id/download', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const preset = parsePreset(req.body);
    const skipMedia = req.body?.skipMedia !== undefined ? Boolean(req.body.skipMedia) : true;
    const result = await startResearchDownload(req.params.id as string, preset, skipMedia);
    res.json(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    res.status(statusCode).json({ error: (err as Error).message });
  }
});

// Update research channel (CRM fields: status, notes, contactInfo)
router.put('/api/research/channels/:id', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const { status, notes, aiReport, contactInfo, lastContactedAt } = req.body;
    const update: Record<string, unknown> = {};
    if (status !== undefined) update.status = status;
    if (notes !== undefined) update.notes = notes;
    if (aiReport !== undefined) update.aiReport = aiReport;
    if (contactInfo !== undefined) update.contactInfo = contactInfo;
    if (lastContactedAt !== undefined) update.lastContactedAt = lastContactedAt;

    const channel = await ResearchChannel.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!channel) {
      res.status(404).json({ error: 'Research channel not found' });
      return;
    }
    res.json(channel);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Analyze (or re-analyze) a research channel
router.post('/api/research/channels/:id/analyze', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const id = req.params.id as string;
    await analyzeChannel(id);
    const channel = await ResearchChannel.findById(id);
    res.json(channel);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Incremental sync — fetch only new posts since last download
router.post('/api/research/channels/:id/update', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const result = await updateChannel(req.params.id as string);
    res.json(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    res.status(statusCode).json({ error: (err as Error).message });
  }
});

// Refresh views & reactions for existing posts
router.post('/api/research/channels/:id/refresh', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const channel = await ResearchChannel.findById(req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Research channel not found' });
      return;
    }

    const limit = typeof req.body?.limit === 'number' && req.body.limit > 0 ? req.body.limit : 100;
    const channelId = channel.username || channel.channelId;
    const result = await refreshViewsAndReactions(channelId, limit);

    // Update lastUpdatedAt and re-analyze
    await ResearchChannel.findByIdAndUpdate(req.params.id, {
      lastUpdatedAt: new Date(),
    });

    try {
      await analyzeChannel(req.params.id as string);
    } catch (analyzeErr) {
      console.error(`[Research] Re-analyze after refresh failed:`, analyzeErr);
    }

    res.json(result);
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode || 500;
    res.status(statusCode).json({ error: (err as Error).message });
  }
});

// Get posts for a research channel
router.get('/api/research/channels/:id/posts', async (req: Request, res: Response) => {
  if (!validateObjectId(req, res)) return;
  try {
    const channel = await ResearchChannel.findById(req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Research channel not found' });
      return;
    }
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    let result = await archiveService.getPosts(channel.channelId, page, limit);
    if (result.total === 0 && channel.username) {
      result = await archiveService.getPosts(channel.username, page, limit);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
