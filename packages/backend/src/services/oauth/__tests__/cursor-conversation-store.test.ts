import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCursorConversationMemory,
  commitCursorConversation,
  cursorConversationStoreKey,
  deriveCursorConversationKey,
  fingerprintCursorHistory,
  getCursorConversation,
  hashCursorMessagePrefix,
  resetCursorConversationStore,
  setCursorConversationPersistDir,
} from '../cursor-conversation-store';

describe('Cursor conversation store keys', () => {
  afterEach(() => {
    resetCursorConversationStore();
  });

  it('prefers prompt_cache_key over the anonymous message prefix', () => {
    expect(
      deriveCursorConversationKey({
        prompt_cache_key: 'pi-session-1',
        user: 'ignored',
        messages: [{ role: 'user', content: 'Hello' }],
      })
    ).toBe('id:pi-session-1');
  });

  it('falls back to a stable hash of the first user message', () => {
    const messages = [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Again' },
    ];
    expect(deriveCursorConversationKey({ messages })).toBe(
      `anon:${hashCursorMessagePrefix(messages)}`
    );
    expect(deriveCursorConversationKey({ messages })).toBe(
      deriveCursorConversationKey({
        messages: [
          { role: 'system', content: 'Hindsight recall changed' },
          { role: 'user', content: 'Hello' },
        ],
      })
    );
  });

  it('isolates stored conversations by API key', () => {
    expect(cursorConversationStoreKey('key-a', 'id:session')).not.toBe(
      cursorConversationStoreKey('key-b', 'id:session')
    );
  });

  it('ignores reasoning-only differences when fingerprinting history', () => {
    expect(
      fingerprintCursorHistory([
        { role: 'assistant', content: 'Answer', reasoning_content: 'think' } as any,
      ])
    ).toBe(fingerprintCursorHistory([{ role: 'assistant', content: 'Answer' }]));
  });

  it('ignores volatile system and developer text when fingerprinting history', () => {
    expect(
      fingerprintCursorHistory([
        { role: 'system', content: 'Hindsight recall A' },
        { role: 'developer', content: 'Use tools' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ])
    ).toBe(
      fingerprintCursorHistory([
        { role: 'system', content: 'Hindsight recall B' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ])
    );
  });

  it('reloads committed checkpoints after a process-local memory clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plexus-cursor-conversations-'));
    setCursorConversationPersistDir(dir);
    const storeKey = cursorConversationStoreKey('key-a', 'id:session');
    commitCursorConversation(storeKey, {
      conversationId: 'conv-1',
      checkpoint: new Uint8Array([1, 2, 3]),
      blobs: new Map([['blob-1', new Uint8Array([9])]]),
      historyFingerprint: 'fp-1',
    });

    clearCursorConversationMemory();
    const reloaded = getCursorConversation(storeKey);
    expect(reloaded?.conversationId).toBe('conv-1');
    expect([...reloaded!.checkpoint!]).toEqual([1, 2, 3]);
    expect([...reloaded!.blobs.get('blob-1')!]).toEqual([9]);
    expect(reloaded?.historyFingerprint).toBe('fp-1');
  });
});
