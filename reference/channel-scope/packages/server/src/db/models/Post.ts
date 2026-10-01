import mongoose, { Schema, Document, Types } from 'mongoose';
import type { MediaItem, Reaction } from 'channel-scope-shared';

export interface IViewsHistoryEntry {
  date: Date;
  views: number;
}

export interface IStats {
  views: number;
  reactions: Reaction[];
  viewsHistory?: IViewsHistoryEntry[];
}

export interface IPost {
  telegramId: number;
  channelId: string;
  text: string;
  entities: unknown[];
  media: MediaItem[];
  stats: IStats;
  date: Date;
  createdAt: Date;
  updatedAt: Date;
  autoEmojiSent?: boolean;
  mediaDownloadFailed?: boolean;
}

export interface IPostDocument extends IPost, Document {
  _id: Types.ObjectId;
}

const PostSchema = new Schema<IPost>({
  telegramId: { type: Number, required: true },
  channelId: { type: String, required: true },
  text: { type: String, default: '' },
  entities: { type: [Schema.Types.Mixed], default: [] },
  media: [
    {
      fileId: String,
      fileType: String,
      caption: String,
      filename: String,
      filePath: String,
      media_group_id: { type: String, default: null },
      width: Number,
      height: Number,
      duration: Number,
      mime_type: String,
      downloaded: Boolean,
      error: String,
    }
  ],
  stats: {
    views: { type: Number, default: 0 },
    reactions: {
      type: [{
        reaction: { type: String, required: true },
        count: { type: Number, required: true, default: 0 }
      }],
      default: []
    },
    viewsHistory: {
      type: [{
        date: { type: Date, required: true },
        views: { type: Number, required: true }
      }],
      default: []
    }
  },
  date: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  autoEmojiSent: { type: Boolean, default: false },
  mediaDownloadFailed: { type: Boolean, default: false },
});

PostSchema.index({ telegramId: 1, channelId: 1 }, { unique: true });

const Post = mongoose.model('Post', PostSchema);
export default Post;
