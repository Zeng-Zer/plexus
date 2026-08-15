import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSpy } from '../../../../../test/test-utils';
import { createMeterContext, isCheckerRegistered } from '../../checker-registry';
import { OAuthAuthManager } from '../../../oauth/oauth-auth-manager';
import checkerDef from '../cursor-checker';

const makeCtx = () =>
  createMeterContext('cursor-test', 'cursor', {
    oauthAccountId: 'personal',
    exchangeEndpoint: 'https://cursor.test/exchange',
    endpoint: 'https://cursor.test/usage',
  });

describe('cursor checker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    OAuthAuthManager.resetForTesting();
  });

  it('exchanges the OAuth API key and returns current-cycle included allowance', async () => {
    const authManager = OAuthAuthManager.getInstance();
    registerSpy(authManager, 'getApiKey').mockResolvedValue('crsr_test');
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'session-token', refreshToken: 'unused' }), {
          status: 200,
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            billingCycleStart: '1786462486000',
            billingCycleEnd: '1789140886000',
            planUsage: {
              includedSpend: 17,
              remaining: 1983,
              limit: 2000,
              totalSpend: 17,
            },
            spendLimitUsage: { limitType: 'user' },
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;

    const meters = await checkerDef.check(makeCtx());

    expect(isCheckerRegistered('cursor')).toBe(true);
    expect(authManager.getApiKey).toHaveBeenCalledWith('cursor', 'personal');
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://cursor.test/exchange',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer crsr_test' }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://cursor.test/usage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer session-token',
          'Connect-Protocol-Version': '1',
        }),
      })
    );
    expect(meters).toEqual([
      expect.objectContaining({
        key: 'included_spend',
        label: 'Cursor included usage',
        kind: 'allowance',
        unit: 'usd',
        limit: 20,
        used: 0.17,
        remaining: 19.83,
        periodValue: 1,
        periodUnit: 'month',
        periodCycle: 'fixed',
        resetsAt: '2026-09-11T15:34:46.000Z',
        status: 'ok',
      }),
    ]);
  });

  it('reports optional on-demand spend limit when Cursor returns one', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('crsr_test');
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: 'session-token' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            billingCycleEnd: '1789140886000',
            planUsage: { includedSpend: 2000, remaining: 0, limit: 2000 },
            spendLimitUsage: {
              individualLimit: 10000,
              individualUsed: 2500,
              individualRemaining: 7500,
              limitType: 'user',
            },
          }),
          { status: 200 }
        )
      ) as unknown as typeof fetch;

    const meters = await checkerDef.check(makeCtx());

    expect(meters).toEqual([
      expect.objectContaining({ key: 'included_spend', status: 'exhausted' }),
      expect.objectContaining({
        key: 'on_demand_spend',
        label: 'Cursor on-demand limit',
        limit: 100,
        used: 25,
        remaining: 75,
      }),
    ]);
  });

  it('rejects malformed or failed exchange and usage responses', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('crsr_test');
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await expect(checkerDef.check(makeCtx())).rejects.toThrow('exchange failed with status 401');

    global.fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: 'session-token' })))
      .mockResolvedValueOnce(new Response('{}')) as unknown as typeof fetch;
    await expect(checkerDef.check(makeCtx())).rejects.toThrow(
      'cursor usage response missing planUsage'
    );
  });
});
