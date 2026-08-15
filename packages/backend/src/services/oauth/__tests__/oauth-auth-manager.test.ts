import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthAuthManager } from '../oauth-auth-manager';

const mocks = vi.hoisted(() => ({
  configService: {
    getAllOAuthProviders: vi.fn(),
    getOAuthCredentials: vi.fn(),
    setOAuthCredentials: vi.fn(),
  },
  getConfigInstance: vi.fn(),
  getOAuthProviderAuth: vi.fn(),
  refresh: vi.fn(),
  toAuth: vi.fn(),
}));

vi.mock('../../configuration/config-service', () => ({
  ConfigService: { getInstance: mocks.getConfigInstance },
}));

vi.mock('../oauth-providers', () => ({
  getOAuthProviderAuth: mocks.getOAuthProviderAuth,
}));

const initialCredentials = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() + 8 * 60 * 60 * 1000,
};

const refreshedCredentials = {
  type: 'oauth' as const,
  access: 'new-access',
  refresh: 'new-refresh',
  expires: Date.now() + 8 * 60 * 60 * 1000,
};

describe('OAuthAuthManager', () => {
  beforeEach(() => {
    OAuthAuthManager.resetForTesting();
    mocks.getConfigInstance.mockReturnValue(mocks.configService);
    mocks.configService.getAllOAuthProviders.mockResolvedValue([
      { providerType: 'anthropic', accountId: 'personal' },
    ]);
    mocks.configService.getOAuthCredentials.mockResolvedValue(initialCredentials);
    mocks.configService.setOAuthCredentials.mockResolvedValue(undefined);
    mocks.refresh.mockResolvedValue(refreshedCredentials);
    mocks.toAuth.mockImplementation(async (credentials: { access: string }) => ({
      apiKey: credentials.access,
    }));
    mocks.getOAuthProviderAuth.mockReturnValue({
      oauth: {
        refresh: mocks.refresh,
        toAuth: mocks.toAuth,
      },
    });
  });

  async function createManager(): Promise<OAuthAuthManager> {
    const manager = OAuthAuthManager.getInstance();
    await manager.initialize();
    return manager;
  }

  it('refreshes proactively at the requested cadence and persists rotated credentials', async () => {
    const manager = await createManager();

    await expect(
      manager.getApiKey('anthropic', 'personal', { refreshIfOlderThanMs: 60 * 60 * 1000 })
    ).resolves.toBe('new-access');
    await expect(
      manager.getApiKey('anthropic', 'personal', { refreshIfOlderThanMs: 60 * 60 * 1000 })
    ).resolves.toBe('new-access');

    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.configService.setOAuthCredentials).toHaveBeenCalledWith('anthropic', 'personal', {
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: expect.any(Number),
    });
  });

  it('keeps the existing refresh token when a refresh response omits rotation', async () => {
    mocks.refresh.mockResolvedValueOnce({
      type: 'oauth',
      access: 'new-access',
      expires: Date.now() + 8 * 60 * 60 * 1000,
    });
    const manager = await createManager();

    await manager.getApiKey('anthropic', 'personal', { refreshIfOlderThanMs: 0 });

    expect(mocks.configService.setOAuthCredentials).toHaveBeenCalledWith(
      'anthropic',
      'personal',
      expect.objectContaining({ refreshToken: 'old-refresh' })
    );
  });

  it('serializes concurrent refreshes for one account', async () => {
    let resolveRefresh: ((value: typeof refreshedCredentials) => void) | undefined;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const manager = await createManager();

    const first = manager.getApiKey('anthropic', 'personal', { refreshIfOlderThanMs: 0 });
    const second = manager.getApiKey('anthropic', 'personal', { refreshIfOlderThanMs: 0 });

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    resolveRefresh?.(refreshedCredentials);

    await expect(Promise.all([first, second])).resolves.toEqual(['new-access', 'new-access']);
  });

  it('does not proactively refresh without a refresh cadence', async () => {
    const manager = await createManager();

    await expect(manager.getApiKey('anthropic', 'personal')).resolves.toBe('old-access');

    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('requires re-login for expired non-refreshable credentials', async () => {
    mocks.configService.getAllOAuthProviders.mockResolvedValue([
      { providerType: 'cursor', accountId: 'work' },
    ]);
    mocks.configService.getOAuthCredentials.mockResolvedValue({
      accessToken: 'expired-cursor-key',
      refreshToken: '',
      expiresAt: 0,
    });
    mocks.getOAuthProviderAuth.mockReturnValue({
      name: 'Cursor Subscription',
      refreshable: false,
      oauth: { refresh: mocks.refresh, toAuth: mocks.toAuth },
    });
    const manager = await createManager();

    await expect(manager.getApiKey('cursor', 'work')).rejects.toThrow(
      "OAuth: Cursor Subscription credential expired. Re-run OAuth login for account 'work'."
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('reports expired non-refreshable credentials as not ready', async () => {
    mocks.configService.getAllOAuthProviders.mockResolvedValue([
      { providerType: 'cursor', accountId: 'work' },
    ]);
    mocks.configService.getOAuthCredentials.mockResolvedValue({
      accessToken: 'expired-cursor-key',
      refreshToken: '',
      expiresAt: 0,
    });
    mocks.getOAuthProviderAuth.mockReturnValue({
      name: 'Cursor Subscription',
      refreshable: false,
      oauth: { refresh: mocks.refresh, toAuth: mocks.toAuth },
    });
    const manager = await createManager();

    expect(manager.hasProvider('cursor', 'work')).toBe(true);
    expect(manager.isCredentialReady('cursor', 'work')).toBe(false);
  });

  it('does not fake proactive refresh for a valid non-refreshable credential', async () => {
    mocks.configService.getAllOAuthProviders.mockResolvedValue([
      { providerType: 'cursor', accountId: 'work' },
    ]);
    mocks.configService.getOAuthCredentials.mockResolvedValue({
      accessToken: 'valid-cursor-key',
      refreshToken: '',
      expiresAt: Date.now() + 60_000,
    });
    mocks.getOAuthProviderAuth.mockReturnValue({
      name: 'Cursor Subscription',
      refreshable: false,
      oauth: { refresh: mocks.refresh, toAuth: mocks.toAuth },
    });
    const manager = await createManager();

    await expect(manager.getApiKey('cursor', 'work', { refreshIfOlderThanMs: 0 })).resolves.toBe(
      'valid-cursor-key'
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(manager.isCredentialReady('cursor', 'work')).toBe(true);
  });

  it('does not retain credentials in memory when database persistence fails', async () => {
    mocks.configService.setOAuthCredentials.mockRejectedValueOnce(
      new Error('database unavailable')
    );
    const manager = await createManager();

    await expect(
      manager.setCredentials('cursor', 'work', {
        type: 'oauth',
        access: 'cursor-key',
        refresh: '',
        expires: Date.now() + 60_000,
      })
    ).rejects.toThrow('database unavailable');
    expect(manager.hasProvider('cursor', 'work')).toBe(false);
  });
});
