import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOAuthProviderAuth, listOAuthProviders } from '../oauth-providers';

const sdk = vi.hoisted(() => ({
  login: vi.fn(),
}));

vi.mock('@cursor/sdk', () => ({
  Cursor: { auth: { login: sdk.login } },
}));

describe('Cursor OAuth provider', () => {
  beforeEach(() => sdk.login.mockReset());

  it('is listed and bridges the official SDK login URL without SDK persistence', async () => {
    sdk.login.mockResolvedValue({ apiKey: 'cursor-key', apiKeyExpiresAtMs: 123456 });
    const provider = getOAuthProviderAuth('cursor')!;
    const notify = vi.fn();
    const signal = new AbortController().signal;

    const credentials = await provider.oauth.login({ signal, notify, prompt: vi.fn() });

    expect(listOAuthProviders().some(({ id }) => id === 'cursor')).toBe(true);
    expect(provider).toMatchObject({
      id: 'cursor',
      name: 'Cursor Subscription',
      refreshable: false,
    });
    expect(sdk.login).toHaveBeenCalledWith(
      expect.objectContaining({ openBrowser: false, store: null, signal })
    );
    sdk.login.mock.calls.at(-1)![0].onLoginUrl('https://cursor.com/login/test');
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'auth_url', url: 'https://cursor.com/login/test' })
    );
    expect(credentials).toEqual({
      type: 'oauth',
      access: 'cursor-key',
      refresh: '',
      expires: 123456,
    });
  });

  it('rejects refresh with an actionable re-login error', async () => {
    const provider = getOAuthProviderAuth('cursor')!;
    await expect(
      provider.oauth.refresh(
        {
          type: 'oauth',
          access: 'expired',
          refresh: '',
          expires: 0,
        },
        new AbortController().signal
      )
    ).rejects.toThrow('Cursor API key expired. Re-run OAuth login');
  });
});
