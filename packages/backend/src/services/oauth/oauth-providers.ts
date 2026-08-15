/**
 * Plexus's OAuth provider facade.
 *
 * pi-ai 0.80.8 removed the pi-ai/oauth provider registry — OAuth is now owned
 * by each built-in Provider as `provider.auth.oauth` (login/refresh/toAuth).
 * This module is the single place Plexus resolves OAuth providers, plus the
 * provider metadata the management UI needs.
 *
 * Every pi-ai built-in provider with `auth.oauth` is exposed automatically —
 * Plexus does not maintain a per-provider allowlist, so new OAuth flows pi-ai
 * ships (e.g. xAI, Kimi Code, OpenRouter) become available with no code
 * changes here. `radius` is the one deliberate exception: it's a factory
 * (`radiusProvider({ id, name, gateway })`) for pointing at an arbitrary
 * self-hosted gateway, not a fixed identity provider like the others, so it
 * doesn't fit the "pick a provider, log in" model this facade assumes.
 */

import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import type { OAuthAuth } from '@earendil-works/pi-ai';

/** Provider id of an OAuth provider (e.g. 'anthropic', 'openai-codex'). */
export type OAuthProvider = string;
export type OAuthProviderId = string;

export interface OAuthProviderDescriptor {
  id: string;
  /** Display name shown by Plexus. */
  name: string;
  /** Whether login runs a local callback server with manual code fallback. */
  usesCallbackServer: boolean;
  /** OAuth flow implementation (login/refresh/toAuth). */
  oauth: OAuthAuth;
  /** False when expired credentials require a new login instead of refresh. */
  refreshable?: boolean;
}

/** Providers whose login flow runs a local callback server. */
const CALLBACK_SERVER_PROVIDERS = new Set(['anthropic', 'openai-codex']);

/**
 * Providers excluded from Plexus's OAuth surface despite having
 * `auth.oauth` in pi-ai. See module doc comment for why `radius` is excluded.
 */
const BLOCKED_PROVIDERS = new Set(['radius']);

const models = builtinModels();

const cursorOAuth: OAuthAuth = {
  name: 'Cursor Subscription',
  async login(interaction) {
    const { Cursor } = await import('@cursor/sdk');
    const result = await Cursor.auth.login({
      openBrowser: false,
      store: null,
      signal: interaction.signal,
      onLoginUrl: (url) =>
        interaction.notify({
          type: 'auth_url',
          url,
          instructions: 'Open this URL to sign in to Cursor and authorize Plexus.',
        }),
    });
    return {
      type: 'oauth',
      access: result.apiKey,
      refresh: '',
      expires: result.apiKeyExpiresAtMs,
    };
  },
  async refresh() {
    throw new Error('Cursor API key expired. Re-run OAuth login for this Cursor account.');
  },
  async toAuth(credentials) {
    return { apiKey: credentials.access };
  },
};

const cursorDescriptor: OAuthProviderDescriptor = {
  id: 'cursor',
  name: 'Cursor Subscription',
  usesCallbackServer: false,
  oauth: cursorOAuth,
  refreshable: false,
};

function toDescriptor(providerId: string): OAuthProviderDescriptor | undefined {
  if (BLOCKED_PROVIDERS.has(providerId)) return undefined;
  const provider = models.getProvider(providerId);
  const oauth = provider?.auth?.oauth;
  if (!provider || !oauth) return undefined;
  return {
    id: provider.id,
    name: oauth.name,
    usesCallbackServer: CALLBACK_SERVER_PROVIDERS.has(provider.id),
    oauth,
  };
}

/** Resolve an OAuth provider by id; undefined when unknown, blocked, or OAuth-less. */
export function getOAuthProviderAuth(providerId: string): OAuthProviderDescriptor | undefined {
  return providerId === 'cursor' ? cursorDescriptor : toDescriptor(providerId);
}

/** List all providers that support OAuth login, including Plexus-owned Cursor. */
export function listOAuthProviders(): OAuthProviderDescriptor[] {
  return [
    ...models
      .getProviders()
      .map((provider) => toDescriptor(provider.id))
      .filter((descriptor): descriptor is OAuthProviderDescriptor => descriptor !== undefined),
    cursorDescriptor,
  ];
}

/** Whether `providerId` is a usable OAuth provider (for config validation). */
export function isKnownOAuthProviderId(providerId: string): boolean {
  return getOAuthProviderAuth(providerId) !== undefined;
}
