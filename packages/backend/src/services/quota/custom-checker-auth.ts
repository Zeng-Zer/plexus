import { OAuthAuthManager } from '../oauth/oauth-auth-manager';

function optionString(options: Record<string, unknown>, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Custom checkers run in an isolated worker and cannot call OAuthAuthManager.
 * When the assigned provider is OAuth-backed, resolve the live token here so
 * `ctx.fetch()` / `ctx.requestHeaders()` receive a real API key.
 */
export async function injectOAuthApiKey(
  options: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const existing = optionString(options, 'apiKey');
  if (existing && existing.toLowerCase() !== 'oauth') return options;

  const oauthProvider = optionString(options, 'oauthProvider');
  if (!oauthProvider) return options;

  const accountId = optionString(options, 'oauthAccountId') || undefined;
  const authManager = OAuthAuthManager.getInstance();
  try {
    return { ...options, apiKey: await authManager.getApiKey(oauthProvider, accountId) };
  } catch (error) {
    await authManager.reload();
    try {
      return { ...options, apiKey: await authManager.getApiKey(oauthProvider, accountId) };
    } catch {
      throw error;
    }
  }
}
