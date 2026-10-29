#!/usr/bin/env node
// The mission benchmark: seven setups, one mission, one report.
//
//   node lab/workshop/bench.mjs setups                       list the seven setups
//   node lab/workshop/bench.mjs mission [--task <id>]        write the reference mission.md
//   node lab/workshop/bench.mjs run <setup>                  run one setup (1 to 7) and record the result
//   node lab/workshop/bench.mjs run-all [--only 1,3,4] [--parallel]   run several, optionally at the same time
//   node lab/workshop/bench.mjs report [--open]              build report.html and print the table
//
// Options: --task <id> (default: the mission in setups.json), --root <dir> (default ~/task-board-bench),
// --timeout <min> (default 45), --again (start a setup over), --max-cloud <n> (parallel cloud runs, default all).
// Local models: --base-url <url> (default http://127.0.0.1:11434/v1), --context <tokens> (default 65536),
// --qwen <name>, --gemma <name>, or --set <key>=<model name> for any model in setups.json.
//
// Every run writes <root>/runs/<task>__<slug>.json: score, time, exact cost, turns, tool calls, tokens by role,
// sub-agents used and a rule check. The report is built from those files.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { buildReport } from './report.mjs'
import { priceDsh, summarizeClaude, summarizeDsh } from './usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB = path.resolve(HERE, '..')
const BENCH = path.resolve(LAB, '..')
const LADDER = path.join(HERE, 'ladder.mjs')
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'setups.json'), 'utf8'))

const args = process.argv.slice(2)
const command = args[0]
const flag = (name) => args.includes(`--${name}`)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const optionAll = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const task = option('task', config.mission)
const root = path.resolve(option('root', path.join(os.homedir(), 'task-board-bench')))
const timeoutMinutes = Number(option('timeout', '45'))
const baseUrl = option('base-url', process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1')
const contextTokens = option('context', process.env.LOCAL_CONTEXT ?? '65536')
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------- setups and models
function findSetup(id) {
  const setup = config.setups.find((s) => s.id === id || s.slug === id || s.slug.startsWith(`s${id}-`))
  if (!setup) fail(`unknown setup "${id}". Use 1 to ${config.setups.length}. List them with: bench.mjs setups`)
  return setup
}

// Local model names can be changed with --qwen, --gemma, --set key=name, or by editing setups.json.
function modelFor(key) {
  const model = { ...config.models[key], key }
  const overrides = Object.fromEntries(optionAll('set').map((pair) => pair.split(/=(.*)/s).slice(0, 2)))
  if (key === 'qwen' && option('qwen')) overrides.qwen = option('qwen')
  if (key === 'gemma' && option('gemma')) overrides.gemma = option('gemma')
  if (overrides[key]) model.model = overrides[key]
  return model
}

// Ollama reads "qwen3.5" as "qwen3.5:latest". Ask the server what it has and pick the one model the name means.
async function resolveLocal(name, url) {
  let served
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    served = ((await res.json())?.data ?? []).map((m) => m.id).filter(Boolean)
  } catch (err) {
    throw new Error(`could not reach the local model server at ${url} (${err.message}). Is it running? For Ollama: ollama serve`)
  }
  if (served.includes(name)) return name
  const matches = served.filter((id) => id.split(':')[0] === name || id.startsWith(`${name}:`))
  if (matches.length === 1) return matches[0]
  const list = served.length ? `It serves:\n  ${served.slice(0, 20).join('\n  ')}` : 'It serves no models yet.'
  if (matches.length > 1) throw new Error(`"${name}" matches more than one model: ${matches.join(', ')}. Pass the full name, for example --qwen ${matches[0]}`)
  throw new Error(`the server at ${url} has no model "${name}". ${list}`)
}

async function ensureKey() {
  const key = (process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY)?.trim()
  if (key) {
    process.env.OPENROUTER_API_KEY = key
    return true
  }
  if (!process.stdin.isTTY) return false
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const write = rl._writeToOutput
  const prompt = 'No OpenRouter key is exported. Paste it (hidden, not saved):'
  rl._writeToOutput = (text) => (text.includes(prompt) ? write.call(rl, text) : text.includes('\n') && write.call(rl, '\n'))
  const answer = await new Promise((resolve) => rl.question(`${prompt} `, resolve))
  rl.close()
  process.env.OPENROUTER_API_KEY = answer.trim()
  return answer.trim() !== ''
}

const usesCloud = (setup) => [setup.orchestrator, setup.subagent].filter(Boolean).some((k) => modelFor(k).source === 'openrouter')
const usesLocal = (setup) => [setup.orchestrator, setup.subagent].filter(Boolean).some((k) => modelFor(k).source === 'local')

// ---------------------------------------------------------------- prompts and harness settings
const SOLO_PROMPT = 'Read MISSION.md in this folder and carry out the mission. Work alone: do not use sub-agents. Follow the rules of the run in MISSION.md.'
const orchestratorPrompt = (how) =>
  `Read MISSION.md in this folder. You are the orchestrator. Do not edit any file yourself. Plan the work, then hand the edits to at most 3 sub-agents, using ${how}. ` +
  'Give each sub-agent a self-contained task packet: the files it may write, the exact names and signatures it must use, and the behaviour to keep. Do not paste whole files into the packet. ' +
  'When they return, read only the files they changed. If something is wrong, send a correction to a sub-agent instead of fixing it yourself. Follow the rules of the run in MISSION.md, then reply with a short note.'

// The harness overlay for a setup: providers, the main model, the sub-agent model, and no shell for anyone.
function harnessOverlay(orch, sub, local) {
  const models = [orch, sub].filter(Boolean)
  const providerModels = (source) => [...new Set(models.filter((m) => m.source === source).map((m) => m.model))]
  const lines = ['- id: llm-pi-ai', '  config:', '    providers:']
  if (providerModels('openrouter').length) {
    lines.push('      openrouter:', '        displayName: OpenRouter', '        apiKeyEnv: OPENROUTER_API_KEY', '        api: openai-completions', '        baseURL: https://openrouter.ai/api/v1', '        models:')
    for (const id of providerModels('openrouter')) lines.push(`          - id: ${id}`)
  }
  if (providerModels('local').length) {
    lines.push('      local:', '        displayName: Local model', '        apiKeyEnv: LOCAL_API_KEY', '        api: openai-completions', `        baseURL: ${local.baseUrl}`, '        models:')
    for (const id of providerModels('local')) {
      const compat = models.find((m) => m.source === 'local' && m.model === id)?.compat
      lines.push(`          - id: ${id}`, `            contextWindow: ${Number(local.context)}`)
      if (compat) lines.push(`            compat: ${JSON.stringify(compat)}`)
    }
  }
  const provider = (m) => (m.source === 'local' ? 'local' : 'openrouter')
  lines.push('- id: agent-default-model', '  config:', `    provider: ${provider(orch)}`, `    model: ${orch.model}`)
  lines.push('- id: tool-bash', '  disabled: true') // the rules say: do not run anything
  lines.push('- id: tool-subagent-fork', '  disabled: true')
  if (sub) {
    lines.push('- id: tool-subagent', '  config:', '    provider: spawn', '    toolName: subagent', '    agentOptions:', `      provider: ${provider(sub)}`, `      model: ${sub.model}`)
  } else {
    lines.push('- id: tool-subagent', '  disabled: true') // alone means alone
  }
  return `${lines.join('\n')}\n`
}

function runProcess(cmd, cmdArgs, { cwd, env, stdin, logFile, minutes }) {
  return new Promise((resolve) => {
    const fd = fs.openSync(logFile, 'w')
    const child = spawn(cmd, cmdArgs, { cwd, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', fd, fd] })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5000)
    }, minutes * 60_000)
    if (stdin !== undefined) child.stdin.end(stdin)
    child.on('error', (err) => fs.appendFileSync(logFile, `\ncould not start ${cmd}: ${err.message}\n`))
    child.on('exit', (code) => {
      clearTimeout(timer)
      fs.closeSync(fd)
      resolve({ code, timedOut })
    })
  })
}

// ---------------------------------------------------------------- one run
async function runOne(setup) {
  const orch = modelFor(setup.orchestrator)
  const sub = setup.subagent ? modelFor(setup.subagent) : null
  const run = `${task}__${slug(setup.slug)}`
  const folder = path.join(root, run)
  const scratch = path.join(root, '.bench')
  fs.mkdirSync(scratch, { recursive: true })
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true })

  for (const m of [orch, sub].filter(Boolean)) {
    if (m.source === 'local') m.model = await resolveLocal(m.model, baseUrl).catch((err) => fail(err.message))
  }
  if (usesCloud(setup) && !(await ensureKey())) fail('no OpenRouter key. Export OPENROUTER_API_KEY, or run this in a terminal to be asked for it.')

  const started = spawnSync(process.execPath, [LADDER, 'start', task, '--model', setup.slug, '--root', root, ...(flag('again') ? ['--again'] : [])], { encoding: 'utf8' })
  if (started.status !== 0) fail(`could not start ${setup.slug}:\n${started.stdout}${started.stderr}`)
  console.log(`[${setup.id}] ${setup.name}: folder ready, running...`)

  const logFile = path.join(scratch, `${run}.log`)
  const t0 = Date.now()
  let outcome
  if (setup.agent === 'claude') {
    const tools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', ...(sub ? ['Agent', 'Task'] : [])]
    const blocked = ['Bash', ...(sub ? [] : ['Agent', 'Task'])]
    const claudeArgs = ['-p', '--model', orch.model, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--setting-sources', 'project', '--disable-slash-commands', '--no-session-persistence', '--allowedTools', tools.join(','), '--disallowedTools', blocked.join(',')]
    if (sub) {
      const implementer = {
        description: 'Implements one well-specified work packet and reports back.',
        prompt: 'You are an implementer. Do exactly the work packet you are given. Edit only the files it names. Follow the house rules in README.md. Reply with one line per file you changed.',
        model: sub.model,
        tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
      }
      claudeArgs.push('--agents', JSON.stringify({ implementer }))
    }
    const prompt = sub ? orchestratorPrompt('the `implementer` sub-agent (the Agent tool, subagent_type implementer)') : SOLO_PROMPT
    outcome = await runProcess('claude', claudeArgs, { cwd: folder, env: process.env, stdin: prompt, logFile, minutes: timeoutMinutes })
  } else {
    const overlay = path.join(scratch, `${run}.patch.yml`)
    fs.writeFileSync(overlay, harnessOverlay(orch, sub, { baseUrl, context: contextTokens }))
    const prompt = sub ? orchestratorPrompt('the subagent tool') : SOLO_PROMPT
    const env = { ...process.env, LOCAL_API_KEY: process.env.LOCAL_API_KEY ?? 'local' }
    outcome = await runProcess('npx', ['@deepseek-ai/dsh', '--profile', 'headless', '--patch', overlay, prompt], { cwd: folder, env, logFile, minutes: timeoutMinutes })
  }
  const seconds = (Date.now() - t0) / 1000
  console.log(`[${setup.id}] agent finished after ${(seconds / 60).toFixed(1)} min${outcome.timedOut ? ' (stopped by the time limit)' : ''}. Collecting usage and scoring...`)

  // what the run used
  let usage
  let cost = 0
  let costMethod
  if (setup.agent === 'claude') {
    const stream = fs.readFileSync(logFile, 'utf8').split('\n')
    usage = summarizeClaude(stream)
    cost = usage.cost ?? 0
    costMethod = usage.cost === null ? 'not reported' : "exact, from Claude Code's own cost figure (list prices)"
  } else {
    usage = summarizeDsh(folder)
    if (!usage) {
      usage = { roles: { orchestrator: {}, subagents: {} }, perModel: {}, toolNames: {}, spawned: 0, sessions: 0 }
      costMethod = 'no harness session was found'
    } else {
      const priced = await priceDsh(usage, process.env.OPENROUTER_API_KEY)
      cost = priced.total ?? 0
      costMethod = priced.method
    }
  }

  // the score
  const finished = spawnSync(process.execPath, [LADDER, 'finish', task, '--model', setup.slug, '--root', root, '--cost', String(cost), '--seconds', String(Math.round(seconds))], { encoding: 'utf8' })
  const row = (readJson(path.join(root, 'results.json'), []) ?? []).find((r) => r.task === task && r.model === setup.slug)
  const report = readJson(path.join(BENCH, 'reports', `ladder-${run}.json`), null)
  if (!row || !report) fail(`scoring failed for ${setup.slug}:\n${finished.stdout}${finished.stderr}`)

  const r = (role, key) => usage.roles?.[role]?.[key] ?? 0
  const tokens = (role) => ({ input: r(role, 'input'), output: r(role, 'output'), cacheRead: r(role, 'cacheRead') })
  const sum = (t) => t.input + t.output + t.cacheRead
  const problems = []
  const shell = r('orchestrator', 'shell') + r('subagents', 'shell')
  if (shell > 0) problems.push(`ran ${shell} shell command(s); the rules say not to run anything`)
  if (sub) {
    if (usage.spawned === 0) problems.push('no sub-agent was used, so the orchestrator did the work alone')
    if (r('orchestrator', 'edits') > 0) problems.push(`the orchestrator edited files itself (${r('orchestrator', 'edits')} edit calls)`)
    if (usage.spawned > 3) problems.push(`${usage.spawned} sub-agents were started; the limit is 3`)
  } else if (usage.spawned > 0) problems.push(`${usage.spawned} sub-agent(s) were started in a "work alone" setup`)
  if (row.changed === false) problems.push('the agent changed no files')
  if (outcome.timedOut) problems.push(`stopped by the ${timeoutMinutes} minute time limit`)
  if (setup.agent === 'claude' && usage.isError) problems.push('Claude Code reported an error')

  const record = {
    setup: setup.id,
    slug: setup.slug,
    name: setup.name,
    task,
    agent: setup.agent === 'claude' ? 'Claude Code' : 'DeepSeek harness',
    orchestrator: { key: setup.orchestrator, model: orch.model, label: orch.label, source: orch.source ?? 'anthropic' },
    subagent: sub ? { key: setup.subagent, model: sub.model, label: sub.label, source: sub.source ?? 'anthropic' } : null,
    score: row.score,
    parts: report.parts,
    notes: report.notes,
    changed: row.changed,
    seconds: Math.round(seconds),
    cost,
    costMethod,
    turns: { orchestrator: r('orchestrator', 'turns'), subagents: r('subagents', 'turns') },
    toolCalls: { orchestrator: r('orchestrator', 'toolCalls'), subagents: r('subagents', 'toolCalls') },
    edits: { orchestrator: r('orchestrator', 'edits'), subagents: r('subagents', 'edits') },
    tokens: { orchestrator: tokens('orchestrator'), subagents: tokens('subagents'), total: sum(tokens('orchestrator')) + sum(tokens('subagents')) },
    perModel: usage.perModel ?? {},
    subagentsStarted: usage.spawned ?? 0,
    ruleCheck: { ok: problems.length === 0, problems },
    timedOut: outcome.timedOut,
    date: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(root, 'runs', `${run}.json`), `${JSON.stringify(record, null, 2)}\n`)
  console.log(`[${setup.id}] score ${record.score.toFixed(1)}  cost $${cost.toFixed(4)}  time ${(seconds / 60).toFixed(1)} min  turns ${record.turns.orchestrator + record.turns.subagents}  sub-agents ${record.subagentsStarted}${problems.length ? `\n[${setup.id}] rule check: ${problems.join('; ')}` : ''}`)
  return record
}

// ---------------------------------------------------------------- commands
function printTable(runs) {
  const rows = config.setups.map((s) => runs.find((x) => x.setup === s.id))
  console.log('\nSetup'.padEnd(54) + 'Score'.padEnd(8) + 'Cost'.padEnd(10) + 'Time'.padEnd(9) + 'Turns'.padEnd(7) + 'Sub-agents  Rules')
  config.setups.forEach((s, i) => {
    const r = rows[i]
    const name = `${s.id}. ${s.name}`.slice(0, 52).padEnd(53)
    if (!r) return console.log(`${name} not run`)
    const turns = r.turns.orchestrator + r.turns.subagents
    console.log(`${name} ${r.score.toFixed(1).padEnd(7)} ${`$${r.cost.toFixed(3)}`.padEnd(9)} ${`${(r.seconds / 60).toFixed(1)}m`.padEnd(8)} ${String(turns).padEnd(6)} ${String(r.subagentsStarted).padEnd(11)} ${r.ruleCheck.ok ? 'ok' : `${r.ruleCheck.problems.length} problem(s)`}`)
  })
}

const loadRuns = () => {
  const dir = path.join(root, 'runs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f.startsWith(`${task}__`)).map((f) => readJson(path.join(dir, f), null)).filter(Boolean)
}

if (command === 'setups') {
  console.log(`Mission: ${config.mission}\n`)
  for (const s of config.setups) {
    const o = modelFor(s.orchestrator)
    const sub = s.subagent ? modelFor(s.subagent) : null
    const where = (m) => (m.source === 'local' ? 'local' : m.source === 'openrouter' ? 'OpenRouter' : 'Anthropic')
    console.log(`${s.id}. ${s.name}\n   agent: ${s.agent === 'claude' ? 'Claude Code' : 'DeepSeek harness'}   main: ${o.label} (${where(o)})   sub-agent: ${sub ? `${sub.label} (${where(sub)})` : 'none, works alone'}`)
  }
} else if (command === 'mission') {
  const out = path.join(HERE, 'mission.md')
  const folder = path.join(os.tmpdir(), `mission-preview-${process.pid}`)
  const made = spawnSync(process.execPath, [LADDER, 'start', task, '--model', 'preview', '--root', folder], { encoding: 'utf8' })
  if (made.status !== 0) fail(made.stdout + made.stderr)
  const body = fs.readFileSync(path.join(folder, `${task}__preview`, 'MISSION.md'), 'utf8')
  fs.rmSync(folder, { recursive: true, force: true })
  fs.writeFileSync(out, `<!-- Generated by: node lab/workshop/bench.mjs mission --task ${task}\n     Every setup in the benchmark receives exactly this file as MISSION.md. Edit mission.template.md, not this file. -->\n\n${body}`)
  console.log(`wrote ${out}`)
} else if (command === 'run') {
  const setup = findSetup(args[1])
  const record = await runOne(setup)
  process.exit(record ? 0 : 1)
} else if (command === 'run-all') {
  const only = option('only')
  const setups = (only ? only.split(',').map((id) => findSetup(id.trim())) : config.setups)
  if (setups.length === 0) fail('nothing to run')
  // check the cheap things first: a missing local model or key should stop everything before any money is spent
  for (const s of setups) {
    for (const k of [s.orchestrator, s.subagent].filter(Boolean)) {
      const m = modelFor(k)
      if (m.source === 'local') await resolveLocal(m.model, baseUrl).catch((err) => fail(`setup ${s.id}: ${err.message}`))
    }
  }
  if (setups.some(usesCloud) && !(await ensureKey())) fail('no OpenRouter key. Export OPENROUTER_API_KEY, or run this in a terminal to be asked for it.')
  if (setups.some((s) => s.agent === 'claude') && spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) fail('Claude Code is not installed, so setups 1 and 2 cannot run. Use --only 3,4,5,6,7')

  const self = fileURLToPath(import.meta.url)
  const passthrough = ['--task', task, '--root', root, '--timeout', String(timeoutMinutes), '--base-url', baseUrl, '--context', String(contextTokens),
    ...(flag('again') ? ['--again'] : []), ...['qwen', 'gemma'].flatMap((k) => (option(k) ? [`--${k}`, option(k)] : [])), ...optionAll('set').flatMap((v) => ['--set', v])]
  fs.mkdirSync(path.join(root, '.bench'), { recursive: true })
  const started = Date.now()
  const stamp = () => `[${Math.floor((Date.now() - started) / 60000)}m${String(Math.floor(((Date.now() - started) % 60000) / 1000)).padStart(2, '0')}s]`
  const finished = new Set()
  const launch = (s) => new Promise((resolve) => {
    const log = path.join(root, '.bench', `run-${s.slug}.out`)
    const fd = fs.openSync(log, 'w')
    const child = spawn(process.execPath, [self, 'run', s.id, ...passthrough], { env: process.env, stdio: ['ignore', fd, fd] })
    console.log(`${stamp()} started ${s.id}. ${s.name}  (log: ${log})`)
    child.on('exit', (code) => {
      fs.closeSync(fd)
      finished.add(s.id)
      console.log(`${stamp()} finished ${s.id}. ${s.name} (exit ${code})`)
      resolve(code)
    })
  })

  // Cloud setups can all run at once. Local setups share one GPU and its memory, so they go one after the other,
  // beside the cloud ones. Without --parallel everything goes one after the other.
  const cloudOnly = setups.filter((s) => !usesLocal(s))
  const localOnes = setups.filter(usesLocal)
  const inSequence = async (list) => {
    const codes = []
    for (const s of list) codes.push(await launch(s))
    return codes
  }
  const inBatches = async (list, size) => {
    const codes = []
    const queue = [...list]
    await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
      while (queue.length) codes.push(await launch(queue.shift()))
    }))
    return codes
  }
  if (flag('parallel')) {
    console.log('Running at the same time: cloud setups together, local setups one by one beside them.')
    console.log('They share this laptop, so compare scores and cost first. Time is only fair for runs done one at a time.\n')
  }
  const ticker = setInterval(() => {
    const waiting = setups.filter((s) => !finished.has(s.id)).map((s) => s.id)
    if (waiting.length) console.log(`${stamp()} still running: ${waiting.join(', ')}`)
  }, 60000)
  const codes = flag('parallel')
    ? (await Promise.all([inBatches(cloudOnly, Number(option('max-cloud', cloudOnly.length || 1))), inSequence(localOnes)])).flat()
    : await inSequence(setups)
  clearInterval(ticker)
  printTable(loadRuns())
  const out = path.join(root, 'report.html')
  fs.writeFileSync(out, buildReport(loadRuns(), { task, config, models: Object.keys(config.models).map(modelFor) }))
  console.log(`\nReport: ${out}`)
  process.exit(codes.every((c) => c === 0) ? 0 : 1)
} else if (command === 'report') {
  const runs = loadRuns()
  if (runs.length === 0) fail(`no results for ${task} in ${path.join(root, 'runs')}. Run a setup first.`)
  const out = path.join(root, 'report.html')
  fs.writeFileSync(out, buildReport(runs, { task, config, models: Object.keys(config.models).map(modelFor) }))
  printTable(runs)
  console.log(`\nReport: ${out}`)
  if (flag('open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
    spawnSync(opener, [out], { stdio: 'ignore', shell: process.platform === 'win32' })
  }
} else {
  console.log('commands: setups | mission | run <1-7> | run-all [--only 1,3] [--parallel] | report [--open]')
}
