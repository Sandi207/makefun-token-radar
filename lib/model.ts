/*
 * Signal: a cross-sectional research score, never a launch probability.
 * No identity is special-cased. Cohorts, priors and the dollar anchor are rebuilt
 * from the snapshot. as_of is the model's only clock.
 *
 * T = log(TVL / cohort minimum) / log(cohort maximum / minimum) × 100
 * G = 50 + clamp(change_7d ?? 0, -35, 35) × 50 / 35
 * A = min(years since listing / age cap, 1) × 100; unknown = 50
 * B = min(log(1 + distinct chains) / log(1 + breadth cap), 1) × 100
 * C = (n × (0.65 × T(category median TVL) + 0.35 × G(median growth))
 *      + 5 × 50) / (n + 5)
 * Score = .40T + .20G + .20A + .10B + .10C.
 * Age and breadth caps: the no-token cohort's 90th percentiles.
 * Five neutral pseudo-peers shrink thin category priors toward 50.
 * Dollar anchor = median no-token TVL × median recorded-token mcap/TVL.
 * Implied value = round(anchor × 10 ** ((Score - 50) / 25)).
 * This explicit log-price mapping is our valuation claim, not a fitted forecast.
 * Listed age is tracking history, not evidence of token-free history. Unique
 * chains proxy diversity: the input has no chain allocations, fees or users.
 */

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface CategoryPrior {
  category: string;
  peers: number;
  median_tvl_usd: number;
  median_growth_pct: number;
  unshrunk_score: number;
  score: number;
}

export interface ScoreModel {
  version: string;
  weights: { tvl: number; growth: number; age: number; breadth: number; category: number };
  tvl_min_usd: number;
  tvl_max_usd: number;
  growth_limit_pct: number;
  age_cap_years: number;
  breadth_cap: number;
  prior_strength: number;
  cohort_median_tvl_usd: number;
  launched_median_mcap_tvl: number;
  launched_calibration_count: number;
  value_anchor_usd: number;
  value_score_midpoint: number;
  value_score_decade: number;
}

export interface Component {
  key: keyof ScoreModel['weights'];
  label: string;
  normalized: number;
  weight: number;
  points: number;
  explanation: string;
}

export interface PlanStep { title: string; action: string; cost: string; time: string }
export interface FarmPlan {
  position_usd: number;
  gas_allowance_usd: number;
  bridge_allowance_usd: number;
  weekly_fee_cap_usd: number;
  weeks: number;
  cadence: string;
  primary_chain: string;
  tier: string;
  caveat: string;
  steps: PlanStep[];
}

export interface BoardRow extends Protocol {
  rank: number;
  implied_value_usd: number;
  score: number;
  token_status: 'records no token';
  on_watchlist: boolean;
  below_floor: boolean;
  age_days: number | null;
  category_prior: CategoryPrior;
  score_breakdown: Component[];
  farm_plan: FarmPlan;
  farm_steps: string[];
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  stats: { scanned: number; watchlist: number; covered: number; board: number; pre_token: number; early: number; launched: number };
  model: ScoreModel;
  category_priors: CategoryPrior[];
  rows: BoardRow[];
  launched: (Protocol & { token_status: 'already launched — not farmable' })[];
}

const DAY = 86_400_000;
const BOARD_SIZE = 240;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const money = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const categoryOf = (p: Protocol) => p.category ?? 'Uncategorized';

function demand(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid snapshot: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** Missing fields fail: an undefined token field must not silently become null. */
export function parseSnapshot(text: string): Snapshot {
  let input: unknown;
  try { input = JSON.parse(text); } catch { throw new Error('Invalid snapshot: malformed JSON'); }
  demand(isObject(input), 'expected an object');
  demand(isDay(input.as_of), 'as_of must be a real UTC calendar day');
  demand(typeof input.source === 'string', 'source must be text');
  demand(Number.isSafeInteger(input.floor_usd) && Number(input.floor_usd) > 0, 'floor_usd must be a positive integer');
  demand(Array.isArray(input.protocols) && input.protocols.length > 0, 'protocols must be a nonempty array');
  demand(Array.isArray(input.watchlist), 'watchlist must be an array');
  const slugs = new Set<string>();
  const protocols = input.protocols.map((raw: unknown, i: number): Protocol => {
    demand(isObject(raw), `protocol ${i + 1} must be an object`);
    demand(typeof raw.slug === 'string' && /^[^\s]{1,128}$/.test(raw.slug), `protocol ${i + 1}: invalid slug`);
    demand(!slugs.has(raw.slug), `duplicate slug ${raw.slug}`);
    slugs.add(raw.slug);
    demand(typeof raw.name === 'string' && raw.name.trim().length > 0, `${raw.slug}: missing name`);
    demand(raw.category === null || typeof raw.category === 'string', `${raw.slug}: invalid category`);
    demand(Array.isArray(raw.chains) && raw.chains.every(c => typeof c === 'string' && c.trim().length > 0), `${raw.slug}: invalid chains`);
    demand(Number.isSafeInteger(raw.tvl_usd) && Number(raw.tvl_usd) > 0, `${raw.slug}: invalid TVL`);
    demand(raw.change_7d === null || (typeof raw.change_7d === 'number' && Number.isFinite(raw.change_7d)), `${raw.slug}: invalid growth`);
    // Preserve integer API sentinels (including -1); only positive caps enter
    // calibration and the launched reference. Token status still uses the IDs.
    demand(raw.mcap_usd === null || Number.isSafeInteger(raw.mcap_usd), `${raw.slug}: invalid market cap`);
    demand(raw.listed_at === null || isDay(raw.listed_at), `${raw.slug}: invalid listing date`);
    demand(raw.gecko_id === null || (typeof raw.gecko_id === 'string' && raw.gecko_id.trim().length > 0), `${raw.slug}: invalid token id`);
    demand(raw.symbol === null || (typeof raw.symbol === 'string' && raw.symbol.trim().length > 0), `${raw.slug}: invalid symbol`);
    return {
      slug: raw.slug, name: raw.name, category: raw.category as string | null,
      chains: [...new Set(raw.chains as string[])], tvl_usd: raw.tvl_usd as number,
      change_7d: raw.change_7d as number | null, mcap_usd: raw.mcap_usd as number | null,
      listed_at: raw.listed_at as string | null, gecko_id: raw.gecko_id as string | null, symbol: raw.symbol as string | null,
    };
  }).sort((a: Protocol, b: Protocol) => compareText(a.slug, b.slug));
  const watchlist = input.watchlist as unknown[];
  demand(watchlist.every(s => typeof s === 'string' && slugs.has(s)), 'watchlist has an unknown slug');
  demand(new Set(watchlist).size === watchlist.length, 'watchlist contains duplicates');
  return { as_of: input.as_of, source: input.source, floor_usd: input.floor_usd as number, protocols, watchlist: (watchlist as string[]).slice().sort(compareText) };
}

/** Token status uses the two record fields, independent of market-cap availability. */
export const recordsNoToken = (p: Protocol) => p.gecko_id === null && p.symbol === null;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  return listedAt === null ? null : Math.max(0, Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`)) / DAY));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (sorted.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] * (1 - (at - lo)) + sorted[hi] * (at - lo);
}

function scaleTvl(tvl: number, m: ScoreModel): number {
  if (m.tvl_max_usd === m.tvl_min_usd) return 50;
  return clamp(100 * Math.log(tvl / m.tvl_min_usd) / Math.log(m.tvl_max_usd / m.tvl_min_usd), 0, 100);
}

function scaleGrowth(growth: number | null, m: ScoreModel): number {
  return 50 + clamp(growth ?? 0, -m.growth_limit_pct, m.growth_limit_pct) * 50 / m.growth_limit_pct;
}

export function calibrate(snapshot: Snapshot): { model: ScoreModel; priors: Map<string, CategoryPrior> } {
  const cohort = snapshot.protocols.filter(recordsNoToken);
  demand(cohort.length >= BOARD_SIZE, `only ${cohort.length} records qualify for the ${BOARD_SIZE}-row board`);
  const tvls = cohort.map(p => p.tvl_usd);
  const ages = cohort.map(p => ageDays(snapshot.as_of, p.listed_at)).filter((n): n is number => n !== null).map(n => n / 365.25);
  const ratios = snapshot.protocols.filter(p => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0).map(p => p.mcap_usd! / p.tvl_usd);
  const medianTvl = quantile(tvls, 0.5), ratio = ratios.length ? quantile(ratios, 0.5) : 1;
  const model: ScoreModel = {
    version: 'signal-1', weights: { tvl: 40, growth: 20, age: 20, breadth: 10, category: 10 },
    tvl_min_usd: Math.min(...tvls), tvl_max_usd: Math.max(...tvls), growth_limit_pct: 35,
    age_cap_years: Math.max(1, quantile(ages, 0.9)), breadth_cap: Math.max(2, quantile(cohort.map(p => p.chains.length), 0.9)),
    prior_strength: 5, cohort_median_tvl_usd: medianTvl, launched_median_mcap_tvl: ratio,
    launched_calibration_count: ratios.length, value_anchor_usd: Math.max(1, Math.round(medianTvl * ratio)),
    value_score_midpoint: 50, value_score_decade: 25,
  };
  const grouped = new Map<string, Protocol[]>();
  for (const p of cohort) {
    const key = categoryOf(p);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(p);
  }
  const priors = new Map<string, CategoryPrior>();
  for (const key of [...grouped.keys()].sort(compareText)) {
    const peers = grouped.get(key)!;
    const medianTvl = quantile(peers.map(p => p.tvl_usd), 0.5);
    // Null growth is zero in the category median, as in the individual score.
    const medianGrowth = quantile(peers.map(p => p.change_7d ?? 0), 0.5);
    const raw = 0.65 * scaleTvl(medianTvl, model) + 0.35 * scaleGrowth(medianGrowth, model);
    const score = (peers.length * raw + model.prior_strength * 50) / (peers.length + model.prior_strength);
    priors.set(key, { category: key, peers: peers.length, median_tvl_usd: medianTvl, median_growth_pct: medianGrowth, unshrunk_score: raw, score });
  }
  return { model, priors };
}

export function scoreProtocol(p: Protocol, snapshot: Snapshot, model: ScoreModel, prior: CategoryPrior): { score: number; implied: number; age: number | null; components: Component[] } {
  const age = ageDays(snapshot.as_of, p.listed_at), years = age === null ? null : age / 365.25;
  const component = (key: Component['key'], label: string, normalized: number, explanation: string): Component => ({ key, label, normalized, weight: model.weights[key], points: normalized * model.weights[key] / 100, explanation });
  const components: Component[] = [
    component('tvl', 'Capital scale', scaleTvl(p.tvl_usd, model), `Log-scaled ${money(p.tvl_usd)} across the no-token record cohort; large pools face diminishing returns.`),
    component('growth', '7-day momentum', scaleGrowth(p.change_7d, model), p.change_7d === null ? 'Unreported growth uses 0%, the neutral midpoint.' : `${p.change_7d.toFixed(2)}% observed; clipped to ±${model.growth_limit_pct}% so a spike cannot dominate.`),
    component('age', 'Launch runway', years === null ? 50 : clamp(years / model.age_cap_years, 0, 1) * 100, years === null ? 'Listing date unreported: neutral 50/100, without invented tenure.' : `${years.toFixed(2)} years tracked; capped at ${model.age_cap_years.toFixed(2)} years. Tracking age proxies pent-up launch value.`),
    component('breadth', 'Chain breadth', clamp(Math.log(1 + p.chains.length) / Math.log(1 + model.breadth_cap), 0, 1) * 100, `${p.chains.length} distinct recorded chains; log-scaled and capped at ${model.breadth_cap.toFixed(1)}. No chain-level allocations are assumed.`),
    component('category', 'Category prior', prior.score, `${prior.peers} no-token peers: median TVL ${money(prior.median_tvl_usd)}, growth ${prior.median_growth_pct.toFixed(2)}%; five neutral peers temper this prior.`),
  ];
  const score = components.reduce((sum, c) => sum + c.points, 0);
  const implied = Math.max(1, Math.round(model.value_anchor_usd * 10 ** ((score - model.value_score_midpoint) / model.value_score_decade)));
  return { score, implied, age, components };
}

/** Budgets are planning assumptions, not fees or eligibility supplied by the input. */
export function farmPlan(p: Protocol, snapshot: Snapshot, model: ScoreModel, age: number | null): FarmPlan {
  const chain = p.chains[0] ?? 'the network verified in its documentation';
  const years = age === null ? null : age / 365.25;
  const tier = p.tvl_usd >= snapshot.floor_usd * 10 ? 'Deep liquidity' : p.tvl_usd >= snapshot.floor_usd ? 'Established' : p.tvl_usd >= snapshot.floor_usd / 2 ? 'Developing' : 'Scout';
  const stressed = (p.change_7d ?? 0) < -10;
  const capital = Math.round(clamp(40 + 65 * Math.log10(p.tvl_usd / model.tvl_min_usd), 40, 300) * (stressed ? 0.75 : 1) / 5) * 5;
  const gas = capital >= 150 ? 25 : capital >= 80 ? 18 : 12;
  const bridge = Math.min(25, Math.round(capital * 0.12)), weekly = Math.max(3, Math.round(capital * 0.025));
  const weeks = years === null ? 8 : years < 1 ? 8 : years < 2 ? 10 : 12;
  const cadence = years !== null && years >= 2 ? '1–2 sessions per week' : '2–3 sessions per week';
  const category = categoryOf(p), kind = category.toLowerCase();
  const product = /bridge|liquid staking|liquid restaking|restaked btc|stablecoin wrapper|anchor btc/.test(kind);
  const custody = kind === 'cex' || /cedefi|rwa|capital allocator/.test(kind);
  const caveat = product ? 'Product record: a receipt or bridge asset may belong to an existing token. Verify independent launch eligibility before funding.' : custody ? 'Access check: custody, allowlists or minimum deposits may prevent this plan. Skip when access or withdrawal terms cannot be verified.' : 'The snapshot records no token. It supplies no campaign, points rules or confirmed launch; participation may earn nothing.';
  const small = Math.max(10, Math.round(capital * 0.15 / 5) * 5);
  let enter: PlanStep, maintain: PlanStep, exitAction: string;
  const cost = `${money(capital)} working capital; live fees within the ${money(gas)} reserve`;
  const followCost = `cap transaction fees at ${money(weekly)} per week; no extra capital`;

  if (kind === 'dexs' || /liquidity manager/.test(kind)) {
    enter = { title: 'Swap & provide liquidity', action: `On ${chain}, inspect ${p.name}'s most liquid pair. Swap ${money(Math.round(capital * 0.4))} with a 0.5% slippage limit; if balanced liquidity is offered, use the remaining budget plus the purchased asset in one position. Record fees and the entry ratio.`, cost, time: '20–30 minutes' };
    maintain = { title: 'Manage a real position', action: `Review the ${chain} position ${cadence} for ${weeks} weeks. Make a small swap only when rebalancing is needed; check pool depth and impermanent loss. Pause if price impact exceeds 0.5%; do not manufacture turnover.`, cost: followCost, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Remove ${Math.min(20, capital)} dollars of liquidity from ${p.name} first, inspect received assets, then unwind the remainder when needed. Compare fees earned against swap costs and impermanent loss.`;
  } else if (kind === 'lending' || kind === 'cdp' || kind === 'collateral markets' || kind === 'cdp manager') {
    enter = { title: 'Supply, then test borrowing', action: `Supply ${money(capital)} of an accepted liquid collateral in ${p.name} on ${chain}. If collateralized borrowing is enabled, borrow at most ${money(small)}, keeping collateral at least 3× debt and health factor above 2 where shown. Repay part of this test borrow.`, cost: `${cost}; interest on at most ${money(small)} debt`, time: '25 minutes' };
    maintain = { title: 'Keep collateral healthy', action: `Check ${p.name}'s borrow rate, utilization and liquidation buffer ${cadence} for ${weeks} weeks. Keep debt below 20% of supplied value; repay rather than add leverage if collateral falls. Leave a useful supply position instead of looping deposits.`, cost: `${followCost}; variable borrow interest`, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Repay all debt and accrued interest in ${p.name} on ${chain}; verify the debt balance is zero before withdrawing collateral. Test a ${money(Math.min(20, capital))} withdrawal, then revoke unused spending permissions.`;
  } else if (/derivatives|basis trading|options vault/.test(kind)) {
    enter = { title: 'Test execution at 1×', action: `Deposit ${money(capital)} on ${chain} only if ${p.name} offers a public market. Open one ${money(Math.round(capital * 0.25))} notional position at no more than 1× leverage, set a loss limit, then close with reduce-only where supported. Read funding and settlement terms first.`, cost: `${cost}; trading fees and funding are additional, quote first`, time: '25–35 minutes' };
    maintain = { title: 'Track fees, not turnover', action: `For ${weeks} weeks, review ${p.name}'s spreads and funding ${cadence}. Use at most one small trade per session only with a research reason; close before funding exceeds your budget. Keep realized loss below ${money(Math.max(5, Math.round(capital * 0.05)))} in total.`, cost: `${followCost}; stop at the stated loss limit`, time: `15 minutes per session, ${weeks} weeks` };
    exitAction = `Close every ${p.name} position, cancel open orders and inspect unsettled funding. Withdraw a ${money(Math.min(20, capital))} test amount on ${chain}, then the remainder; keep execution and settlement receipts.`;
  } else if (/restaking|staking pool|liquid staking/.test(kind)) {
    enter = { title: 'Stake without stacking risk', action: `Read ${p.name}'s slashing, operator and unbonding terms for ${chain}. If a public position is available, stake ${money(capital)} in one supported asset. Record the receipt and exit queue; do not recursively borrow against or restake that receipt.`, cost, time: '25 minutes; lock duration must be checked live' };
    maintain = { title: 'Monitor operator & exit queue', action: `Check ${p.name}'s operator status, exchange rate and unbonding queue ${cadence} for ${weeks} weeks. Use an official rewards view only if published. Keep the same position; changing operators is useful only when actual performance or risk justifies it.`, cost: followCost, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Request the smallest permitted unbond from ${p.name} on ${chain}. Record its release date and any redemption haircut before adding funds; the snapshot does not report withdrawal delay or slashing risk.`;
  } else if (/risk curators|yield|farm|allocator|indexes/.test(kind)) {
    enter = { title: 'Enter a transparent vault', action: `Inspect one public ${p.name} vault on ${chain}: underlying assets, manager permissions, caps and withdrawal queue. Deposit ${money(capital)} only if its minimum fits this budget. Record the receipt and whether activity accrues to this manager or an underlying protocol.`, cost, time: '25–30 minutes' };
    maintain = { title: 'Review allocation & receipts', action: `Review ${p.name}'s allocation and receipt value ${cadence} for ${weeks} weeks. Keep a stable position; top up only for a documented portfolio need. If a points page exists, confirm whose campaign it is. Do not treat vault yield as launch eligibility.`, cost: `${followCost}; management or performance fees may apply`, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Request a ${money(Math.min(20, capital))} redemption from the ${chain} vault, observe settlement and fees, then size the remainder. Log receipt balances and queue times; stop if the manager changes risk terms without a clear explanation.`;
  } else if (product || /bridge|decentralized btc/.test(kind)) {
    enter = { title: 'Verify route & redemption', action: `For ${p.name}, verify a supported ${chain} route and the asset's issuer. Only after independent campaign eligibility is documented, transfer ${money(Math.min(25, capital))}, track finality, and test redemption. Keep the remaining ${money(capital)} budget uncommitted until the round trip works.`, cost: `at most ${money(Math.min(25, capital))} initially; bridge fee cap ${money(bridge)}`, time: '20 minutes plus live finality delay' };
    maintain = { title: 'Use transfers with a purpose', action: `For ${weeks} weeks, check ${p.name}'s redemption status ${cadence}; make a transfer only for a real portfolio need. Maintain route and receipt records on ${chain}. A bridged or wrapped asset does not establish a separate forthcoming token.`, cost: followCost, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Redeem the ${p.name} test asset through the verified route, check the destination receipt and deduct bridge fees. Do not expand the position if issuer identity, backing or independent eligibility remains unclear.`;
  } else if (kind === 'cex' || /rwa|cedefi|uncollateralized lending|otc marketplace/.test(kind)) {
    enter = { title: 'Check access before depositing', action: `Check ${p.name}'s custody, jurisdiction, allowlist and minimum deposit terms for assets recorded on ${chain}. If a public eligible program exists and the minimum is at most ${money(capital)}, start with ${money(Math.min(20, capital))} and test withdrawal before allocating the rest. Otherwise skip.`, cost: `up to ${money(capital)}; quoted access and withdrawal fees only`, time: '30 minutes; allowlist approval can take longer' };
    maintain = { title: 'Track counterparty exposure', action: `For ${weeks} weeks, review ${p.name}'s access terms, reserves or asset reports ${cadence}. Keep statements and actual campaign terms if offered. Stop at any unexplained withdrawal delay; custody and credit exposure outweigh an unconfirmed launch thesis.`, cost: followCost, time: `15 minutes per session, ${weeks} weeks` };
    exitAction = `Request a ${money(Math.min(20, capital))} withdrawal from ${p.name} to your verified ${chain} destination. Confirm settlement before keeping a balance; write down issuer, custody and credit risks that remain after exit.`;
  } else if (/payments|card issuer|privacy/.test(kind)) {
    enter = { title: 'Make one useful transaction', action: `Verify ${p.name}'s supported ${chain} asset and recipient or merchant requirements. Make one legitimate ${money(Math.min(15, capital))} payment within the ${money(capital)} budget; confirm the receipt. Do not send funds to an unverified contact or buy activity for its own sake.`, cost: `payment value plus quoted fees within ${money(gas)}`, time: '15–20 minutes' };
    maintain = { title: 'Build an organic use record', action: `Over ${weeks} weeks, check ${p.name} ${cadence}, but pay only for an actual need. Record fees, successful receipts and any published user program. No artificial self-payment loop; the snapshot reports neither eligibility nor reward terms.`, cost: followCost, time: `10 minutes per check, ${weeks} weeks` };
    exitAction = `Reconcile ${p.name} receipts on ${chain}, recover any unused prepaid balance if supported, and remove recurring permissions. Keep payment dates and amounts without storing wallet secrets.`;
  } else if (/insurance|prediction market|governance incentives/.test(kind)) {
    enter = { title: 'Use the product with a loss cap', action: `Read ${p.name}'s ${category} rules on ${chain}: settlement, exclusions and access requirements. If public use is possible without buying a supposed future token, allocate at most ${money(Math.min(15, capital))} to one justified action. Keep the remaining research budget liquid.`, cost: `up to ${money(Math.min(15, capital))} can be lost; fees within ${money(gas)}`, time: '25 minutes plus the published settlement period' };
    maintain = { title: 'Follow settlement & rules', action: `Review ${p.name}'s settlement or participation rules ${cadence} for ${weeks} weeks. Keep evidence of one useful action; do not purchase voting power or additional exposure merely for an unannounced reward. Verify all deadlines in the current product.`, cost: followCost, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Settle or redeem the ${p.name} action through its verified ${chain} interface when the published rules allow. Record any irrecoverable premium or loss; never pay an external party to unlock a supposed reward.`;
  } else {
    enter = { title: 'Test the documented core action', action: `Read ${p.name}'s ${category} documentation and verify ${chain} deployment addresses. Use its smallest public deposit or core action, starting at ${money(Math.min(20, capital))} and staying within ${money(capital)}. Confirm a receipt and a working exit before expanding; skip inaccessible features.`, cost, time: '25 minutes' };
    maintain = { title: 'Keep a useful activity log', action: `Use the documented ${p.name} core action on ${chain} only when useful, reviewing it ${cadence} for ${weeks} weeks. Log each receipt and balance; inspect any published eligibility rules. No reward or launch is established by the ${category} label.`, cost: followCost, time: `10 minutes per session, ${weeks} weeks` };
    exitAction = `Test the smallest permitted exit from ${p.name} on ${chain}, then reconcile the original deposit, fees and returned assets. Do not keep funds in a feature with an unverifiable withdrawal path.`;
  }

  const ageText = age === null ? 'listing date is unreported' : `tracked for ${age} days`;
  const steps: PlanStep[] = [
    { title: 'Verify the record', action: `${p.name} records no token in this snapshot; ${ageText}. Find its official documentation, cross-check the ${category} deployment on ${chain} and verify contracts plus current eligibility. ${product ? 'Confirm whether this product has an independent launch thesis.' : 'Use an established personal wallet; keep seed material offline.'}`, cost: '$0 research', time: '15–20 minutes' },
    { title: 'Fund a capped pilot', action: `Set aside ${money(capital)} for ${p.name} on ${chain}, plus ${money(gas)} in native gas. If bridging is necessary, use a documented route, test ${money(Math.min(10, capital))} first and stop if the live bridge quote exceeds ${money(bridge)}. ${stressed ? 'TVL fell over 10% this week, so the pilot budget is reduced 25%.' : `This is the ${tier.toLowerCase()} TVL tier; increase size only after testing an exit.`}`, cost: `${money(capital)} capital + up to ${money(gas + bridge)} gas/bridge reserves`, time: '15 minutes plus the route confirmation time' },
    enter, maintain,
  ];
  if (p.chains.length > 1) {
    const second = p.chains[1];
    steps.push({ title: 'Optional second-chain check', action: `${p.name} also records ${second}. Confirm the same feature and campaign actually operate there; if so, move at most ${money(Math.round(capital * 0.2))} from the existing budget after a successful withdrawal on ${chain}. Reuse your wallet where compatible; extra chains do not prove extra eligibility.`, cost: `no extra capital; only proceed within ${money(bridge)} transfer allowance`, time: '20 minutes once; optional' });
  }
  steps.push(
    { title: 'Prove the exit', action: exitAction, cost: `live redemption fees within the remaining ${money(gas)} reserve`, time: '15 minutes plus any documented queue' },
    { title: 'Reassess the launch thesis', action: `At week ${weeks}, total ${p.name}'s fees, time and capital at risk. Keep transaction hashes and check only officially published campaign terms. If no eligibility is documented, value rewards at $0 and decide whether the product itself merits continued use. The snapshot confirms no launch date or token allocation.`, cost: '$0 review; never pay a third party to unlock a claim', time: `20 minutes after ${weeks} weeks` },
  );
  return { position_usd: capital, gas_allowance_usd: gas, bridge_allowance_usd: bridge, weekly_fee_cap_usd: weekly, weeks, cadence, primary_chain: chain, tier, caveat, steps };
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { model, priors } = calibrate(snapshot), watch = new Set(snapshot.watchlist);
  for (const p of snapshot.protocols) demand(!watch.has(p.slug) || recordsNoToken(p), `watchlist record ${p.slug} carries a token`);
  demand(watch.size <= BOARD_SIZE, 'watchlist exceeds board capacity');
  const scored = snapshot.protocols.filter(recordsNoToken).map(p => ({ p, prior: priors.get(categoryOf(p))!, value: scoreProtocol(p, snapshot, model, priors.get(categoryOf(p))!) }));
  const order = (a: typeof scored[number], b: typeof scored[number]) => b.value.implied - a.value.implied || compareText(a.p.slug, b.p.slug);
  // Coverage is compulsory; remaining slots prefer below-floor records by value.
  // A future smaller early pool falls back to other no-token records. Neither
  // names nor versions define eligibility: this snapshot has no parent field.
  const selected = scored.filter(s => watch.has(s.p.slug));
  const extras = scored.filter(s => !watch.has(s.p.slug)).sort((a, b) => Number(b.p.tvl_usd < snapshot.floor_usd) - Number(a.p.tvl_usd < snapshot.floor_usd) || order(a, b));
  selected.push(...extras.slice(0, BOARD_SIZE - selected.length));
  selected.sort(order);
  const board: BoardRow[] = selected.map((s, index) => {
    const plan = farmPlan(s.p, snapshot, model, s.value.age);
    return { ...s.p, chains: s.p.chains.slice(), rank: index + 1, implied_value_usd: s.value.implied, score: s.value.score,
      token_status: 'records no token', on_watchlist: watch.has(s.p.slug), below_floor: s.p.tvl_usd < snapshot.floor_usd,
      age_days: s.value.age, category_prior: s.prior, score_breakdown: s.value.components, farm_plan: plan,
      farm_steps: plan.steps.map(s => `${s.action} Cost: ${s.cost}. Time: ${s.time}.`),
    };
  });
  const launched = snapshot.protocols.filter(p => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || compareText(a.slug, b.slug)).slice(0, 12)
    .map(p => ({ ...p, token_status: 'already launched — not farmable' as const }));
  return { board, radar: { as_of: snapshot.as_of, floor_usd: snapshot.floor_usd,
    stats: { scanned: snapshot.protocols.length, watchlist: watch.size, covered: board.filter(r => r.on_watchlist).length, board: board.length, pre_token: scored.length, early: board.filter(r => r.below_floor && !r.on_watchlist).length, launched: snapshot.protocols.filter(p => !recordsNoToken(p)).length },
    model, category_priors: [...priors.values()], rows: board, launched } };
}

/** Validate all board gate constraints before main writes any board output. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (!Array.isArray(board) || board.length < 100 || board.length > 4000) return 'board must contain 100–4000 rows';
  if (board.length !== BOARD_SIZE) return `expected ${BOARD_SIZE} rows, received ${board.length}`;
  if (Buffer.byteLength(JSON.stringify({ rows: board }) + '\n') > 8 * 1024 * 1024) return 'board.json exceeds 8 MiB';
  const known = new Map(snapshot.protocols.map(p => [p.slug, p]));
  const slugs = new Set<string>(), ranks = new Set<number>(), values = new Set<number>();
  for (const row of board) {
    if (typeof row.slug !== 'string' || !/^[^\s]{1,128}$/.test(row.slug) || !known.has(row.slug)) return `unknown or malformed slug: ${row.slug}`;
    if (slugs.has(row.slug)) return `duplicate slug: ${row.slug}`;
    slugs.add(row.slug);
    if (typeof row.name !== 'string' || !row.name.trim()) return `${row.slug}: name must be nonempty`;
    if (!recordsNoToken(known.get(row.slug)!) || !recordsNoToken(row)) return `${row.slug}: token-bearing records cannot be ranked`;
    if (!Number.isSafeInteger(row.rank) || row.rank < 1 || row.rank > board.length || ranks.has(row.rank)) return `${row.slug}: invalid or repeated rank ${row.rank}`;
    ranks.add(row.rank);
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd < 1 || row.implied_value_usd > 100_000_000_000_000) return `${row.slug}: implied value outside the gate range`;
    values.add(row.implied_value_usd);
    if (!Array.isArray(row.farm_steps) || row.farm_steps.length < 3 || row.farm_steps.length > 12) return `${row.slug}: farm_steps must contain 3–12 strings`;
    if (row.farm_steps.some(s => typeof s !== 'string' || s.trim().length < 20 || s.trim().length > 600)) return `${row.slug}: farm step outside 20–600 characters`;
  }
  const sorted = board.slice().sort((a, b) => a.rank - b.rank);
  if (sorted.some((row, index) => row.rank !== index + 1)) return 'ranks must be exactly 1..N';
  if (sorted.some((row, index) => index > 0 && row.implied_value_usd > sorted[index - 1].implied_value_usd)) return 'implied value rises with rank';
  if (values.size < 2) return 'all implied values are equal';
  const missing = snapshot.watchlist.filter(slug => !slugs.has(slug));
  return missing.length ? `missing watchlist records: ${missing.join(', ')}` : null;
}

/** Classic script beside dashboard/: file:// works without fetch or imports. */
export function dataScript(radar: RadarData): string {
  const safe = JSON.stringify(radar).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `window.RADAR = ${safe};\n`;
}
