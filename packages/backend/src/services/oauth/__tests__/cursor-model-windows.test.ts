import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CURSOR_CONTEXT_LENGTH,
  GROK_CURSOR_CONTEXT_LENGTH,
  isCursorNativeModelId,
  resolveCursorContextLength,
} from '../cursor-model-windows';

describe('Cursor model windows', () => {
  it('uses SDK-reported windows when present', () => {
    expect(resolveCursorContextLength('composer-2.5', { contextWindow: 256_000 })).toBe(256_000);
    expect(resolveCursorContextLength('composer-2.5', { limit: { context: 300_000 } })).toBe(
      300_000
    );
  });

  it('keeps legacy 4o-class models at 128k and defaults current Cursor models to 200k', () => {
    expect(resolveCursorContextLength('gpt-4o')).toBe(128_000);
    expect(resolveCursorContextLength('gpt-4o-mini')).toBe(128_000);
    expect(resolveCursorContextLength('gpt-4-turbo')).toBe(128_000);
    expect(resolveCursorContextLength('composer-2.5')).toBe(DEFAULT_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('claude-4.6-sonnet')).toBe(DEFAULT_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('gpt-5.4')).toBe(DEFAULT_CURSOR_CONTEXT_LENGTH);
  });

  it('uses the published 500k window for Grok 4.5/4.6', () => {
    expect(resolveCursorContextLength('grok-4.6')).toBe(GROK_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('grok-4.6-fast')).toBe(GROK_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('cursor-grok-4.6')).toBe(GROK_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('grok-4.5')).toBe(GROK_CURSOR_CONTEXT_LENGTH);
    expect(resolveCursorContextLength('grok-4-6')).toBe(GROK_CURSOR_CONTEXT_LENGTH);
  });

  it('identifies Cursor-native model ids', () => {
    expect(isCursorNativeModelId('composer-2.5')).toBe(true);
    expect(isCursorNativeModelId('cursor-grok-4.6')).toBe(true);
    expect(isCursorNativeModelId('gpt-5.4')).toBe(false);
  });
});
