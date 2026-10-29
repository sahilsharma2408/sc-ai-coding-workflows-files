#!/usr/bin/env node
// Workshop runner: one attendee, one task, one model at a time, with time and cost recorded.
//
//   node lab/workshop/ladder.mjs tasks
//   node lab/workshop/ladder.mjs start <task> --model <label>      make the folder, start the clock
//   node lab/workshop/ladder.mjs finish <task> --model <label>     stop the clock, score, record
//   node lab/workshop/ladder.mjs run <task> --model <label>        start, run the harness headless, finish (one command)
//   node lab/workshop/ladder.mjs run <task> --model <label> --local --id <name>   same, with a model on this laptop ("qwen3.5" finds "qwen3.5:35b-a3b")
//   node lab/workshop/ladder.mjs compare <task> --cloud flash --local <label> --local-id <name>   both at the same time
//   node lab/workshop/ladder.mjs table [--json]                    your results, models down, tasks across
//
// Local options: --base-url (default http://127.0.0.1:11434/v1), --context (tokens, default 32768), --timeout (minutes, default 30).
// Options: --root <dir> (default ~/task-board-ladder), --cost <usd> (finish: use this instead of the key's usage).
// Cost is the change in the usage of OPENROUTER_API_KEY between start and finish. If other people use the
// same key at the same time, the change is wrong: pass --cost with the figure from the OpenRouter activity page.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LAB = path.resolve(HERE, '..')
const BENCH = path.resolve(LAB, '..')
const LAB_CLI = path.join(LAB, 'lab.mjs')
const LADDER = [
  { id: 'fix-date-file', level: 'easy', what: 'one file, three bugs' },
  { id: 'debug-four-layers', level: 'medium', what: 'four bugs across four layers' },
  { id: 'labels-feature', level: 'hard', what: 'a feature across about 20 files' },
  { id: 'review-labels-pr', level: 'review', what: 'read a pull request, report 7 planted defects' },
]
const PROMPT = 'Read MISSION.md in this folder and carry out the mission. Follow its rules of the run.'

const args = process.argv.slice(2)
const command = args[0]
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const flag = (name) => args.includes(`--${name}`)
const taskId = args[1] && !args[1].startsWith('--') ? args[1] : undefined
const root = path.resolve(option('root', path.join(os.homedir(), 'task-board-ladder')))
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const fail = (message) => {
  console.error(message)
  process.exit(2)
}

function requireTask() {
  if (!taskId || !LADDER.some((t) => t.id === taskId)) fail(`give a task: ${LADDER.map((t) => t.id).join(', ')}`)
  const model = option('model')
  if (!model || !slug(model)) fail('give a model label, for example --model deepseek-v4-flash')
  const run = `${taskId}__${slug(model)}`
  return {
    model,
    run,
    dir: path.join(root, run),
    state: path.join(root, '.ladder', `${run}.json`),
  }
}

// The key comes from the environment (OPENROUTER_KEY works as well). If it is missing and this is a
// terminal, ask for it with the input hidden. It is kept in this process only and never written to disk.
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

// OpenRouter reports how much a key has spent. null means "could not read it".
async function keyUsage() {
  const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY
  if (!key) return null
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const usage = (await res.json())?.data?.usage
    return typeof usage === 'number' ? usage : null
  } catch {
    return null
  }
}

// Ollama reads a name with no tag as "<name>:latest", so "qwen3.5" misses "qwen3.5:35b-a3b". Ask the
// runtime what it serves and pick the one model the name stands for. Fails before any folder is made.
async function resolveLocalId(id, baseUrl) {
  let served
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    served = ((await res.json())?.data ?? []).map((m) => m.id).filter(Boolean)
  } catch (err) {
    fail(`could not reach the local runtime at ${baseUrl} (${err.message}). Is Ollama running? Try: ollama serve`)
  }
  if (served.includes(id)) return id
  const matches = served.filter((name) => name.split(':')[0] === id || name.startsWith(`${id}:`))
  if (matches.length === 1) {
    console.log(`Using ${matches[0]} for --id ${id}.`)
    return matches[0]
  }
  const list = (names) => names.map((n) => `  ${n}`).join('\n')
  if (matches.length > 1) fail(`--id ${id} matches more than one model. Pick one:\n${list(matches)}`)
  fail(`no model "${id}" at ${baseUrl}. ${served.length ? `It serves:\n${list(served)}` : 'It serves no models yet. Pull one first, e.g. ollama pull <name>'}`)
}

// MISSION.md is what the model is given: the task, the rules, what done means and how it is judged,
// in one file. It is filled in from mission.template.md, so speakers can edit the wording there.
function writeMission(task, dir) {
  const meta = readJson(path.join(LAB, 'tasks', task, 'meta.json'), {})
  const level = LADDER.find((t) => t.id === task)?.level ?? ''
  const taskText = fs.readFileSync(path.join(LAB, 'tasks', task, 'task.md'), 'utf8').replace(/^# .*\n+/, '').trim()
  const rules = fs.readFileSync(path.join(LAB, 'RULES.md'), 'utf8').trim()
  const review = meta.custom === true
  const done = review
    ? 'A file called `review.json` exists in the repository root with your findings, and no source file was edited.'
    : 'Everything the mission describes works as described. The code type-checks and builds. The tests that already exist still pass (you cannot run them, so read your changes with care). No tests were deleted, and no files were changed beyond what the mission needs.'
  const judging = review
    ? 'Your findings are compared with a hidden list of real defects. Each correct finding earns points and each false alarm costs points, so report only what you are confident about.'
    : 'Hidden tests check your work: the mission itself (60 of 100 points), the behaviour that already worked (25), and hygiene (15): type-check, build, staying in scope and keeping the existing tests. Each part is curved, so almost right earns much less than right. The tests are not in this folder.'
  const values = { title: meta.title ?? task, level, type: meta.type ?? '', task: taskText, rules, done, judging }
  const text = fs.readFileSync(path.join(HERE, 'mission.template.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '')
  fs.writeFileSync(path.join(dir, 'MISSION.md'), `${text.trim()}\n`)
  fs.rmSync(path.join(dir, 'TASK.md'), { force: true }) // one file to read, not two
}

// A fingerprint of every file in the folder except MISSION.md. If it has not changed when the run ends,
// the model changed nothing, and the score is just the score of an untouched folder.
function folderDigest(dir) {
  const hash = crypto.createHash('sha1')
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'dist', '.git'].includes(entry.name)) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name !== 'MISSION.md') hash.update(`${path.relative(dir, full)}\0`).update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

const results = () => readJson(path.join(root, 'results.json'), [])
const saveResults = (rows) => {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`)
}

if (command === 'tasks') {
  for (const t of LADDER) console.log(`${t.id.padEnd(20)} ${t.level.padEnd(8)} ${t.what}`)
} else if (command === 'start') {
  const { model, run, dir, state } = requireTask()
  if (!fs.existsSync(path.join(BENCH, 'node_modules', 'vitest'))) {
    fail(`the scorer is not installed. Run once:\n  cd ${BENCH} && npm install`)
  }
  if (fs.existsSync(dir) && !flag('again')) fail(`${dir} already exists. Use --again to start over, or pick another --model label.`)
  const prep = spawnSync(process.execPath, [LAB_CLI, 'prepare', taskId, dir], { encoding: 'utf8' })
  if (prep.status !== 0) fail(`could not prepare the task:\n${prep.stdout}${prep.stderr}`)
  writeMission(taskId, dir)
  const usage = await keyUsage()
  fs.mkdirSync(path.dirname(state), { recursive: true })
  fs.writeFileSync(state, JSON.stringify({ model, task: taskId, startedAt: Date.now(), usageStart: usage, digest: folderDigest(dir) }, null, 2))
  console.log(`Folder ready: ${dir}`)
  console.log(usage === null ? 'Cost tracking: off (no readable OPENROUTER_API_KEY). Pass --cost when you finish.' : 'Cost tracking: on.')
  console.log(`\n1. Open the harness in that folder and choose the model "${model}".`)
  console.log(`2. Send this prompt, once:\n\n   ${PROMPT}\n`)
  console.log(`3. When the model says it is done, run:\n   node ${path.relative(process.cwd(), path.join(HERE, 'ladder.mjs'))} finish ${taskId} --model ${model}`)
  console.log('\nThe clock has started.')
} else if (command === 'run') {
  // start, send the prompt through the harness (headless, one pass), then finish
  const { model } = requireTask()
  // --local runs a model served on this laptop (Ollama, LM Studio, llama.cpp). Cost is $0 in money.
  const local = flag('local')
  const known = { flash: 'deepseek/deepseek-v4-flash', pro: 'deepseek/deepseek-v4-pro' }
  let id = option('id', local ? undefined : known[slug(model)])
  if (!id) fail(local ? 'give the model name exactly as your runtime lists it: --id <name>' : `unknown label "${model}". Pass the OpenRouter model id: --id vendor/model-name`)
  const baseUrl = option('base-url', process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1')
  if (local) id = await resolveLocalId(id, baseUrl)
  if (!local && !(await ensureKey())) fail('no OpenRouter key. Export OPENROUTER_API_KEY, or run this in a terminal to be asked for it.')
  const minutes = Number(option('timeout', '30'))
  const self = [fileURLToPath(import.meta.url)]
  const common = [taskId, '--model', model, '--root', root]
  const stepOptions = flag('again') ? ['--again'] : []
  const inherit = { stdio: 'inherit' }
  if (spawnSync(process.execPath, [...self, 'start', ...common, ...stepOptions], inherit).status !== 0) process.exit(1)
  console.log(`\nRunning ${id} ${local ? 'on this laptop' : 'in the cloud'} through the harness. This can take several minutes (stops after ${minutes} min)...\n`)
  const env = { ...process.env, DSH_MODEL: id }
  if (local) {
    env.LOCAL_BASE_URL = baseUrl
    env.LOCAL_CONTEXT = option('context', process.env.LOCAL_CONTEXT ?? '32768')
    env.LOCAL_API_KEY = process.env.LOCAL_API_KEY ?? 'local'
  }
  const dsh = spawnSync(
    'npx',
    ['@deepseek-ai/dsh', '--profile', 'headless', '--patch', path.join(HERE, local ? 'local.patch.yml' : 'openrouter.patch.yml'), PROMPT],
    { cwd: path.join(root, `${taskId}__${slug(model)}`), env, stdio: ['ignore', 'inherit', 'inherit'], timeout: minutes * 60_000 },
  )
  if (dsh.error?.code === 'ETIMEDOUT') console.log(`\nStopped after ${minutes} minutes. Scoring what is in the folder anyway.`)
  else if (dsh.status !== 0) console.log(`\nThe harness exited with code ${dsh.status}. Scoring what is in the folder anyway.`)
  const costOption = option('cost') ? ['--cost', option('cost')] : local ? ['--cost', '0'] : []
  process.exit(spawnSync(process.execPath, [...self, 'finish', ...common, ...costOption], inherit).status ?? 1)
} else if (command === 'compare') {
  // One cloud model and one local model on the same task, at the same time.
  if (!taskId || !LADDER.some((t) => t.id === taskId)) fail(`give a task: ${LADDER.map((t) => t.id).join(', ')}`)
  const cloud = option('cloud')
  const localLabel = option('local')
  const localName = option('local-id')
  if (!cloud || !localLabel || !localName) fail('usage: compare <task> --cloud <label> --local <label> --local-id <model name> [--cloud-id vendor/model] [--base-url url] [--context n] [--timeout min] [--again]')
  if (slug(cloud) === slug(localLabel)) fail('the cloud label and the local label must be different')
  const baseUrl = option('base-url', process.env.LOCAL_BASE_URL ?? 'http://127.0.0.1:11434/v1')
  const resolved = await resolveLocalId(localName, baseUrl) // fail now, before the cloud run starts and spends money
  if (!(await ensureKey())) fail('no OpenRouter key. Export OPENROUTER_API_KEY, or run this in a terminal to be asked for it.')
  const self = fileURLToPath(import.meta.url)
  const shared = ['--root', root, ...(option('timeout') ? ['--timeout', option('timeout')] : []), ...(flag('again') ? ['--again'] : [])]
  const jobs = [
    { label: cloud, args: ['run', taskId, '--model', cloud, ...(option('cloud-id') ? ['--id', option('cloud-id')] : []), ...shared] },
    { label: localLabel, args: ['run', taskId, '--model', localLabel, '--local', '--id', resolved, '--base-url', baseUrl, ...(option('context') ? ['--context', option('context')] : []), ...shared] },
  ]
  fs.mkdirSync(path.join(root, '.ladder'), { recursive: true })
  const started = Date.now()
  const elapsed = () => `${Math.floor((Date.now() - started) / 60000)}m${String(Math.floor(((Date.now() - started) % 60000) / 1000)).padStart(2, '0')}s`
  console.log(`Running ${cloud} (cloud) and ${localLabel} (local) on ${taskId} at the same time.`)
  console.log('They share this laptop: the local model can be slower while the cloud run and the scoring use the CPU. Compare scores and cost first, time second.\n')
  const finished = new Set()
  const logs = jobs.map((job) => path.join(root, '.ladder', `${taskId}__${slug(job.label)}.log`))
  const children = jobs.map((job, i) => new Promise((resolve) => {
    const fd = fs.openSync(logs[i], 'w')
    const child = spawn(process.execPath, [self, ...job.args], { env: process.env, stdio: ['ignore', fd, fd] })
    child.on('exit', (code) => { fs.closeSync(fd); finished.add(job.label); console.log(`[${elapsed()}] ${job.label} finished (exit ${code})`); resolve(code) })
  }))
  const ticker = setInterval(() => {
    const waiting = jobs.filter((j) => !finished.has(j.label)).map((j) => j.label)
    if (waiting.length) console.log(`[${elapsed()}] still running: ${waiting.join(', ')}`)
  }, 30000)
  const codes = await Promise.all(children)
  clearInterval(ticker)
  console.log('')
  jobs.forEach((job, i) => {
    const text = fs.readFileSync(logs[i], 'utf8')
    const summary = text.split('\n').filter((l) => /^Time .*Score/.test(l)).pop()
    console.log(`${job.label}: ${summary ?? `no score. See ${logs[i]}`}`)
    if (codes[i] !== 0 && !summary) console.log(text.split('\n').slice(-12).join('\n'))
  })
  console.log('')
  spawnSync(process.execPath, [self, 'table', '--root', root], { stdio: 'inherit' })
  process.exit(codes.every((c) => c === 0) ? 0 : 1)
} else if (command === 'finish') {
  const { model, run, dir, state } = requireTask()
  const started = readJson(state, null)
  if (!started) fail(`no start found for ${run}. Run "start" first.`)
  if (!fs.existsSync(dir)) fail(`${dir} is missing`)
  const seconds = Math.round((Date.now() - started.startedAt) / 1000)
  const usageEnd = await keyUsage()
  const manual = option('cost')
  let cost = null
  if (manual !== undefined) cost = Number(manual)
  else if (started.usageStart !== null && usageEnd !== null) cost = Math.max(0, usageEnd - started.usageStart)
  console.log(`Scoring ${run} (about a minute)...`)
  const name = `ladder-${run}`
  const score = spawnSync(process.execPath, [LAB_CLI, 'score', taskId, dir, '--name', name], { encoding: 'utf8' })
  console.log(score.stdout.trim())
  const report = readJson(path.join(BENCH, 'reports', `${name}.json`), null)
  if (!report) fail(`scoring failed:\n${score.stderr}`)
  const changed = started.digest ? folderDigest(dir) !== started.digest : null // null: started with an older version
  const row = { task: taskId, model, score: report.score, seconds, cost, changed, date: new Date().toISOString() }
  saveResults([...results().filter((r) => !(r.task === taskId && r.model === model)), row])
  console.log(`\nTime ${(seconds / 60).toFixed(1)} min   Cost ${cost === null ? 'unknown' : `$${cost.toFixed(4)}`}   Score ${report.score.toFixed(1)} / 100`)
  if (changed === false) console.log('\nWARNING: the model changed no files. This score is the score of an untouched folder, so the run did not work.\nCommon causes: a model without tool-call support, a model that reasons aloud (a "thinking" model) on the local route, a context window that is too small, or a harness error. Read the log above.')
  if (cost === null) console.log('Cost is unknown. Re-run finish with --cost <usd> from the OpenRouter activity page.')
  if (cost === 0 && manual === undefined) console.log('Cost came out as $0. That is right for a local model. For a cloud model, check the OpenRouter activity page.')
} else if (command === 'table') {
  const rows = results()
  if (flag('json')) {
    console.log(JSON.stringify(rows, null, 2))
  } else if (rows.length === 0) {
    console.log('no results yet')
  } else {
    const models = [...new Set(rows.map((r) => r.model))]
    const cols = LADDER.filter((t) => rows.some((r) => r.task === t.id))
    console.log('Model'.padEnd(26) + cols.map((t) => `${t.level}`.padEnd(10)).join('') + 'Cost'.padEnd(10) + 'Time')
    for (const model of models) {
      const mine = rows.filter((r) => r.model === model)
      const cell = (t) => {
        const r = mine.find((x) => x.task === t.id)
        return (r ? `${r.score.toFixed(1)}${r.changed === false ? '!' : ''}` : '-').padEnd(10)
      }
      const costs = mine.map((r) => r.cost)
      const total = costs.some((c) => c === null) ? '?' : `$${costs.reduce((s, c) => s + c, 0).toFixed(3)}`
      console.log(model.slice(0, 25).padEnd(26) + cols.map(cell).join('') + total.padEnd(10) + `${(mine.reduce((s, r) => s + r.seconds, 0) / 60).toFixed(1)}m`)
    }
    console.log('\n"-" = not run. Scores are out of 100. Cost "?" means a run has no cost recorded.')
    if (rows.some((r) => r.changed === false)) console.log('"!" = the model changed no files, so that score is only the untouched-folder score. The run did not work.')
  }
} else {
  console.log('commands: tasks | start <task> --model <label> | finish <task> --model <label> | table')
}
