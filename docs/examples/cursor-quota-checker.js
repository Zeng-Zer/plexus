const exchangeEndpoint = ctx.getOption(
  'exchangeEndpoint',
  'https://api2.cursor.sh/auth/exchange_user_api_key',
);
const endpoint = ctx.getOption(
  'endpoint',
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
);

const exchangeResponse = await ctx.fetch(exchangeEndpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
const exchangeBody = await exchangeResponse.text();
if (!exchangeResponse.ok) {
  throw new Error(`Cursor exchange failed with status ${exchangeResponse.status}: ${exchangeBody}`);
}
let exchange;
try {
  exchange = JSON.parse(exchangeBody);
} catch {
  throw new Error('failed to parse Cursor exchange response');
}
const accessToken = typeof exchange.accessToken === 'string' ? exchange.accessToken.trim() : '';
if (!accessToken) throw new Error('Cursor exchange response missing accessToken');

const usageResponse = await ctx.fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
  },
  body: '{}',
});
const usageBody = await usageResponse.text();
if (!usageResponse.ok) {
  throw new Error(`Cursor usage request failed with status ${usageResponse.status}: ${usageBody}`);
}
let usage;
try {
  usage = JSON.parse(usageBody);
} catch {
  throw new Error('failed to parse Cursor quota response');
}
if (!usage.planUsage) throw new Error('cursor usage response missing planUsage');

const cents = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value / 100 : undefined;
const resetTime = (value) => {
  if (!value) return undefined;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
};

const resetsAt = resetTime(usage.billingCycleEnd);
const spend = usage.spendLimitUsage;
const pooled = spend?.limitType === 'team';
const onDemandLimit = pooled ? spend?.pooledLimit : spend?.individualLimit;
const onDemandUsed = pooled ? spend?.pooledUsed : spend?.individualUsed;
const onDemandRemaining = pooled ? spend?.pooledRemaining : spend?.individualRemaining;
const hasOnDemandMeter =
  typeof onDemandLimit === 'number' && Number.isFinite(onDemandLimit) && onDemandLimit > 0;
const autoPercentUsed = usage.planUsage.autoPercentUsed;
const apiPercentUsed = usage.planUsage.apiPercentUsed;
const hasSplitUsage =
  typeof autoPercentUsed === 'number' &&
  Number.isFinite(autoPercentUsed) &&
  typeof apiPercentUsed === 'number' &&
  Number.isFinite(apiPercentUsed);
const hasSplitCapacity = hasSplitUsage && (autoPercentUsed < 100 || apiPercentUsed < 100);
const hasIncludedCapacity =
  hasSplitCapacity ||
  (!hasSplitUsage &&
    typeof usage.planUsage.remaining === 'number' &&
    usage.planUsage.remaining > 0) ||
  usage.planUsage.remainingBonus === true;
const hasOnDemandCapacity =
  hasOnDemandMeter &&
  typeof onDemandRemaining === 'number' &&
  Number.isFinite(onDemandRemaining) &&
  onDemandRemaining > 0;
const includedThreshold =
  hasOnDemandCapacity || hasSplitCapacity || usage.planUsage.remainingBonus === true ? 101 : 100;

const includedMeter = (key, label, used) =>
  ctx.allowance({
    key,
    label,
    unit: 'percentage',
    limit: 100,
    used: Math.max(0, used),
    remaining: Math.max(0, 100 - used),
    periodValue: 1,
    periodUnit: 'month',
    periodCycle: 'fixed',
    resetsAt,
    exhaustionThreshold: includedThreshold,
  });

const meters = hasSplitUsage
  ? [
      includedMeter('cursor_models', 'Cursor Models', autoPercentUsed),
      includedMeter('other_models', 'Other Models', apiPercentUsed),
    ]
  : [
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
        exhaustionThreshold: includedThreshold,
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
