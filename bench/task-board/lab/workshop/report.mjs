// Builds the benchmark report: one self-contained HTML page from the run records.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const money = (v) => (v === null || v === undefined ? 'n/a' : v === 0 ? '$0' : v < 0.1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`)
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n))
const turns = (r) => r.turns.orchestrator + r.turns.subagents
const tools = (r) => r.toolCalls.orchestrator + r.toolCalls.subagents

function bars(title, rows, format, { lowerIsBetter = false } = {}) {
  const values = rows.filter((r) => r.value !== null && r.value !== undefined)
  const max = Math.max(...values.map((r) => r.value), 0.000001)
  const best = values.length ? (lowerIsBetter ? Math.min(...values.map((r) => r.value)) : Math.max(...values.map((r) => r.value))) : null
  const items = rows.map((r) => {
    if (r.value === null || r.value === undefined) return `<li><span class="lab">${esc(r.label)}</span><span class="track"><span class="none">not run</span></span><span class="val"></span></li>`
    const width = Math.max(1.5, (r.value / max) * 100)
    return `<li><span class="lab">${esc(r.label)}</span><span class="track"><span class="bar${r.value === best ? ' best' : ''}" style="width:${width.toFixed(1)}%"></span></span><span class="val">${esc(format(r.value))}</span></li>`
  })
  return `<section class="chart"><h3>${esc(title)}</h3><ul>${items.join('')}</ul></section>`
}

function findings(runs, config) {
  const out = []
  const byId = Object.fromEntries(runs.map((r) => [r.setup, r]))
  const good = runs.filter((r) => r.ruleCheck.ok)
  const fmt = (r) => `${r.setup}. ${r.name}`
  if (runs.length === 0) return out
  const top = Math.max(...runs.map((r) => r.score))
  const leaders = runs.filter((r) => r.score >= top - 0.05)
  out.push(`<b>Best score:</b> ${leaders.map(fmt).map(esc).join('; ')} with ${top.toFixed(1)} out of 100.`)
  const close = runs.filter((r) => r.score >= top - 5)
  const cheapest = [...close].sort((a, b) => a.cost - b.cost)[0]
  if (cheapest && close.length > 1) out.push(`<b>Cheapest within 5 points of the best:</b> ${esc(fmt(cheapest))} at ${money(cheapest.cost)} (${cheapest.score.toFixed(1)} points).`)
  const quickest = [...close].sort((a, b) => a.seconds - b.seconds)[0]
  if (quickest && close.length > 1) out.push(`<b>Fastest within 5 points of the best:</b> ${esc(fmt(quickest))} in ${clock(quickest.seconds)} (minutes:seconds).`)
  const pairs = [['1', '2', 'Claude'], ['3', '4', 'DeepSeek in the cloud'], ['6', '7', 'local models']]
  for (const [solo, team, label] of pairs) {
    const a = byId[solo]
    const b = byId[team]
    if (!a || !b) continue
    const dScore = b.score - a.score
    const dCost = a.cost > 0 ? ((b.cost - a.cost) / a.cost) * 100 : null
    const dTime = ((b.seconds - a.seconds) / a.seconds) * 100
    const bit = (v, unit) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(unit === 'pt' ? 1 : 0)}${unit === 'pt' ? ' points' : '%'}`
    out.push(`<b>Adding sub-agents (${esc(label)}, setup ${solo} to ${team}):</b> score ${bit(dScore, 'pt')}, ${dCost === null ? 'cost n/a' : `cost ${bit(dCost, '%')}`}, time ${bit(dTime, '%')}.`)
  }
  const local = runs.filter((r) => r.orchestrator.source === 'local')
  const cloud = runs.filter((r) => r.orchestrator.source !== 'local')
  if (local.length && cloud.length) {
    const bestLocal = [...local].sort((a, b) => b.score - a.score)[0]
    const bestCloud = [...cloud].sort((a, b) => b.score - a.score)[0]
    out.push(`<b>Local against cloud:</b> best local ${bestLocal.score.toFixed(1)} (${esc(fmt(bestLocal))}), best cloud ${bestCloud.score.toFixed(1)} (${esc(fmt(bestCloud))}). Local runs cost no money, but they use your laptop's time, memory and power.`)
  }
  const bad = runs.filter((r) => !r.ruleCheck.ok)
  if (bad.length) out.push(`<b>Rule problems in ${bad.length} run(s):</b> ${bad.map((r) => `setup ${esc(r.setup)} (${esc(r.ruleCheck.problems[0])})`).join('; ')}. Read these runs with care.`)
  if (good.length < runs.length) out.push('A setup with a rule problem is still scored, but it is not a clean example of what it claims to be.')
  return out
}

export function buildReport(runs, { task, config, models }) {
  const ordered = config.setups.map((s) => ({ setup: s, run: runs.find((r) => r.setup === s.id) }))
  const done = ordered.filter((o) => o.run).map((o) => o.run)
  const place = (m) => (m.source === 'local' ? ' (local)' : '')
  const modelLine = (r) => `${esc(r.orchestrator.label)}${place(r.orchestrator)}${r.subagent ? ` → ${esc(r.subagent.label)}${place(r.subagent)}` : ''}`
  const when = done.length ? new Date(Math.max(...done.map((r) => Date.parse(r.date)))).toLocaleString('en-GB') : ''

  const tableRows = ordered.map(({ setup, run }) => {
    if (!run) return `<tr class="missing"><td>${esc(setup.id)}</td><td>${esc(setup.name)}</td><td colspan="8">not run</td></tr>`
    const flag = run.ruleCheck.ok ? '<span class="ok">ok</span>' : `<span class="warn" title="${esc(run.ruleCheck.problems.join('; '))}">${run.ruleCheck.problems.length} problem${run.ruleCheck.problems.length > 1 ? 's' : ''}</span>`
    const split = run.subagentsStarted > 0 || run.turns.subagents > 0 ? `${run.turns.orchestrator} + ${run.turns.subagents}` : String(run.turns.orchestrator)
    return `<tr><td>${esc(setup.id)}</td><td><b>${esc(run.name)}</b><br><span class="sub">${esc(run.agent)} · ${modelLine(run)}</span></td>` +
      `<td class="num strong">${run.score.toFixed(1)}</td><td class="num">${money(run.cost)}</td><td class="num">${clock(run.seconds)}</td>` +
      `<td class="num">${split}</td><td class="num">${tools(run)}</td><td class="num">${run.subagentsStarted}</td><td class="num">${tokens(run.tokens.total)}</td><td>${flag}</td></tr>`
  }).join('')

  const label = (s) => `${s.id}. ${s.name.replace(/ orchestrates, /, ' + ').replace(/ implements/, '').replace(/^Local /, '')}`
  const pick = (fn) => ordered.map(({ setup, run }) => ({ label: label(setup), value: run ? fn(run) : null }))
  const charts = [
    bars('Score out of 100 (higher is better)', pick((r) => r.score), (v) => v.toFixed(1)),
    bars('Cost in dollars (lower is better)', pick((r) => r.cost), money, { lowerIsBetter: true }),
    bars('Time in minutes (lower is better)', pick((r) => r.seconds / 60), (v) => `${v.toFixed(1)} min`, { lowerIsBetter: true }),
    bars('Tokens processed (lower is lighter)', pick((r) => r.tokens.total), tokens, { lowerIsBetter: true }),
  ].join('')

  const details = done.map((r) => {
    const parts = Object.entries(r.parts ?? {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${Number(v).toFixed(1)}</td></tr>`).join('')
    const models = Object.entries(r.perModel ?? {}).map(([m, u]) => `<tr><td>${esc(m)}</td><td class="num">${u.turns}</td><td class="num">${tokens(u.input + u.output + u.cacheRead)}</td><td class="num">${money(u.cost)}</td></tr>`).join('')
    const notes = (r.notes ?? []).join('\n').slice(0, 1400)
    return `<details><summary><b>${esc(r.setup)}. ${esc(r.name)}</b> <span class="sub">score ${r.score.toFixed(1)} · ${money(r.cost)} · ${clock(r.seconds)}</span></summary>
<div class="detail"><div><h4>Score parts</h4><table class="mini">${parts}</table></div>
<div><h4>By model</h4><table class="mini"><tr><th>Model</th><th>Turns</th><th>Tokens</th><th>Cost</th></tr>${models}</table></div>
<div><h4>By role</h4><table class="mini"><tr><th></th><th>Turns</th><th>Tool calls</th><th>Edits</th><th>Tokens</th></tr>
<tr><td>Main agent</td><td class="num">${r.turns.orchestrator}</td><td class="num">${r.toolCalls.orchestrator}</td><td class="num">${r.edits.orchestrator}</td><td class="num">${tokens(r.tokens.orchestrator.input + r.tokens.orchestrator.output + r.tokens.orchestrator.cacheRead)}</td></tr>
<tr><td>Sub-agents (${r.subagentsStarted})</td><td class="num">${r.turns.subagents}</td><td class="num">${r.toolCalls.subagents}</td><td class="num">${r.edits.subagents}</td><td class="num">${tokens(r.tokens.subagents.input + r.tokens.subagents.output + r.tokens.subagents.cacheRead)}</td></tr></table></div></div>
<p class="sub">Cost: ${esc(r.costMethod)}.</p>
${r.ruleCheck.ok ? '' : `<p class="warnbox"><b>Rule check:</b> ${r.ruleCheck.problems.map(esc).join('; ')}</p>`}
${notes ? `<pre>${esc(notes)}</pre>` : ''}</details>`
  }).join('')

  const items = findings(done, config).map((f) => `<li>${f}</li>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mission benchmark report</title>
<style>
:root{--bg:#f7f7f3;--card:#fff;--ink:#1b1b1b;--mute:#5f6b66;--line:#d9dcd8;--bar:#9aa7a1;--best:#0b996e;--warn:#b45309;--warnbg:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#141716;--card:#1d2120;--ink:#ecefed;--mute:#9aa6a0;--line:#343b38;--bar:#5d6a64;--best:#3ddc9f;--warn:#fbbf24;--warnbg:#2c2410}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:32px 16px 64px}
main{max-width:1180px;margin:0 auto}h1{font-size:34px;margin:0 0 4px;letter-spacing:-.5px}h2{font-size:24px;margin:40px 0 12px}h3{font-size:18px;margin:0 0 10px}h4{margin:0 0 6px;font-size:15px;color:var(--mute)}
.sub{color:var(--mute);font-size:14px}.lead{color:var(--mute);margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute)}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.strong{font-weight:700;font-size:19px}
.missing td{color:var(--mute)}.ok{color:var(--best);font-weight:600}.warn{color:var(--warn);font-weight:600;cursor:help}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:16px}.chart ul{list-style:none;margin:0;padding:0}
.chart li{display:grid;grid-template-columns:minmax(150px,1fr) 2fr 84px;gap:10px;align-items:center;padding:4px 0;font-size:15px}
.track{background:color-mix(in srgb,var(--line) 55%,transparent);border-radius:6px;height:18px;display:block}.bar{display:block;height:18px;border-radius:6px;background:var(--bar)}.bar.best{background:var(--best)}
.none{color:var(--mute);font-size:13px;padding-left:8px}.val{text-align:right;font-variant-numeric:tabular-nums;font-weight:600}
.find li{margin:8px 0}details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:10px 0}summary{cursor:pointer}
.detail{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;margin-top:12px}.mini td,.mini th{padding:4px 8px;font-size:14px}
pre{background:color-mix(in srgb,var(--line) 35%,transparent);padding:12px;border-radius:8px;overflow:auto;font-size:13px;white-space:pre-wrap}
.warnbox{background:var(--warnbg);border-left:4px solid var(--warn);padding:8px 12px;border-radius:6px}
.caveats{color:var(--mute);font-size:15px}.caveats li{margin:6px 0}
</style></head><body><main>
<h1>Mission benchmark report</h1>
<p class="lead">Mission: <b>${esc(task)}</b>. The same job, given as <code>MISSION.md</code>, to ${config.setups.length} setups. ${esc(done.length)} of ${config.setups.length} have a result${when ? `. Last run ${esc(when)}` : ''}.</p>

<h2>Scoreboard</h2>
<div class="card scroll"><table><thead><tr><th>#</th><th>Setup</th><th class="num">Score</th><th class="num">Cost</th><th class="num">Time</th><th class="num" title="main agent turns + sub-agent turns">Turns</th><th class="num">Tool calls</th><th class="num">Sub-agents</th><th class="num">Tokens</th><th>Rules</th></tr></thead><tbody>${tableRows}</tbody></table></div>

<h2>Side by side</h2><div class="charts">${charts}</div>

<h2>What the numbers say</h2><div class="card"><ul class="find">${items || '<li>No results yet.</li>'}</ul></div>

<h2>Details per setup</h2>${details || '<p class="sub">No results yet.</p>'}

<h2>How to read this</h2><div class="card"><ul class="caveats">
<li><b>Score</b> is out of 100 from hidden tests: the mission itself 60, existing behaviour 25, hygiene 15 (type-check, build, scope, tests kept). Each part is curved, so almost right earns much less than right.</li>
<li><b>Cost</b> for the DeepSeek harness is what OpenRouter charged for each reply. For Claude Code it is Claude Code's own figure at list prices. Local models cost $0 in money, not in time, memory or power.</li>
<li><b>One run is a sample, not a ranking.</b> The same model can score very differently on the same job from one run to the next.</li>
<li><b>Time</b> is only fair for runs done one at a time. When setups run together they share one laptop, and a local model can slow down while cloud runs and scoring are busy.</li>
<li><b>Rules</b>: a setup meant to use sub-agents should use them, an orchestrator should not edit files itself, a setup that works alone should not start sub-agents, and nobody runs shell commands.</li>
<li>Turns are model replies. Tool calls are the reads, searches and edits that followed. Tokens are input, output and cached input together.</li>
</ul></div>
</main></body></html>
`
}
