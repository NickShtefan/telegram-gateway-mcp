import mongoose, { Schema, Document, Types } from 'mongoose';
import type { LinkedGroup } from 'channel-scope-shared';

export type { LinkedGroup };

export interface IChannel {
  channelId: string;
  title: string;
  username: string;
  description: string;
  subscriberCount: number;
  hasAvatar: boolean;
  linkedGroup: LinkedGroup | null;
  clientIds: Types.ObjectId[];
  archived: boolean;
  archivedAt: Date | null;
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
    lastPostDate: Date | null;
    lastViewsSyncDate: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface IChannelDocument extends IChannel, Document {
  _id: Types.ObjectId;
}

const ChannelSchema = new Schema<IChannel>({
  channelId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  username: { type: String, default: '' },
  description: { type: String, default: '' },
  subscriberCount: { type: Number, default: 0 },
  hasAvatar: { type: Boolean, default: false },
  linkedGroup: {
    type: {
      chatId: { type: Schema.Types.Mixed },
      title: { type: String, default: '' },
      username: { type: String, default: null },
    },
    default: null,
  },
  clientIds: [{ type: Schema.Types.ObjectId, ref: 'Client' }],
  archived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  settings: {
    autoEmoji: {
      enabled: { type: Boolean, default: false },
      emoji: { type: String, default: '❤️' },
      delay: { type: Number, default: 30 },
    },
    viewsSync: {
      enabled: { type: Boolean, default: false },
      strategy: { type: String, default: 'decay' },
      syncRunCount: { type: Number, default: 0 },
    },
  },
  stats: {
    postCount: { type: Number, default: 0 },
    lastPostDate: { type: Date, default: null },
    lastViewsSyncDate: { type: Date, default: null },
  },
}, { timestamps: true });

const Channel = mongoose.model('Channel', ChannelSchema);
export default Channel;
