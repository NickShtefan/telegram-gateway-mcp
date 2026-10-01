// ─── GramJS types (for historical import) ───

export interface GramJSReactionResult {
  reaction: {
    emoticon?: string;
    className?: string;
    [key: string]: unknown;
  };
  count: number;
}

export interface GramJSReactions {
  results: GramJSReactionResult[];
}

export interface GramJSMessage {
  id: number;
  message: string;
  date: number;
  views?: number;
  entities?: unknown[];
  reactions?: GramJSReactions;
  media?: unknown;
  chat?: {
    username?: string;
    title?: string;
  };
}

export interface GramJSClient {
  downloadMedia(media: unknown): Promise<Buffer | Uint8Array>;
  iterMessages(channel: string, opts: {
    limit?: number;
    chunkSize: number;
    minId?: number;
    waitTime?: number;
    reverse?: boolean;
    offsetDate?: number;
  }): AsyncIterable<GramJSMessage>;
  getMessages(channel: string, opts: { ids: number | number[] }): Promise<GramJSMessage[]>;
  invoke(request: unknown): Promise<unknown>;
}
