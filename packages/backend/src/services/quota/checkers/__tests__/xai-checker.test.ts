import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSpy } from '../../../../../test/test-utils';
import { createMeterContext, isCheckerRegistered } from '../../checker-registry';
import { OAuthAuthManager } from '../../../oauth/oauth-auth-manager';
import checkerDef from '../xai-checker';

const WEEKLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const MONTHLY_URL = 'https://cli-chat-proxy.grok.com/v1/billing';

const makeCtx = (options: Record<string, unknown> = {}) =>
  createMeterContext('xai-test', 'xai', {
    oauthAccountId: 'personal',
    ...options,
  });

const weeklyPayload = (overrides: Record<string, unknown> = {}) => ({
  config: {
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-20T15:00:47.524971+00:00',
      end: '2026-08-27T15:00:47.524971+00:00',
    },
    creditUsagePercent: 1,
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    prepaidBalance: { val: 0 },
    billingPeriodStart: '2026-08-20T15:00:47.524971+00:00',
    billingPeriodEnd: '2026-08-27T15:00:47.524971+00:00',
    ...overrides,
  },
});

const monthlyPayload = (overrides: Record<string, unknown> = {}) => ({
  config: {
    monthlyLimit: { val: 0 },
    used: { val: 0 },
    billingPeriodStart: '2026-08-01T00:00:00+00:00',
    billingPeriodEnd: '2026-09-01T00:00:00+00:00',
    ...overrides,
  },
});

describe('xai checker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    OAuthAuthManager.resetForTesting();
  });

  it('is registered under xai', () => {
    expect(isCheckerRegistered('xai')).toBe(true);
  });

  it('reports SuperGrok weekly usage from the credits billing endpoint', async () => {
    const authManager = OAuthAuthManager.getInstance();
    registerSpy(authManager, 'getApiKey').mockResolvedValue('xai-oauth-token');
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('format=credits')) {
        return new Response(JSON.stringify(weeklyPayload()), { status: 200 });
      }
      return new Response(JSON.stringify(monthlyPayload()), { status: 200 });
    }) as unknown as typeof fetch;

    const meters = await checkerDef.check(makeCtx());

    expect(authManager.getApiKey).toHaveBeenCalledWith('xai', 'personal');
    expect(global.fetch).toHaveBeenCalledWith(
      WEEKLY_URL,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer xai-oauth-token',
          'x-xai-token-auth': 'xai-grok-cli',
          Accept: 'application/json',
        }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith(MONTHLY_URL, expect.anything());
    expect(meters).toEqual([
      expect.objectContaining({
        key: 'weekly',
        label: 'SuperGrok weekly',
        kind: 'allowance',
        unit: 'percentage',
        limit: 100,
        used: 1,
        remaining: 99,
        periodValue: 1,
        periodUnit: 'week',
        periodCycle: 'fixed',
        resetsAt: '2026-08-27T15:00:47.524Z',
        status: 'ok',
        exhaustionThreshold: 100,
      }),
    ]);
  });

  it('defaults omitted weekly percent to 0% and skips zero monthly limits', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('xai-oauth-token');
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('format=credits')) {
        const payload = weeklyPayload();
        const { creditUsagePercent: _omitted, ...config } = payload.config;
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      return new Response(JSON.stringify(monthlyPayload()), { status: 200 });
    }) as unknown as typeof fetch;

    const meters = await checkerDef.check(makeCtx());

    expect(meters).toEqual([
      expect.objectContaining({
        key: 'weekly',
        used: 0,
        remaining: 100,
      }),
    ]);
  });

  it('adds monthly, prepaid, and on-demand meters when those pools have capacity', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('xai-oauth-token');
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('format=credits')) {
        return new Response(
          JSON.stringify(
            weeklyPayload({
              creditUsagePercent: 100,
              prepaidBalance: { val: 12 },
              onDemandCap: { val: 50 },
              onDemandUsed: { val: 10 },
            })
          ),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify(
          monthlyPayload({
            monthlyLimit: { val: 200 },
            used: { val: 40 },
          })
        ),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const meters = await checkerDef.check(makeCtx());

    expect(meters).toEqual([
      expect.objectContaining({
        key: 'weekly',
        used: 100,
        remaining: 0,
        status: 'exhausted',
        exhaustionThreshold: 101,
      }),
      expect.objectContaining({
        key: 'monthly',
        label: 'xAI monthly credits',
        unit: 'credits',
        limit: 200,
        used: 40,
        remaining: 160,
        periodUnit: 'month',
        resetsAt: '2026-09-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        key: 'prepaid',
        label: 'Prepaid balance',
        kind: 'balance',
        remaining: 12,
      }),
      expect.objectContaining({
        key: 'on_demand',
        label: 'On-demand credits',
        limit: 50,
        used: 10,
        remaining: 40,
      }),
    ]);
  });

  it('uses a configured API key and custom endpoint, plus the sibling monthly URL', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey');
    global.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(weeklyPayload({ creditUsagePercent: 22 })), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const meters = await checkerDef.check(
      makeCtx({
        apiKey: 'configured-token',
        endpoint: 'https://example.test/billing?format=credits',
      })
    );

    expect(OAuthAuthManager.getInstance().getApiKey).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://example.test/billing?format=credits',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer configured-token' }),
      })
    );
    expect(global.fetch).toHaveBeenCalledWith('https://example.test/billing', expect.anything());
    expect(meters[0]).toEqual(expect.objectContaining({ used: 22, remaining: 78 }));
  });

  it('rejects failed billing responses when no usable meters exist', async () => {
    registerSpy(OAuthAuthManager.getInstance(), 'getApiKey').mockResolvedValue('xai-oauth-token');
    global.fetch = vi.fn(
      async () => new Response('nope', { status: 401 })
    ) as unknown as typeof fetch;

    await expect(checkerDef.check(makeCtx())).rejects.toThrow(
      'xAI billing request failed with status 401'
    );
  });
});
