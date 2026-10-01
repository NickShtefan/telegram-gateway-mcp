import crypto from 'crypto';
import { EventEmitter } from 'events';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import Client from '../db/models/Client.js';
import ClientSession from '../db/models/ClientSession.js';

const ALGORITHM = 'aes-256-gcm';
const AUTH_TAG_LENGTH = 16;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function getEncryptionKey(): Buffer {
  const key = process.env.SESSION_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('SESSION_ENCRYPTION_KEY environment variable is required');
  }
  // Derive a 32-byte key from the provided key using SHA-256
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(text: string): { encrypted: string; iv: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return {
    encrypted: encrypted + ':' + authTag,
    iv: iv.toString('hex'),
  };
}

function decrypt(encryptedData: string, ivHex: string): string {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const [encrypted, authTagHex] = encryptedData.split(':');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

interface AuthState {
  phoneCodeResolver: ((code: string) => void) | null;
  passwordResolver: ((password: string) => void) | null;
  phoneCodeHash: string | null;
}

export class ClientManager extends EventEmitter {
  private clients: Map<string, TelegramClient> = new Map();
  private authStates: Map<string, AuthState> = new Map();
  private pendingConnections: Map<string, Promise<TelegramClient>> = new Map();

  async getClient(clientId: string): Promise<TelegramClient> {
    // Return existing connected client
    const existing = this.clients.get(clientId);
    if (existing) return existing;

    // Deduplicate concurrent connection attempts
    const pending = this.pendingConnections.get(clientId);
    if (pending) return pending;

    const connectionPromise = this.connectClient(clientId);
    this.pendingConnections.set(clientId, connectionPromise);

    try {
      return await connectionPromise;
    } finally {
      this.pendingConnections.delete(clientId);
    }
  }

  private async connectClient(clientId: string): Promise<TelegramClient> {
    const clientDoc = await Client.findById(clientId);
    if (!clientDoc) throw new Error('Client not found');

    const sessionDoc = await ClientSession.findOne({ clientId });
    const sessionString = sessionDoc
      ? decrypt(sessionDoc.sessionString, sessionDoc.iv)
      : '';

    const client = new TelegramClient(
      new StringSession(sessionString),
      clientDoc.apiId,
      clientDoc.apiHash,
      { connectionRetries: 5 },
    );

    await withTimeout(client.connect(), 30_000, 'Client connection');
    this.clients.set(clientId, client);
    return client;
  }

  async addClient(data: { name: string; phoneNumber: string; apiId: number; apiHash: string }) {
    const clientDoc = await Client.create({
      name: data.name,
      phoneNumber: data.phoneNumber,
      apiId: data.apiId,
      apiHash: data.apiHash,
      status: 'needs_auth',
    });
    return clientDoc;
  }

  async removeClient(clientId: string): Promise<void> {
    await this.disconnect(clientId);
    await ClientSession.deleteMany({ clientId });
    await Client.findByIdAndDelete(clientId);
  }

  async startAuth(clientId: string, opts: { phoneNumber: string; apiId: number; apiHash: string }): Promise<void> {
    const clientDoc = await Client.findById(clientId);
    if (!clientDoc) throw new Error('Client not found');

    // Always start fresh — exactly like the original fetchHistorical.js from aa2311d
    // Never reuse old sessions for auth — they can interfere with DC migration
    const client = new TelegramClient(
      new StringSession(''),
      opts.apiId,
      opts.apiHash,
      { connectionRetries: 5 },
    );

    const authState: AuthState = {
      phoneCodeResolver: null,
      passwordResolver: null,
      phoneCodeHash: null,
    };
    this.authStates.set(clientId, authState);

    console.log(`[ClientManager] Starting auth for client ${clientId}, phone: ${opts.phoneNumber}`);
    this.emit('status', { clientId, status: 'connecting' });

    // Mirrors the original working script exactly:
    // - phoneNumber as string, NOT async function
    // - NO client.connect() before client.start()
    // - client.start() handles DC migration internally
    try {
      await client.start({
        phoneNumber: opts.phoneNumber,
        phoneCode: async () => {
          console.log(`[ClientManager] Code requested by Telegram for client ${clientId}`);
          clientDoc.status = 'awaiting_code';
          await clientDoc.save();
          this.emit('status', { clientId, status: 'awaiting_code' });
          const codePromise = new Promise<string>((resolve) => {
            authState.phoneCodeResolver = resolve;
          });
          return withTimeout(codePromise, AUTH_TIMEOUT_MS, 'Phone code input');
        },
        password: async () => {
          console.log(`[ClientManager] 2FA password requested for client ${clientId}`);
          clientDoc.status = 'awaiting_password';
          await clientDoc.save();
          this.emit('status', { clientId, status: 'awaiting_password' });
          const passwordPromise = new Promise<string>((resolve) => {
            authState.passwordResolver = resolve;
          });
          return withTimeout(passwordPromise, AUTH_TIMEOUT_MS, '2FA password input');
        },
        onError: (err: Error) => {
          console.error(`[ClientManager] Auth error for ${clientId}:`, err.message);
          this.emit('status', { clientId, status: 'error', message: err.message });
        },
      });
    } catch (err) {
      this.authStates.delete(clientId);
      try { await client.disconnect(); } catch { /* ignore */ }
      clientDoc.status = 'needs_auth';
      await clientDoc.save();
      this.emit('status', { clientId, status: 'error', message: (err as Error).message });
      throw err;
    }

    console.log(`[ClientManager] Auth complete for client ${clientId}`);

    // Save session encrypted — same as original saves to .session file
    const savedSession = client.session.save() as unknown as string;
    const { encrypted, iv } = encrypt(savedSession);

    await ClientSession.findOneAndUpdate(
      { clientId },
      { sessionString: encrypted, iv },
      { upsert: true },
    );

    clientDoc.status = 'active';
    await clientDoc.save();
    this.emit('status', { clientId, status: 'active' });

    this.clients.set(clientId, client);
    this.authStates.delete(clientId);
  }

  submitCode(clientId: string, code: string): boolean {
    const authState = this.authStates.get(clientId);
    if (authState?.phoneCodeResolver) {
      authState.phoneCodeResolver(code);
      authState.phoneCodeResolver = null;
      return true;
    }
    return false;
  }

  submitPassword(clientId: string, password: string): boolean {
    const authState = this.authStates.get(clientId);
    if (authState?.passwordResolver) {
      authState.passwordResolver(password);
      authState.passwordResolver = null;
      return true;
    }
    return false;
  }

  async getFirstActiveClient(): Promise<TelegramClient | null> {
    const clientDoc = await Client.findOne({ status: 'active' });
    if (!clientDoc) return null;
    return this.getClient(clientDoc._id.toString());
  }

  async disconnect(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) {
      try {
        await client.disconnect();
      } catch { /* ignore */ }
      this.clients.delete(clientId);
    }
    this.authStates.delete(clientId);
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.clients.keys());
    await Promise.all(ids.map(id => this.disconnect(id)));
  }
}

export const clientManager = new ClientManager();
