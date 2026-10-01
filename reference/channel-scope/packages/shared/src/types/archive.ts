export interface ArchiveProgress {
  status: 'idle' | 'downloading' | 'paused' | 'completed' | 'error';
  channel: string;
  totalProcessed: number;
  totalSaved: number;
  mediaDownloaded: number;
  errors: number;
  message: string;
  lastPost?: unknown;
}

export interface ArchiveHistoryItem {
  channelId: string;
  postCount: number;
  mediaCount: number;
  totalViews: number;
  avgViews: number;
  firstPostDate: string | null;
  lastPostDate: string | null;
}
