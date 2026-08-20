import { z } from 'zod';
import type { Meter } from '../../../types/meter';
import { OAuthAuthManager } from '../../oauth/oauth-auth-manager';
import type { OAuthProvider } from '../../oauth/oauth-providers';
import { defineChecker } from '../checker-registry';

const DEFAULT_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const DEFAULT_WEEKLY_URL = `${DEFAULT_BILLING_URL}?format=credits`;

interface WeeklyUsage {
  creditUsagePercent: number;
  billingPeriodEnd?: string;
}

interface MonthlyUsage {
  monthlyLimit: number;
  used: number;
  billingPeriodEnd?: string;
}

function unwrapNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object' && 'val' in value) {
    const inner = (value as { val: unknown }).val;
    if (typeof inner === 'number' && Number.isFinite(inner)) return inner;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function billingConfig(payload: unknown): Record<string, unknown> | undefined {
  const root = asRecord(payload);
  return asRecord(root?.config) ?? root;
}

function parseIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseWeeklyUsage(payload: unknown): WeeklyUsage | undefined {
  const config = billingConfig(payload);
  if (!config) return undefined;
  const currentPeriod = asRecord(config.currentPeriod);
  if (currentPeriod?.type !== 'USAGE_PERIOD_TYPE_WEEKLY') return undefined;
  const raw = config.creditUsagePercent;
  const creditUsagePercent = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  return {
    creditUsagePercent,
    billingPeriodEnd: parseIsoDate(config.billingPeriodEnd) ?? parseIsoDate(currentPeriod.end),
  };
}

function parseMonthlyUsage(payload: unknown): MonthlyUsage | undefined {
  const config = billingConfig(payload);
  if (!config) return undefined;
  const monthlyLimit = unwrapNumber(config.monthlyLimit);
  const used = unwrapNumber(config.used);
  if (monthlyLimit === undefined || used === undefined) return undefined;
  return {
    monthlyLimit,
    used,
    billingPeriodEnd: parseIsoDate(config.billingPeriodEnd),
  };
}

function parsePrepaidRemaining(payload: unknown): number | undefined {
  return unwrapNumber(billingConfig(payload)?.prepaidBalance);
}

function parseOnDemand(payload: unknown): { limit: number; used: number } | undefined {
  const config = billingConfig(payload);
  if (!config) return undefined;
  const limit = unwrapNumber(config.onDemandCap);
  if (limit === undefined || limit <= 0) return undefined;
  return { limit, used: unwrapNumber(config.onDemandUsed) ?? 0 };
}

async function resolveApiKey(ctx: {
  getOption<T>(key: string, defaultValue: T): T;
}): Promise<string> {
  const configured = ctx.getOption<string>('apiKey', '').trim();
  if (configured) return configured;

  const provider = (ctx.getOption<string>('oauthProvider', 'xai').trim() || 'xai') as OAuthProvider;
  const accountId = ctx.getOption<string>('oauthAccountId', '').trim();
  const authManager = OAuthAuthManager.getInstance();
  try {
    return await authManager.getApiKey(provider, accountId || undefined);
  } catch {
    await authManager.reload();
    return authManager.getApiKey(provider, accountId || undefined);
  }
}

function siblingBillingUrl(url: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.searchParams.get('format') === 'credits') {
    parsed.searchParams.delete('format');
    return parsed.toString();
  }
  parsed.searchParams.set('format', 'credits');
  return parsed.toString();
}

async function fetchBillingJson(url: string, token: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-xai-token-auth': 'xai-grok-cli',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`xAI billing request failed with status ${response.status}: ${body}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('failed to parse xAI billing response');
  }
}

export default defineChecker({
  type: 'xai',
  displayName: 'xAI Grok (SuperGrok / X Premium+)',
  optionsSchema: z.object({
    apiKey: z.string().optional(),
    oauthAccountId: z.string().optional(),
    oauthProvider: z.string().optional(),
    endpoint: z.string().url().optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  async check(ctx) {
    const token = await resolveApiKey(ctx);
    const timeoutMs = ctx.getOption<number>('timeoutMs', 15000);
    const weeklyUrl = ctx.getOption<string>('endpoint', DEFAULT_WEEKLY_URL);
    const monthlyUrl =
      weeklyUrl === DEFAULT_WEEKLY_URL ? DEFAULT_BILLING_URL : siblingBillingUrl(weeklyUrl);

    const weeklyResult = await fetchBillingJson(weeklyUrl, token, timeoutMs).then(
      (payload) => ({ payload }),
      (error: unknown) => ({ error })
    );
    const monthlyResult =
      monthlyUrl && monthlyUrl !== weeklyUrl
        ? await fetchBillingJson(monthlyUrl, token, timeoutMs).then(
            (payload) => ({ payload }),
            (error: unknown) => ({ error })
          )
        : undefined;

    const weeklyPayload = 'payload' in weeklyResult ? weeklyResult.payload : undefined;
    const monthlyPayload =
      monthlyResult && 'payload' in monthlyResult ? monthlyResult.payload : weeklyPayload;

    const weekly = parseWeeklyUsage(weeklyPayload) ?? parseWeeklyUsage(monthlyPayload);
    const monthly = parseMonthlyUsage(monthlyPayload) ?? parseMonthlyUsage(weeklyPayload);
    const prepaid = parsePrepaidRemaining(weeklyPayload) ?? parsePrepaidRemaining(monthlyPayload);
    const onDemand = parseOnDemand(weeklyPayload) ?? parseOnDemand(monthlyPayload);

    const meters: Meter[] = [];
    const hasOnDemandCapacity = Boolean(onDemand && onDemand.used < onDemand.limit);
    const hasPrepaidCapacity = typeof prepaid === 'number' && prepaid > 0;
    const hasMonthlyCapacity = Boolean(
      monthly && monthly.monthlyLimit > 0 && monthly.used < monthly.monthlyLimit
    );
    const includedThreshold =
      hasOnDemandCapacity || hasPrepaidCapacity || hasMonthlyCapacity ? 101 : 100;

    if (weekly) {
      const used = clampPercent(weekly.creditUsagePercent);
      meters.push(
        ctx.allowance({
          key: 'weekly',
          label: 'SuperGrok weekly',
          unit: 'percentage',
          limit: 100,
          used,
          remaining: Math.max(0, 100 - used),
          periodValue: 1,
          periodUnit: 'week',
          periodCycle: 'fixed',
          resetsAt: weekly.billingPeriodEnd,
          exhaustionThreshold: includedThreshold,
        })
      );
    }

    if (monthly && monthly.monthlyLimit > 0) {
      meters.push(
        ctx.allowance({
          key: 'monthly',
          label: 'xAI monthly credits',
          unit: 'credits',
          limit: monthly.monthlyLimit,
          used: monthly.used,
          remaining: Math.max(0, monthly.monthlyLimit - monthly.used),
          periodValue: 1,
          periodUnit: 'month',
          periodCycle: 'fixed',
          resetsAt: monthly.billingPeriodEnd,
          exhaustionThreshold: weekly && weekly.creditUsagePercent < 100 ? 101 : 100,
        })
      );
    }

    if (typeof prepaid === 'number' && prepaid > 0) {
      meters.push(
        ctx.balance({
          key: 'prepaid',
          label: 'Prepaid balance',
          unit: 'credits',
          remaining: prepaid,
        })
      );
    }

    if (onDemand) {
      meters.push(
        ctx.allowance({
          key: 'on_demand',
          label: 'On-demand credits',
          unit: 'credits',
          limit: onDemand.limit,
          used: onDemand.used,
          remaining: Math.max(0, onDemand.limit - onDemand.used),
          periodValue: 1,
          periodUnit: 'month',
          periodCycle: 'fixed',
          exhaustionThreshold: weekly && weekly.creditUsagePercent < 100 ? 101 : 100,
        })
      );
    }

    if (meters.length === 0) {
      const weeklyError = 'error' in weeklyResult ? weeklyResult.error : undefined;
      if (weeklyError instanceof Error) throw weeklyError;
      throw new Error('xAI billing response missing SuperGrok weekly usage');
    }

    return meters;
  },
});
