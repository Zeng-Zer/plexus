import { describe, expect, test } from 'vitest';
import { getCacheRoutingHeaders, resolveXaiConvId } from '../cache-routing-headers';

describe('getCacheRoutingHeaders', () => {
  test('extracts session affinity headers from an incoming request', () => {
    expect(
      getCacheRoutingHeaders({
        'session-id': 'conversation-1',
        'x-session-affinity': 'conversation-1',
        'x-session-id': 'conversation-1',
        'x-prompt-cache-isolation-key': 'tenant-1',
        'x-multi-turn-session-id': 'rollout-1',
        'x-grok-conv-id': 'conv_abc123',
      })
    ).toEqual({
      session_id: 'conversation-1',
      'x-client-request-id': undefined,
      'x-session-affinity': 'conversation-1',
      'x-session-id': 'conversation-1',
      'x-prompt-cache-isolation-key': 'tenant-1',
      'x-multi-turn-session-id': 'rollout-1',
      'x-grok-conv-id': 'conv_abc123',
    });
  });

  test('preserves prompt cache key fallbacks for Responses requests', () => {
    expect(getCacheRoutingHeaders({}, 'prompt-1')).toEqual({
      session_id: 'prompt-1',
      'x-client-request-id': 'prompt-1',
      'x-session-affinity': undefined,
      'x-session-id': undefined,
      'x-prompt-cache-isolation-key': undefined,
      'x-multi-turn-session-id': undefined,
      'x-grok-conv-id': undefined,
    });
  });

  test('returns undefined when no cache routing values are present', () => {
    expect(getCacheRoutingHeaders({})).toBeUndefined();
  });
});

describe('resolveXaiConvId', () => {
  test('prefers x-grok-conv-id over prompt_cache_key', () => {
    expect(
      resolveXaiConvId({ 'x-grok-conv-id': 'conv_abc123', session_id: 'session-1' }, 'prompt-1')
    ).toBe('conv_abc123');
  });

  test('falls back to prompt_cache_key then session ids', () => {
    expect(resolveXaiConvId(undefined, 'prompt-1')).toBe('prompt-1');
    expect(resolveXaiConvId({ session_id: 'session-1' })).toBe('session-1');
    expect(resolveXaiConvId({ 'x-session-id': ' xs-1 ' })).toBe('xs-1');
    expect(resolveXaiConvId({})).toBeUndefined();
  });
});
