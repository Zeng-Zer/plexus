/** Cursor's current default Agent window. The SDK catalog does not report this. */
export const DEFAULT_CURSOR_CONTEXT_LENGTH = 200_000;
export const GROK_CURSOR_CONTEXT_LENGTH = 500_000;
const LEGACY_CURSOR_CONTEXT_LENGTH = 128_000;

/** Published provider windows for Cursor-served models the SDK does not describe. */
const PUBLISHED_CURSOR_CONTEXT_LENGTHS: Array<{ pattern: RegExp; tokens: number }> = [
  { pattern: /(?:^|[-_/])grok-4[.-](?:5|6)(?:[-_/]|$)/, tokens: GROK_CURSOR_CONTEXT_LENGTH },
];

export function isCursorNativeModelId(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return id.startsWith('composer') || id.startsWith('cursor-') || id.includes('/composer');
}

function readSdkContextLength(model: unknown): number | undefined {
  if (!model || typeof model !== 'object') return undefined;
  const record = model as Record<string, unknown>;
  const limit =
    record.limit && typeof record.limit === 'object'
      ? (record.limit as Record<string, unknown>)
      : undefined;
  const candidates = [
    record.contextWindow,
    record.context_length,
    record.contextLength,
    record.maxContextTokens,
    limit?.context,
  ];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function publishedContextLength(modelId: string): number | undefined {
  const id = modelId.trim().toLowerCase();
  for (const entry of PUBLISHED_CURSOR_CONTEXT_LENGTHS) {
    if (entry.pattern.test(id)) return entry.tokens;
  }
  return undefined;
}

/** SDK windows win; otherwise use published model windows, then 200k / legacy 128k. */
export function resolveCursorContextLength(modelId: string, sdkModel?: unknown): number {
  const fromSdk = readSdkContextLength(sdkModel);
  if (fromSdk) return fromSdk;
  const published = publishedContextLength(modelId);
  if (published) return published;
  const id = modelId.trim().toLowerCase();
  if (/(?:^|[-_/])gpt-4o(?:[-_/]|$)/.test(id) || id.includes('gpt-4-turbo')) {
    return LEGACY_CURSOR_CONTEXT_LENGTH;
  }
  return DEFAULT_CURSOR_CONTEXT_LENGTH;
}
