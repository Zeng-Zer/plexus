import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMeterContext } from '../checker-registry';
import { validateCustomCheckerCode } from '../custom-checker-runtime';

const CURSOR_CHECKER = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../docs/examples/cursor-quota-checker.js'
  ),
  'utf8'
);

const EXCHANGE_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key';
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

const runExample = (options: Record<string, unknown> = { apiKey: 'cursor-user-key' }) => {
  const runBody = new Function(
    'ctx',
    `"use strict"; return (async () => {\n${CURSOR_CHECKER}\n})();`
  );
  return runBody(createMeterContext('cursor-subscription', 'cursor', options));
};

describe('cursor custom quota checker example', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is valid custom checker JavaScript', () => {
    expect(() => validateCustomCheckerCode(CURSOR_CHECKER)).not.toThrow();
  });

  it('reports split model percentages and on-demand spend', async () => {
    global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === EXCHANGE_URL) {
        expect(headers.get('Authorization')).toBe('Bearer cursor-user-key');
        return new Response(JSON.stringify({ accessToken: 'dashboard-token' }), { status: 200 });
      }
      if (url === USAGE_URL) {
        expect(headers.get('Authorization')).toBe('Bearer dashboard-token');
        expect(headers.get('Connect-Protocol-Version')).toBe('1');
        return new Response(
          JSON.stringify({
            billingCycleEnd: '1785542400000',
            planUsage: {
              autoPercentUsed: 12,
              apiPercentUsed: 40,
              remainingBonus: false,
            },
            spendLimitUsage: {
              limitType: 'user',
              individualLimit: 2000,
              individualUsed: 250,
              individualRemaining: 1750,
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const meters = await runExample();

    expect(meters).toEqual([
      expect.objectContaining({
        key: 'cursor_models',
        label: 'Cursor Models',
        unit: 'percentage',
        used: 12,
        remaining: 88,
        exhaustionThreshold: 101,
      }),
      expect.objectContaining({
        key: 'other_models',
        label: 'Other Models',
        unit: 'percentage',
        used: 40,
        remaining: 60,
        exhaustionThreshold: 101,
      }),
      expect.objectContaining({
        key: 'on_demand_spend',
        label: 'Cursor on-demand limit',
        unit: 'usd',
        limit: 20,
        used: 2.5,
        remaining: 17.5,
        exhaustionThreshold: 101,
      }),
    ]);
  });

  it('falls back to included USD spend when split percentages are absent', async () => {
    global.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === EXCHANGE_URL) {
        return new Response(JSON.stringify({ accessToken: 'dashboard-token' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          billingCycleEnd: '1785542400000',
          planUsage: {
            limit: 2000,
            includedSpend: 500,
            remaining: 1500,
          },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const meters = await runExample();

    expect(meters).toEqual([
      expect.objectContaining({
        key: 'included_spend',
        label: 'Cursor included usage',
        unit: 'usd',
        limit: 20,
        used: 5,
        remaining: 15,
        exhaustionThreshold: 100,
      }),
    ]);
  });
});
