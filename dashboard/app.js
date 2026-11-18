/* Token Radar: the bundled board is the only data source. No requests, imports,
 * external fonts or protocol identity rules. DOM text is escaped by construction.
 * calculateRow independently reproduces lib/model.ts so the detail view audits
 * the ranked value, rather than merely drawing an unexplained number.
 */
(() => {
'use strict';
const data = window.RADAR;
const $ = id => document.getElementById(id);
if (!data || !Array.isArray(data.rows) || !data.rows.length) {
  $('load-error').textContent = 'The local dataset could not be loaded. Generate the dashboard and data.js together with the radar program.';
  $('board').setAttribute('aria-busy', 'false');
  return;
}
const model = data.model;
const state = { q: '', category: '', chain: '', watch: false, min: 0, early: false, sort: 'implied_value_usd', dir: -1, selected: null };
const progress = new Map();
const rowsBySlug = new Map(data.rows.map(row => [row.slug, row]));
const keys = ['tvl', 'growth', 'age', 'breadth', 'category'];
const fullDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const countFormat = new Intl.NumberFormat('en-US');
const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
const categoryOf = row => row.category || 'Uncategorized';
const lexical = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function make(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined) element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return element;
}

function usd(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return fullDollars.format(value);
}

function pct(value) { return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`; }
function age(days) { return days === null ? '—' : days >= 365 ? `${(days / 365.25).toFixed(1)}y` : `${days}d`; }
function trend(value) { return value === null ? 'unknown' : value < 0 ? 'negative' : 'positive'; }
function initials(row) {
  const words = row.name.trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : row.name.slice(0, 2)).toUpperCase();
}
function avatar(row) { return make('span', { class: 'avatar', 'data-tone': row.rank % 4, 'aria-hidden': 'true', text: initials(row) }); }

/* Cohort: ALL records with both token fields null. Subscores are 0..100;
 * age/breadth caps are cohort 90th percentiles. Category medians get five
 * neutral pseudo-peers. The 25-point log-price mapping is our explicit claim,
 * not a fitted forecast. Null growth is zero; null age is neutral 50.
 */
function calculateRow(row) {
  const tvlScore = value => model.tvl_min_usd === model.tvl_max_usd ? 50 : clamp(100 * Math.log(value / model.tvl_min_usd) / Math.log(model.tvl_max_usd / model.tvl_min_usd), 0, 100);
  const growthScore = value => 50 + clamp(value ?? 0, -model.growth_limit_pct, model.growth_limit_pct) * 50 / model.growth_limit_pct;
  const days = row.listed_at === null ? null : Math.max(0, Math.floor((Date.parse(`${data.as_of}T00:00:00Z`) - Date.parse(`${row.listed_at}T00:00:00Z`)) / 86400000));
  const prior = row.category_prior;
  const rawPrior = 0.65 * tvlScore(prior.median_tvl_usd) + 0.35 * growthScore(prior.median_growth_pct);
  const normalized = {
    tvl: tvlScore(row.tvl_usd),
    growth: growthScore(row.change_7d),
    age: days === null ? 50 : clamp(days / 365.25 / model.age_cap_years, 0, 1) * 100,
    breadth: clamp(Math.log(1 + new Set(row.chains).size) / Math.log(1 + model.breadth_cap), 0, 1) * 100,
    category: (prior.peers * rawPrior + model.prior_strength * 50) / (prior.peers + model.prior_strength),
  };
  const score = keys.reduce((sum, key) => sum + normalized[key] * model.weights[key] / 100, 0);
  const value = Math.max(1, Math.round(model.value_anchor_usd * 10 ** ((score - model.value_score_midpoint) / model.value_score_decade)));
  const planMatches = row.farm_steps.every((text, index) => {
    const step = row.farm_plan.steps[index];
    return step && text === `${step.action} Cost: ${step.cost}. Time: ${step.time}.`;
  });
  return { normalized, score, value, matches: value === row.implied_value_usd && Math.abs(score - row.score) < 1e-8 && planMatches };
}

function modelNotes() {
  const notes = $('model-notes');
  notes.replaceChildren(
    make('p', { text: `Subscores span 0–100. TVL uses the cohort's log range (${usd(model.tvl_min_usd)}–${usd(model.tvl_max_usd)}). Growth is clipped to ±${model.growth_limit_pct}% with null = 0%. Listing age and unique-chain breadth cap at the 90th percentiles: ${model.age_cap_years.toFixed(2)} years / ${model.breadth_cap.toFixed(1)} chains. Unknown age = neutral 50.` }),
    make('p', { text: `Category prior = (n × (65% median log-TVL score + 35% median growth score) + ${model.prior_strength} × 50) / (n + ${model.prior_strength}). All ${data.stats.pre_token} records with both token fields null supply the cohort; thin categories shrink toward neutral.` }),
    make('p', { class: 'formula', text: 'Score = 0.40 × log TVL + 0.20 × growth + 0.20 × listing age + 0.10 × chain breadth + 0.10 × category prior' }),
    make('p', { class: 'formula', text: `Implied USD = round(${fullDollars.format(model.value_anchor_usd)} × 10 ^ ((score − ${model.value_score_midpoint}) / ${model.value_score_decade}))` }),
    make('p', { text: `Anchor = ${usd(model.cohort_median_tvl_usd)} median no-token-record TVL × ${model.launched_median_mcap_tvl.toFixed(4)} median recorded-token mcap/TVL (${model.launched_calibration_count} positive caps; ratio defaults to 1 if absent). A 25-point score difference means 10× implied USD, not 10× expected rewards.` }),
    make('p', { text: `Selection: every watchlist slug, then highest-value records below ${usd(data.floor_usd)} until ${data.stats.board} rows. Product and custody records need eligibility checks; parent-protocol and campaign fields are absent. Tracking age cannot prove a historical absence of tokens.` })
  );
  $('method-summary').textContent = `40% log TVL + 20% clipped growth + 20% listing age + 10% chain breadth + 10% category prior. Dollar values use a ${usd(model.value_anchor_usd)} snapshot-derived anchor.`;
}

function initializeFacts() {
  const stats = data.stats;
  $('snapshot-date').textContent = data.as_of;
  $('snapshot-date').setAttribute('datetime', data.as_of);
  $('stat-scanned').textContent = countFormat.format(stats.scanned);
  $('stat-watchlist').replaceChildren(document.createTextNode(String(stats.covered)), make('small', { text: ` / ${stats.watchlist}` }));
  $('stat-floor').textContent = `${usd(data.floor_usd)} floor · complete coverage`;
  $('stat-board').textContent = countFormat.format(stats.board);
  $('stat-early').textContent = `${stats.early} discoveries below the floor`;
  $('stat-pretoken').textContent = countFormat.format(stats.pre_token);
  $('nav-count').textContent = stats.board;
  $('side-early').textContent = stats.early;
  $('side-coverage').textContent = `${stats.covered} / ${stats.watchlist}`;
  $('coverage-fill').style.width = `${stats.watchlist ? stats.covered / stats.watchlist * 100 : 100}%`;
  for (const category of [...new Set(data.rows.map(categoryOf))].sort(lexical)) $('category').append(make('option', { value: category, text: category }));
  for (const chain of [...new Set(data.rows.flatMap(row => row.chains))].sort(lexical)) $('chain').append(make('option', { value: chain, text: chain }));
  modelNotes();
  $('launched-count').textContent = data.launched.length;
  $('launched-grid').replaceChildren(...data.launched.map(row => make('article', { class: 'launched-card', title: `${row.name} · ${categoryOf(row)} · ${row.chains.join(', ')} · recorded mcap ${fullDollars.format(row.mcap_usd)}` },
    make('div', {}, make('span', { class: 'launched-name', text: row.name }), make('span', { class: 'launched-symbol', text: row.symbol || 'recorded token' })),
    make('strong', { text: usd(row.mcap_usd) }), make('small', { text: 'LAUNCHED · NOT FARMABLE' })
  )));
}

function filteredRows() {
  const query = state.q.trim().toLowerCase();
  const visible = data.rows.filter(row => {
    if (state.watch && !row.on_watchlist) return false;
    if (state.early && !row.below_floor) return false;
    if (state.category && categoryOf(row) !== state.category) return false;
    if (state.chain && !row.chains.includes(state.chain)) return false;
    if (row.tvl_usd < state.min * 1e6) return false;
    return !query || [row.name, row.slug, categoryOf(row), ...row.chains].join(' ').toLowerCase().includes(query);
  });
  const get = row => state.sort === 'category' ? categoryOf(row).toLowerCase() : state.sort === 'chains' ? row.chains.join(', ').toLowerCase() : state.sort === 'name' ? row.name.toLowerCase() : row[state.sort];
  return visible.sort((a, b) => {
    const av = get(a), bv = get(b);
    // Missing observations always sort last in either direction.
    if (av === null || av === undefined) return bv === null || bv === undefined ? a.rank - b.rank : 1;
    if (bv === null || bv === undefined) return -1;
    return (typeof av === 'string' ? lexical(av, bv) : av - bv) * state.dir || a.rank - b.rank;
  });
}

function tableRow(row) {
  const chainText = row.chains[0] || 'Unreported';
  return make('tr', { 'data-slug': row.slug, tabindex: '0', class: state.selected === row.slug ? 'selected' : '', 'aria-label': `${row.name}, rank ${row.rank}, implied value ${fullDollars.format(row.implied_value_usd)}. Open research details.` },
    make('td', { class: `rank ${row.rank <= 3 ? 'top-rank' : ''}`, text: String(row.rank).padStart(2, '0') }),
    make('td', {}, make('div', { class: 'protocol-cell' }, avatar(row), make('div', { class: 'protocol-info' },
      make('div', { class: 'protocol-name', title: row.name, text: row.name }),
      make('div', { class: `protocol-status ${row.on_watchlist ? 'watch' : ''}` }, make('i', { class: `dot ${row.on_watchlist ? 'amber-dot' : ''}` }), row.on_watchlist ? 'Watchlist · records no token' : 'Early · records no token')
    ))),
    make('td', { class: 'category-cell', title: categoryOf(row), text: categoryOf(row) }),
    make('td', { title: row.chains.join(', ') || 'No chains reported' }, make('div', { class: 'chain-cell' }, make('span', { class: 'chain-name', text: chainText }), row.chains.length > 1 ? make('span', { class: 'chain-extra', text: `+${row.chains.length - 1}` }) : null)),
    make('td', { class: 'numeric number-cell', title: fullDollars.format(row.tvl_usd), text: usd(row.tvl_usd) }),
    make('td', { class: `numeric number-cell ${trend(row.change_7d)}`, title: row.change_7d === null ? 'Unreported; model uses 0%' : `Observed TVL change: ${row.change_7d}%`, text: pct(row.change_7d) }),
    make('td', { class: `numeric number-cell ${row.age_days === null ? 'unknown' : ''}`, title: row.listed_at === null ? 'Listing date unreported; neutral age score' : `Tracked since ${row.listed_at}`, text: age(row.age_days) }),
    make('td', { class: 'numeric number-cell value-cell', title: `${fullDollars.format(row.implied_value_usd)} · our implied valuation`, text: usd(row.implied_value_usd) }),
    make('td', {}, make('div', { class: 'score-cell', title: `${row.score.toFixed(2)} / 100, not a launch probability` }, make('span', { text: row.score.toFixed(1) }), make('span', { class: 'score-meter', 'aria-hidden': 'true' }, make('i', { style: `width:${clamp(row.score, 0, 100)}%` })))),
    make('td', {}, make('button', { type: 'button', class: 'detail-button', 'aria-label': `Details for ${row.name}`, title: 'Score breakdown & farm checklist', text: '↗' }))
  );
}

function renderBoard() {
  const visible = filteredRows();
  $('board-body').replaceChildren(...visible.map(tableRow));
  $('empty-state').hidden = visible.length !== 0;
  $('radar-table').hidden = visible.length === 0;
  $('result-badge').textContent = visible.length;
  const watch = visible.filter(row => row.on_watchlist).length;
  const early = visible.filter(row => row.below_floor && !row.on_watchlist).length;
  $('result-count').textContent = `${visible.length} of ${data.stats.board} records · ${watch} watchlist · ${early} early`;
  $('early-toggle').setAttribute('aria-pressed', String(state.early));
  for (const button of document.querySelectorAll('[data-sort]')) {
    const active = button.dataset.sort === state.sort;
    button.parentElement.setAttribute('aria-sort', active ? state.dir < 0 ? 'descending' : 'ascending' : 'none');
    button.querySelector('span').textContent = active ? state.dir < 0 ? '↓' : '↑' : '';
  }
  $('board').setAttribute('aria-busy', 'false');
}

function syncControls() {
  $('search').value = state.q;
  $('category').value = state.category;
  $('chain').value = state.chain;
  $('min-tvl').value = state.min || '';
  $('watchlist').checked = state.watch;
}

function changeView() { $('table-scroll').scrollTop = 0; renderBoard(); }
function resetFilters() {
  Object.assign(state, { q: '', category: '', chain: '', watch: false, min: 0, early: false });
  syncControls(); changeView();
}

function componentNote(row, key) {
  if (key === 'tvl') return `${usd(row.tvl_usd)} · diminishing returns on size`;
  if (key === 'growth') return `${row.change_7d === null ? 'Unreported → 0%' : pct(row.change_7d)} · clipped to ±${model.growth_limit_pct}%`;
  if (key === 'age') return row.age_days === null ? 'Unreported → neutral 50/100' : `${(row.age_days / 365.25).toFixed(2)} years tracked · cap ${model.age_cap_years.toFixed(2)}y`;
  if (key === 'breadth') return `${row.chains.length} distinct chains · cap ${model.breadth_cap.toFixed(1)}`;
  return `${row.category_prior.peers} peers · median TVL ${usd(row.category_prior.median_tvl_usd)}`;
}

function detailLeft(row, audit) {
  return make('div', { class: 'detail-left' },
    make('section', {},
      make('div', { class: 'value-panel' }, make('span', { class: 'eyebrow', text: 'OUR IMPLIED LAUNCH VALUE' }), make('div', { class: 'detail-value', title: fullDollars.format(row.implied_value_usd), text: usd(row.implied_value_usd) }), make('div', { class: 'value-bottom' }, make('span', { text: 'Signal score' }), make('span', {}, make('strong', { text: row.score.toFixed(1) }), make('small', { text: ' / 100' })))),
      make('div', { class: 'detail-heading' }, make('h3', { text: 'Why this rank' }), make('span', { text: 'POINTS / WEIGHT' })),
      row.score_breakdown.map(c => make('div', { class: 'breakdown-row', 'data-key': c.key, title: c.explanation },
        make('div', { class: 'breakdown-top' }, make('span', { class: 'breakdown-label' }, c.label, make('small', { text: `${c.weight}%` })), make('span', { class: 'breakdown-points', text: `${c.points.toFixed(1)} / ${c.weight}` })),
        make('div', { class: 'breakdown-track', role: 'meter', 'aria-label': `${c.label} subscore`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': c.normalized.toFixed(2) }, make('i', { style: `width:${clamp(c.normalized, 0, 100)}%` })),
        make('p', { class: 'breakdown-note', text: componentNote(row, c.key) })
      )),
      make('div', { class: `audit ${audit.matches ? '' : 'negative'}` }, make('i', { class: 'dot' }), audit.matches ? 'Recomputed in this page · matches board.json' : 'Model or farm-plan mismatch: inspect generated data')
    ),
    make('section', {},
      make('dl', { class: 'facts-grid' }, [
        ['Recorded TVL', usd(row.tvl_usd)], ['7d TVL change', pct(row.change_7d)],
        ['Tracking age', row.age_days === null ? 'Unreported' : `${age(row.age_days)} · ${row.age_days} days`], ['Listed since', row.listed_at || 'Unreported'],
      ].map(([label, value]) => make('div', { class: 'fact' }, make('dt', { text: label }), make('dd', { text: value })))),
      make('div', { class: 'detail-heading' }, make('h3', { text: 'Recorded chains' }), make('span', { text: `${row.chains.length} NETWORKS` })),
      make('div', { class: 'chain-pills' }, row.chains.length ? row.chains.map(chain => make('span', { class: 'chain-pill', text: chain })) : make('span', { class: 'chain-pill', text: 'Unreported' }))
    ),
    make('details', { class: 'detail-math' }, make('summary', { text: 'Value math & category evidence' }),
      make('p', { class: 'formula', text: `${usd(model.value_anchor_usd)} × 10 ^ ((${row.score.toFixed(4)} − ${model.value_score_midpoint}) / ${model.value_score_decade}) = ${fullDollars.format(audit.value)}` }),
      make('p', { text: `Anchor: ${usd(model.cohort_median_tvl_usd)} median no-token-record TVL × ${model.launched_median_mcap_tvl.toFixed(4)} median recorded-token mcap/TVL. It sets the dollar scale of this entry's own claim.` }),
      make('p', { text: `${categoryOf(row)} prior: ${row.category_prior.peers} records; median TVL ${usd(row.category_prior.median_tvl_usd)}, median growth ${pct(row.category_prior.median_growth_pct)}. Unshrunk ${row.category_prior.unshrunk_score.toFixed(2)} becomes ${row.category_prior.score.toFixed(2)} after five neutral pseudo-peers.` }),
      make('p', { text: 'Listing age proxies pent-up launch value; it is not proof that a token has never existed. The score is not a probability, and the implied value is neither market cap nor expected farming rewards.' })
    )
  );
}

function detailPlan(row) {
  if (!progress.has(row.slug)) progress.set(row.slug, new Set());
  const checked = progress.get(row.slug), plan = row.farm_plan;
  const meter = make('span', { class: 'plan-progress', 'aria-live': 'polite', text: `${checked.size} / ${row.farm_steps.length} COMPLETE` });
  return make('section', { class: 'detail-plan' },
    make('div', { class: 'plan-header' }, make('h3', { text: 'Your farm checklist' }), meter),
    make('div', { class: 'plan-summary' }, make('span', {}, make('strong', { text: fullDollars.format(plan.position_usd) }), ' pilot capital'), make('span', {}, make('strong', { text: `${plan.weeks} weeks` }), ' research window'), make('span', { text: plan.cadence })),
    make('p', { class: 'plan-caveat', text: plan.caveat }),
    make('ol', { class: 'plan-steps' }, plan.steps.map((step, index) => {
      const id = `farm-step-${index}`;
      const checkbox = make('input', { class: 'step-check', id, type: 'checkbox', checked: checked.has(index), 'aria-label': `Complete step ${index + 1}: ${step.title}`, onchange: event => {
        if (event.target.checked) checked.add(index); else checked.delete(index);
        meter.textContent = `${checked.size} / ${row.farm_steps.length} COMPLETE`;
      } });
      return make('li', { class: 'plan-step' }, checkbox,
        make('label', { class: 'step-title', for: id }, make('span', { text: String(index + 1).padStart(2, '0') }), step.title),
        make('p', { class: 'step-action', text: step.action }),
        make('p', { class: 'step-meta' }, make('b', { text: 'Cost: ' }), step.cost, make('span', { class: 'meta-time' }, make('b', { text: 'Time: ' }), step.time))
      );
    })),
    make('p', { class: 'plan-footnote', text: `Planning allowances, not observed fees: up to ${fullDollars.format(plan.gas_allowance_usd)} gas reserve, ${fullDollars.format(plan.bridge_allowance_usd)} bridging if needed, and ${fullDollars.format(plan.weekly_fee_cap_usd)} weekly transaction fees. Capital remains at risk. No reward is assumed.` })
  );
}

function openDetail(slug) {
  const row = rowsBySlug.get(slug);
  if (!row) return;
  state.selected = slug;
  const audit = calculateRow(row);
  $('detail-content').replaceChildren(
    make('header', { class: 'detail-header' }, make('div', { class: 'detail-identity' }, avatar(row), make('div', {},
      make('div', { class: 'detail-kicker' }, `RANK ${String(row.rank).padStart(2, '0')} / ${data.stats.board}`, row.on_watchlist ? make('span', { class: 'watch-chip', text: 'WATCHLIST' }) : make('span', { class: 'watch-chip', text: 'BELOW FLOOR' })),
      make('h2', { id: 'detail-title', text: row.name }), make('p', { text: `${categoryOf(row)} · ${planTier(row)} · records no token · snapshot ${data.as_of}` })
    )), make('button', { class: 'close-button', type: 'button', 'aria-label': 'Close protocol details', text: '×', onclick: () => $('detail').close() })),
    make('div', { class: 'detail-grid' }, detailLeft(row, audit), detailPlan(row))
  );
  for (const tr of $('board-body').children) tr.classList.toggle('selected', tr.dataset.slug === slug);
  if (!$('detail').open) $('detail').showModal();
  $('detail').scrollTop = 0;
}

function planTier(row) { return row.farm_plan.tier.toLowerCase(); }

$('detail').addEventListener('close', () => { state.selected = null; for (const tr of $('board-body').children) tr.classList.remove('selected'); });
$('detail').addEventListener('click', event => {
  if (event.target !== $('detail')) return;
  const box = $('detail').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) $('detail').close();
});
$('filters').addEventListener('submit', event => event.preventDefault());
$('search').addEventListener('input', event => { state.q = event.target.value; changeView(); });
$('category').addEventListener('change', event => { state.category = event.target.value; changeView(); });
$('chain').addEventListener('change', event => { state.chain = event.target.value; changeView(); });
$('min-tvl').addEventListener('input', event => { const n = Number(event.target.value); state.min = Number.isFinite(n) ? Math.max(0, n) : 0; changeView(); });
$('watchlist').addEventListener('change', event => { state.watch = event.target.checked; if (state.watch) state.early = false; changeView(); });
$('early-toggle').addEventListener('click', () => { state.early = !state.early; if (state.early) { state.watch = false; $('watchlist').checked = false; } changeView(); });
$('reset').addEventListener('click', resetFilters);
$('empty-reset').addEventListener('click', resetFilters);
for (const button of document.querySelectorAll('[data-sort]')) button.addEventListener('click', () => {
  const key = button.dataset.sort;
  state.dir = state.sort === key ? -state.dir : ['rank', 'name', 'category', 'chains'].includes(key) ? 1 : -1;
  state.sort = key; changeView();
});
$('board-body').addEventListener('click', event => { const tr = event.target.closest('tr[data-slug]'); if (tr) openDetail(tr.dataset.slug); });
$('board-body').addEventListener('keydown', event => { if (event.target.tagName === 'TR' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openDetail(event.target.dataset.slug); } });
$('method-toggle').addEventListener('click', () => { $('model-notes').hidden = !$('model-notes').hidden; $('method-toggle').setAttribute('aria-expanded', String(!$('model-notes').hidden)); });
for (const link of document.querySelectorAll('.nav-item')) link.addEventListener('click', () => { for (const item of document.querySelectorAll('.nav-item')) { item.classList.toggle('active', item === link); if (item === link) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); } });
document.addEventListener('keydown', event => { if (event.key === '/' && !$('detail').open && !['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) { event.preventDefault(); $('search').focus(); } });

initializeFacts();
const failures = data.rows.filter(row => !calculateRow(row).matches);
$('load-error').hidden = failures.length === 0;
if (failures.length) $('load-error').textContent = `The page found ${failures.length} model or plan mismatches. Regenerate the output before relying on it.`;
syncControls(); renderBoard();
})();
