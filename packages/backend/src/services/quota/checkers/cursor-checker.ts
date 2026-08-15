import { z } from 'zod';
import type { Meter } from '../../../types/meter';
import { OAuthAuthManager } from '../../oauth/oauth-auth-manager';
import { defineChecker } from '../checker-registry';

interface CursorUsageAmount {
  includedSpend?: number;
  remaining?: number;
  limit?: number;
  remainingBonus?: boolean;
}

interface CursorSpendLimitUsage {
  individualLimit?: number;
  individualUsed?: number;
  individualRemaining?: number;
  pooledLimit?: number;
  pooledUsed?: number;
  pooledRemaining?: number;
  limitType?: string;
}

interface CursorUsageResponse {
  billingCycleEnd?: string;
  planUsage?: CursorUsageAmount;
  spendLimitUsage?: CursorSpendLimitUsage;
}

const cents = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value / 100 : undefined;

const resetTime = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString()
    : undefined;
};

async function resolveApiKey(ctx: {
  getOption<T>(key: string, defaultValue: T): T;
}): Promise<string> {
  const configured = ctx.getOption<string>('apiKey', '').trim();
  if (configured) return configured;

  const accountId = ctx.getOption<string>('oauthAccountId', '').trim();
  const authManager = OAuthAuthManager.getInstance();
  try {
    return await authManager.getApiKey('cursor', accountId || undefined);
  } catch {
    await authManager.reload();
    return authManager.getApiKey('cursor', accountId || undefined);
  }
}

async function postJson(
  url: string,
  token: string,
  timeoutMs: number,
  connectRpc = false
): Promise<unknown> {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(connectRpc ? { 'Connect-Protocol-Version': '1' } : {}),
    },
    body: '{}',
    signal,
  });
  const body = await response.text();
  if (!response.ok) {
    const operation = connectRpc ? 'usage request' : 'exchange';
    throw new Error(`Cursor ${operation} failed with status ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('failed to parse Cursor quota response');
  }
}

export default defineChecker({
  type: 'cursor',
  displayName: 'Cursor Subscription',
  optionsSchema: z.object({
    apiKey: z.string().optional(),
    oauthAccountId: z.string().optional(),
    exchangeEndpoint: z.string().url().optional(),
    endpoint: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  async check(ctx) {
    const apiKey = await resolveApiKey(ctx);
    const timeoutMs = ctx.getOption<number>('timeoutMs', 15000);
    const exchangeEndpoint = ctx.getOption<string>(
      'exchangeEndpoint',
      'https://api2.cursor.sh/auth/exchange_user_api_key'
    );
    const endpoint = ctx.getOption<string>(
      'endpoint',
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
    );

    const exchange = (await postJson(exchangeEndpoint, apiKey, timeoutMs)) as {
      accessToken?: string;
    };
    const accessToken = exchange.accessToken?.trim();
    if (!accessToken) throw new Error('Cursor exchange response missing accessToken');

    const usage = (await postJson(endpoint, accessToken, timeoutMs, true)) as CursorUsageResponse;
    if (!usage.planUsage) throw new Error('cursor usage response missing planUsage');

    const resetsAt = resetTime(usage.billingCycleEnd);
    const spend = usage.spendLimitUsage;
    const pooled = spend?.limitType === 'team';
    const onDemandLimit = pooled ? spend?.pooledLimit : spend?.individualLimit;
    const onDemandUsed = pooled ? spend?.pooledUsed : spend?.individualUsed;
    const onDemandRemaining = pooled ? spend?.pooledRemaining : spend?.individualRemaining;
    const hasOnDemandMeter =
      typeof onDemandLimit === 'number' && Number.isFinite(onDemandLimit) && onDemandLimit > 0;
    const hasIncludedCapacity =
      (typeof usage.planUsage.remaining === 'number' && usage.planUsage.remaining > 0) ||
      usage.planUsage.remainingBonus === true;
    const hasOnDemandCapacity =
      hasOnDemandMeter &&
      typeof onDemandRemaining === 'number' &&
      Number.isFinite(onDemandRemaining) &&
      onDemandRemaining > 0;
    const meters: Meter[] = [
      ctx.allowance({
        key: 'included_spend',
        label: 'Cursor included usage',
        unit: 'usd',
        limit: cents(usage.planUsage.limit),
        used: cents(usage.planUsage.includedSpend),
        remaining: cents(usage.planUsage.remaining),
        periodValue: 1,
        periodUnit: 'month',
        periodCycle: 'fixed',
        resetsAt,
        exhaustionThreshold:
          hasOnDemandCapacity || usage.planUsage.remainingBonus === true ? 101 : 100,
      }),
    ];

    if (hasOnDemandMeter) {
      meters.push(
        ctx.allowance({
          key: 'on_demand_spend',
          label: 'Cursor on-demand limit',
          unit: 'usd',
          limit: cents(onDemandLimit),
          used: cents(onDemandUsed),
          remaining: cents(onDemandRemaining),
          periodValue: 1,
          periodUnit: 'month',
          periodCycle: 'fixed',
          resetsAt,
          scope: pooled ? 'team' : 'user',
          exhaustionThreshold: hasIncludedCapacity ? 101 : 100,
        })
      );
    }

    return meters;
  },
});
