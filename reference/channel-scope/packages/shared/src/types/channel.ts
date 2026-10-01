export interface LinkedGroup {
  chatId: string | number;
  title: string;
  username: string | null;
}

export interface Channel {
  _id: string;
  channelId: string;
  title: string;
  username: string;
  description: string;
  subscriberCount: number;
  hasAvatar: boolean;
  linkedGroup: LinkedGroup | null;
  clientIds: string[];
  archived: boolean;
  archivedAt: string | null;
  settings: {
    autoEmoji: {
      enabled: boolean;
      emoji: string;
      delay: number;
    };
    viewsSync: {
      enabled: boolean;
      strategy: string;
      syncRunCount: number;
    };
  };
  stats: {
    postCount: number;
    lastPostDate: string | null;
    lastViewsSyncDate: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ChannelSearchResult {
  channelId: string;
  title: string;
  username: string;
  description: string;
  subscriberCount: number;
  hasAvatar: boolean;
  linkedGroup: LinkedGroup | null;
  alreadyAdded: boolean;
  /** Numeric Telegram channel ID — for enrichment when username is unavailable */
  telegramId?: string;
  /** Session-bound access hash — required to resolve channels without username */
  accessHash?: string;
}
