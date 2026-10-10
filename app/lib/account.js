// Who pays for a Claude turn, from Claude Code's sign-in. The cost Claude Code reports
// is what the turn would cost at API prices; on a Claude plan it isn't charged per message.

const PLANS = { claude_max: 'Claude Max', claude_pro: 'Claude Pro', claude_team: 'Claude Team', claude_enterprise: 'Claude Enterprise' };

export function payer({ apiKeySource, account }) {
  if (apiKeySource && apiKeySource !== 'none')
    return { label: 'your Anthropic API key', billed: true, note: 'charged to the Anthropic Console account that owns the key' };
  const plan = PLANS[account?.organizationType] ?? 'your Claude plan';
  const tier = /_(\d+x)$/.exec(account?.organizationRateLimitTier ?? '')?.[1];
  const label = tier ? `${plan} ${tier}` : plan;
  return {
    label,
    billed: false,
    note: account?.hasExtraUsageEnabled
      ? `counts toward your ${label} limits; extra usage past them is billed`
      : `counts toward your ${label} limits, not billed per message`,
  };
}

const k = (n) => (n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

// "≈$0.19 for claude-opus-5-5: 12.3k in · 420 out · 1 tool · Claude Max 20x, ..."
export function costLine({ costUsd, model, usage, tools }, who) {
  const tokensIn = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  const parts = [`${k(tokensIn)} in`, `${k(usage?.output ?? 0)} out`];
  if (tools) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`);
  return `${who.billed ? '' : '≈'}$${costUsd.toFixed(4)} for ${model ?? 'Claude'}: ${parts.join(' · ')} · ${who.note}`;
}
