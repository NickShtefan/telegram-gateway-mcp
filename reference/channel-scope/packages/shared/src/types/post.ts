export interface MediaItem {
  fileId: string;
  fileType: 'photo' | 'video' | 'animation' | 'gif';
  caption: string;
  filename: string;
  filePath?: string;
  media_group_id?: string | null;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  downloaded?: boolean;
  error?: string;
}

export interface Reaction {
  reaction: string;
  count: number;
}

export interface ViewsHistoryEntry {
  date: string;
  views: number;
}

export interface Post {
  _id: string;
  telegramId: number;
  channelId: string;
  text: string;
  entities: unknown[];
  media: MediaItem[];
  stats: {
    views: number;
    reactions: Reaction[];
    viewsHistory: ViewsHistoryEntry[];
  };
  date: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostsResponse {
  posts: Post[];
  total: number;
  page: number;
  pages: number;
}
