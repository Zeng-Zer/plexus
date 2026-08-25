import { beforeEach, describe, expect, it, vi } from 'vitest';

const getApiKey = vi.fn();
const reload = vi.fn();

vi.mock('../../oauth/oauth-auth-manager', () => ({
  OAuthAuthManager: {
    getInstance: () => ({ getApiKey, reload }),
    resetForTesting: vi.fn(),
  },
}));

import { injectOAuthApiKey } from '../custom-checker-auth';

describe('injectOAuthApiKey', () => {
  beforeEach(() => {
    getApiKey.mockReset();
    reload.mockReset();
  });

  it('leaves options unchanged when a real API key is already present', async () => {
    const options = { apiKey: 'user-key', oauthProvider: 'cursor' };

    await expect(injectOAuthApiKey(options)).resolves.toBe(options);
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('leaves options unchanged when no OAuth provider is configured', async () => {
    const options = { endpoint: 'https://example.com' };

    await expect(injectOAuthApiKey(options)).resolves.toBe(options);
    expect(getApiKey).not.toHaveBeenCalled();
  });

  it('resolves an OAuth token when apiKey is missing', async () => {
    getApiKey.mockResolvedValue('cursor-oauth-token');

    await expect(
      injectOAuthApiKey({ oauthProvider: 'cursor', oauthAccountId: 'personal' })
    ).resolves.toEqual({
      oauthProvider: 'cursor',
      oauthAccountId: 'personal',
      apiKey: 'cursor-oauth-token',
    });
    expect(getApiKey).toHaveBeenCalledWith('cursor', 'personal');
  });

  it('resolves an OAuth token when apiKey is the oauth placeholder', async () => {
    getApiKey.mockResolvedValue('cursor-oauth-token');

    await expect(
      injectOAuthApiKey({
        apiKey: 'oauth',
        oauthProvider: 'cursor',
        oauthAccountId: 'personal',
      })
    ).resolves.toMatchObject({ apiKey: 'cursor-oauth-token' });
  });

  it('reloads credentials and retries once after a first getApiKey failure', async () => {
    getApiKey
      .mockRejectedValueOnce(new Error('not loaded'))
      .mockResolvedValueOnce('cursor-oauth-token');
    reload.mockResolvedValue(undefined);

    await expect(injectOAuthApiKey({ oauthProvider: 'cursor' })).resolves.toMatchObject({
      apiKey: 'cursor-oauth-token',
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getApiKey).toHaveBeenCalledTimes(2);
  });
});
