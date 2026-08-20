import type { CacheRoutingHeaders } from '../types/unified';

type Headers = Record<string, string | string[] | undefined>;

export function getHeaderValue(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function getCacheRoutingHeaders(
  headers: Headers,
  promptCacheKey?: string
): CacheRoutingHeaders | undefined {
  const cacheRoutingHeaders: CacheRoutingHeaders = {
    session_id:
      getHeaderValue(headers, 'session_id') ||
      getHeaderValue(headers, 'session-id') ||
      promptCacheKey,
    'x-client-request-id': getHeaderValue(headers, 'x-client-request-id') || promptCacheKey,
    'x-session-affinity': getHeaderValue(headers, 'x-session-affinity'),
    'x-session-id': getHeaderValue(headers, 'x-session-id'),
    'x-prompt-cache-isolation-key': getHeaderValue(headers, 'x-prompt-cache-isolation-key'),
    'x-multi-turn-session-id': getHeaderValue(headers, 'x-multi-turn-session-id'),
    'x-grok-conv-id': getHeaderValue(headers, 'x-grok-conv-id'),
  };

  return Object.values(cacheRoutingHeaders).some(Boolean) ? cacheRoutingHeaders : undefined;
}

/** Sticky xAI cache route: conv header, then prompt_cache_key, then other session ids. */
export function resolveXaiConvId(
  cacheRouting?: CacheRoutingHeaders,
  promptCacheKey?: string
): string | undefined {
  for (const value of [
    cacheRouting?.['x-grok-conv-id'],
    promptCacheKey,
    cacheRouting?.session_id,
    cacheRouting?.['x-session-id'],
    cacheRouting?.['x-session-affinity'],
    cacheRouting?.['x-multi-turn-session-id'],
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
