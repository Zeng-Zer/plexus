import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CURSOR_CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONVERSATIONS = 256;
export const MAX_CURSOR_CHECKPOINT_BYTES = 48 * 1024 * 1024;

export interface StoredCursorConversation {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobs: Map<string, Uint8Array>;
  historyFingerprint: string;
  lastAccessMs: number;
}

export interface CursorConversationCommit {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobs: Map<string, Uint8Array>;
  historyFingerprint: string;
}

interface PersistedCursorConversation {
  v: 1;
  conversationId: string;
  checkpoint: string | null;
  blobs: Record<string, string>;
  historyFingerprint: string;
  lastAccessMs: number;
}

const conversations = new Map<string, StoredCursorConversation>();
let persistDirOverride: string | undefined;

function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}

function persistDir(): string | undefined {
  const explicit = persistDirOverride ?? process.env.CURSOR_CONVERSATION_DIR?.trim();
  if (explicit) return explicit;
  const dataDir = process.env.DATA_DIR?.trim();
  return dataDir ? join(dataDir, 'cursor-conversations') : undefined;
}

function persistPath(storeKey: string): string | undefined {
  const dir = persistDir();
  if (!dir) return undefined;
  return join(dir, `${sha256Hex(storeKey).slice(0, 32)}.json`);
}

function encodeBytes(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function decodeBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function writePersisted(storeKey: string, stored: StoredCursorConversation): void {
  const path = persistPath(storeKey);
  if (!path) return;
  const dir = persistDir();
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const payload: PersistedCursorConversation = {
    v: 1,
    conversationId: stored.conversationId,
    checkpoint: stored.checkpoint ? encodeBytes(stored.checkpoint) : null,
    blobs: Object.fromEntries([...stored.blobs].map(([id, data]) => [id, encodeBytes(data)])),
    historyFingerprint: stored.historyFingerprint,
    lastAccessMs: stored.lastAccessMs,
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, path);
}

function readPersisted(storeKey: string, now = Date.now()): StoredCursorConversation | undefined {
  const path = persistPath(storeKey);
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PersistedCursorConversation;
    if (parsed.v !== 1 || typeof parsed.conversationId !== 'string') {
      unlinkSync(path);
      return undefined;
    }
    if (now - parsed.lastAccessMs > CURSOR_CONVERSATION_TTL_MS) {
      unlinkSync(path);
      return undefined;
    }
    const checkpoint = parsed.checkpoint ? decodeBytes(parsed.checkpoint) : null;
    if (checkpoint && checkpoint.byteLength > MAX_CURSOR_CHECKPOINT_BYTES) return undefined;
    const blobs = new Map<string, Uint8Array>();
    for (const [id, data] of Object.entries(parsed.blobs ?? {})) {
      blobs.set(id, decodeBytes(data));
    }
    return {
      conversationId: parsed.conversationId,
      checkpoint,
      blobs,
      historyFingerprint: parsed.historyFingerprint ?? '',
      lastAccessMs: parsed.lastAccessMs,
    };
  } catch {
    return undefined;
  }
}

function deletePersisted(storeKey: string): void {
  const path = persistPath(storeKey);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Missing files are fine during eviction/reset.
  }
}

/** Stable anonymous key when the client sent no session / cache id. */
export function hashCursorMessagePrefix(
  messages: Array<{ role?: string; content?: unknown }>
): string {
  const firstUser = messages.find((message) => message.role === 'user');
  return sha256Hex(messageText(firstUser?.content)).slice(0, 16);
}

export function deriveCursorConversationKey(payload: {
  prompt_cache_key?: unknown;
  user?: unknown;
  messages?: Array<{ role?: string; content?: unknown }>;
}): string {
  for (const value of [payload.prompt_cache_key, payload.user]) {
    if (typeof value === 'string' && value.trim()) return `id:${value.trim()}`;
  }
  return `anon:${hashCursorMessagePrefix(Array.isArray(payload.messages) ? payload.messages : [])}`;
}

export function cursorConversationStoreKey(apiKey: string, conversationKey: string): string {
  return `${sha256Hex(apiKey).slice(0, 16)}:${conversationKey}`;
}

export function fingerprintCursorHistory(
  messages: Array<{
    role?: string;
    content?: unknown;
    tool_call_id?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    images?: unknown[];
  }>
): string {
  const normalized = messages
    .filter((message) => message.role !== 'system' && message.role !== 'developer')
    .map((message) => ({
      role: message.role ?? '',
      content: messageText(message.content),
      tool_call_id: message.tool_call_id ?? null,
      tool_calls: (message.tool_calls ?? []).map((call) => ({
        id: call.id ?? '',
        name: call.function?.name ?? '',
        arguments: call.function?.arguments ?? '',
      })),
      imageCount: message.images?.length ?? 0,
    }));
  return sha256Hex(JSON.stringify(normalized));
}

function evictStale(now = Date.now()): void {
  for (const [key, stored] of conversations) {
    if (now - stored.lastAccessMs > CURSOR_CONVERSATION_TTL_MS) {
      conversations.delete(key);
      deletePersisted(key);
    }
  }
  while (conversations.size > MAX_CONVERSATIONS) {
    let oldestKey: string | undefined;
    let oldestAccess = Number.POSITIVE_INFINITY;
    for (const [key, stored] of conversations) {
      if (stored.lastAccessMs < oldestAccess) {
        oldestAccess = stored.lastAccessMs;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    conversations.delete(oldestKey);
    deletePersisted(oldestKey);
  }
}

export function getCursorConversation(storeKey: string): StoredCursorConversation | undefined {
  evictStale();
  const stored = conversations.get(storeKey) ?? readPersisted(storeKey);
  if (!stored) return undefined;
  stored.lastAccessMs = Date.now();
  conversations.set(storeKey, stored);
  writePersisted(storeKey, stored);
  return stored;
}

export function commitCursorConversation(storeKey: string, commit: CursorConversationCommit): void {
  evictStale();
  const checkpoint =
    commit.checkpoint && commit.checkpoint.byteLength > MAX_CURSOR_CHECKPOINT_BYTES
      ? null
      : commit.checkpoint;
  const existing = conversations.get(storeKey) ?? readPersisted(storeKey);
  const blobs = existing?.blobs ?? new Map<string, Uint8Array>();
  for (const [id, data] of commit.blobs) {
    blobs.delete(id);
    blobs.set(id, data);
  }
  const stored: StoredCursorConversation = {
    conversationId: commit.conversationId,
    checkpoint,
    blobs,
    historyFingerprint: commit.historyFingerprint,
    lastAccessMs: Date.now(),
  };
  conversations.set(storeKey, stored);
  writePersisted(storeKey, stored);
}

export function rotateCursorConversation(
  storeKey: string,
  conversationId = crypto.randomUUID()
): string {
  const stored: StoredCursorConversation = {
    conversationId,
    checkpoint: null,
    blobs: new Map(),
    historyFingerprint: '',
    lastAccessMs: Date.now(),
  };
  conversations.set(storeKey, stored);
  writePersisted(storeKey, stored);
  return conversationId;
}

export function invalidateCursorConversation(storeKey: string | undefined): void {
  if (!storeKey) return;
  rotateCursorConversation(storeKey);
}

export function setCursorConversationPersistDir(dir: string | undefined): void {
  persistDirOverride = dir;
}

export function clearCursorConversationMemory(): void {
  conversations.clear();
}

export function resetCursorConversationStore(): void {
  conversations.clear();
  const dir = persistDirOverride ?? process.env.CURSOR_CONVERSATION_DIR?.trim();
  if (dir) rmSync(dir, { recursive: true, force: true });
  persistDirOverride = undefined;
}
