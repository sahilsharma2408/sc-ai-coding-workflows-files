#!/usr/bin/env node
// Task-type lab: gives a model an existing repo and one job, then scores the result.
//
//   node lab/lab.mjs list
//   node lab/lab.mjs prepare <task> <dir>                 make a working folder for a model
//   node lab/lab.mjs score <task> <dir> [--name N] [--violations reports/N.run.json] [--verbose]
//   node lab/lab.mjs validate [task...]                   check a solved copy scores ~100 and an untouched one scores low
//   node lab/lab.mjs matrix <name...>                     table of lab reports, grouped by task type
//
// Score (100): task tests 60 and regression 25, each curved (share passed ^ 3), plus hygiene 15
// (type check 5, build 4, change scope 4, existing tests kept 2). Caps: build fails 60, run rule broken 50.
// A task with a custom scorer (code review) is scored 0 to 100 by that scorer alone.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LAB = path.dirname(fileURLToPath(import.meta.url))
const BENCH = path.resolve(LAB, '..')
const WORK = path.join(BENCH, '.work', 'lab')
const REPORTS = path.join(BENCH, 'reports')
const VITEST = path.join(BENCH, 'node_modules', 'vitest', 'vitest.mjs')
const VITE = path.join(BENCH, 'node_modules', 'vite', 'bin', 'vite.js')
const TSC = path.join(BENCH, 'node_modules', 'typescript', 'bin', 'tsc')
const TZ = 'America/Los_Angeles'
const CURVE = 3
const POINTS = { task: 60, regression: 25, tsc: 5, build: 4, scope: 4, testsKept: 2 }
const CAPS = { build: 60, rules: 50 }

const args = process.argv.slice(2)
const command = args[0]
const flag = (n) => args.includes(`--${n}`)
const option = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('--') && !(i > 0 && all[i - 1].startsWith('--') && ['name', 'violations'].includes(all[i - 1].slice(2))))

// ---------------------------------------------------------------- helpers
const skip = /(^|\/)(node_modules|dist|\.git|coverage)(\/|$)/
function copyTree(from, to) {
  fs.rmSync(to, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.cpSync(from, to, { recursive: true, filter: (p) => !skip.test(p) })
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    if (skip.test(full)) return []
    return e.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join('/')]
  })
}
function run(cmd, cmdArgs, { cwd = BENCH, env = {}, timeout = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd, env: { ...process.env, TZ, FORCE_COLOR: '0', ...env } })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'))
  } catch {
    return null
  }
}
async function vitest(target, include, label, setup) {
  const json = path.join(WORK, '_json', `${label}-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  fs.mkdirSync(path.dirname(json), { recursive: true })
  const env = { TASKBOARD_TARGET: target, LAB_INCLUDE: JSON.stringify(include) }
  if (setup) env.LAB_SETUP = setup
  const result = await run(process.execPath, [VITEST, 'run', '--config', path.join(LAB, 'vitest.lab.config.ts'), '--reporter=json', `--outputFile=${json}`], { env })
  const report = readJson(json)
  fs.rmSync(json, { force: true })
  const tests = new Map()
  for (const f of report?.testResults ?? []) for (const t of f.assertionResults ?? []) tests.set(t.fullName, t.status)
  return { tests, crashed: report === null, output: result.output }
}

// ---------------------------------------------------------------- tasks
const taskDirs = () => fs.readdirSync(path.join(LAB, 'tasks')).filter((d) => fs.existsSync(path.join(LAB, 'tasks', d, 'meta.json')))
function loadTask(id) {
  const dir = path.join(LAB, 'tasks', id)
  if (!fs.existsSync(path.join(dir, 'meta.json'))) {
    console.error(`unknown task "${id}". Tasks: ${taskDirs().join(', ')}`)
    process.exit(2)
  }
  return { id, dir, meta: readJson(path.join(dir, 'meta.json')) }
}
async function hook(task, file) {
  const f = path.join(task.dir, file)
  return fs.existsSync(f) ? import(pathToFileURL(f).href) : null
}

async function prepare(task, dir) {
  copyTree(path.join(LAB, 'baseline'), dir)
  const prep = await hook(task, 'prepare.mjs')
  if (prep) await prep.prepare(dir)
  const rules = fs.readFileSync(path.join(LAB, 'RULES.md'), 'utf8')
  fs.writeFileSync(path.join(dir, 'TASK.md'), `${fs.readFileSync(path.join(task.dir, 'task.md'), 'utf8').trim()}\n\n${rules}`)
}

async function regressionSuite(task) {
  const gen = await hook(task, 'regression.mjs')
  if (!gen) return { include: ['tests/behavior/**/*.spec.{ts,tsx}', 'tests/static/**/*.spec.{ts,tsx}'], setup: undefined }
  const out = path.join(LAB, '.gen', task.id)
  fs.rmSync(out, { recursive: true, force: true })
  fs.cpSync(path.join(BENCH, 'tests'), path.join(out, 'tests'), { recursive: true })
  await gen.generate(path.join(out, 'tests'))
  const rel = path.relative(BENCH, path.join(out, 'tests')).split(path.sep).join('/')
  return { include: [`${rel}/behavior/**/*.spec.{ts,tsx}`, `${rel}/static/**/*.spec.{ts,tsx}`], setup: `./${rel}/support/setup.ts` }
}

function changedFiles(before, after) {
  const a = new Map(listFiles(before).map((f) => [f, fs.readFileSync(path.join(before, f))]))
  const b = new Map(listFiles(after).map((f) => [f, fs.readFileSync(path.join(after, f))]))
  const changed = []
  for (const [f, buf] of b) if (!a.has(f) || !a.get(f).equals(buf)) changed.push(f)
  for (const f of a.keys()) if (!b.has(f)) changed.push(f)
  return { changed, before: a, after: b }
}
const isTestPath = (f) => /\.(test|spec)\.[tj]sx?$/.test(f) || /(^|\/)(test|tests|__tests__)\//.test(f) || f === 'TASK.md' || f === 'MISSION.md' || f === 'review.json'
const countTests = (files) => [...files].reduce((n, [f, buf]) => n + (/\.test\.[tj]sx?$/.test(f) ? (buf.toString().match(/\b(it|test)\s*\(/g) ?? []).length : 0), 0)

async function scoreTask(task, workdir, name, { regression: doRegression = true } = {}) {
  const work = path.join(WORK, `run-${name}`)
  copyTree(workdir, work)
  const notes = []
  const custom = await hook(task, 'score.mjs')
  if (custom) {
    const result = await custom.scoreTask(work, { bench: BENCH })
    return { total: result.score, parts: result.parts, notes: [...notes, ...(result.notes ?? [])], caps: [], custom: true }
  }
  // 1. task tests
  const manifest = readJson(path.join(task.dir, 'manifest.json')) ?? []
  const taskRun = await vitest(work, [`lab/tasks/${task.id}/tests/**/*.spec.{ts,tsx}`], `task-${name}`)
  const weightOf = (title) => Number(/^\[LAB (\d+)\]/.exec(title)?.[1] ?? 1)
  const titles = manifest.length > 0 ? manifest : [...taskRun.tests.keys()]
  const totalW = titles.reduce((s, t) => s + weightOf(t), 0)
  const passedW = titles.reduce((s, t) => s + (taskRun.tests.get(t) === 'passed' ? weightOf(t) : 0), 0)
  const taskRatio = totalW === 0 ? 0 : passedW / totalW
  const failingTask = titles.filter((t) => taskRun.tests.get(t) !== 'passed')
  // 2. regression
  let regRatio = 1
  let failingReg = []
  if (doRegression) {
    const expected = readJson(path.join(task.dir, 'regression.json')) ?? []
    const suite = await regressionSuite(task)
    const reg = await vitest(work, suite.include, `reg-${name}`, suite.setup)
    failingReg = expected.filter((t) => reg.tests.get(t) !== 'passed')
    regRatio = expected.length === 0 ? 0 : 1 - failingReg.length / expected.length
    if (reg.crashed) notes.push('regression suite crashed')
  }
  // 3. hygiene
  const tsc = await run(process.execPath, [TSC, '-p', path.join(work, 'tsconfig.json'), '--noEmit', '--pretty', 'false'])
  const tscErrors = tsc.output.split('\n').filter((l) => /error TS/.test(l) && !/TS2882: .*\.css'/.test(l))
  const build = await run(process.execPath, [VITE, 'build', work, '--outDir', path.join(work, 'dist')], { timeout: 120000 })
  const prepared = path.join(WORK, `${name}-prepared`)
  await prepare(task, prepared)
  const diff = changedFiles(prepared, work)
  const allowed = (task.meta.allowedFiles ?? []).map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*')}$`))
  const outside = task.meta.allowedFiles
    ? diff.changed.filter((f) => !isTestPath(f) && !allowed.some((re) => re.test(f)))
    : []
  const deletedTests = [...diff.before.keys()].filter((f) => /\.test\.[tj]sx?$/.test(f) && !diff.after.has(f))
  const keptRatio = countTests(diff.before) === 0 ? 1 : Math.min(1, countTests(diff.after) / countTests(diff.before))
  const parts = {
    task: POINTS.task * taskRatio ** CURVE,
    regression: doRegression ? POINTS.regression * regRatio ** CURVE : 0,
    tsc: tscErrors.length === 0 ? POINTS.tsc : 0,
    build: build.code === 0 ? POINTS.build : 0,
    scope: POINTS.scope * Math.max(0, 1 - 0.34 * outside.length),
    testsKept: POINTS.testsKept * (keptRatio >= 0.9 && deletedTests.length === 0 ? 1 : keptRatio ** 2),
  }
  const max = POINTS.task + (doRegression ? POINTS.regression : 0) + POINTS.tsc + POINTS.build + POINTS.scope + POINTS.testsKept
  const raw = (Object.values(parts).reduce((s, v) => s + v, 0) / max) * 100
  const caps = []
  if (build.code !== 0) caps.push({ reason: 'vite build failed', limit: CAPS.build })
  const violations = option('violations', null) ? readJson(path.resolve(process.cwd(), option('violations')))?.violations ?? [] : []
  if (violations.length > 0) caps.push({ reason: `run rule broken: ${violations.join('; ')}`, limit: CAPS.rules })
  const total = caps.reduce((s, c) => Math.min(s, c.limit), raw)
  if (tscErrors.length) notes.push(`tsc errors:\n  ${tscErrors.slice(0, 5).join('\n  ')}`)
  if (outside.length) notes.push(`files changed outside the expected set: ${outside.join(', ')}`)
  if (deletedTests.length) notes.push(`deleted test files: ${deletedTests.join(', ')}`)
  if (failingTask.length) notes.push(`task tests failing:\n  - ${failingTask.map((t) => t.replace(/^\[LAB \d+\] /, '')).join('\n  - ')}`)
  if (failingReg.length) notes.push(`${failingReg.length} regression test(s) broke, e.g.:\n  - ${failingReg.slice(0, 6).join('\n  - ')}`)
  fs.rmSync(prepared, { recursive: true, force: true })
  fs.rmSync(path.join(work, 'dist'), { recursive: true, force: true })
  return { total, raw, parts, caps, notes, ratios: { task: taskRatio, regression: regRatio }, custom: false }
}

function printScore(task, name, r) {
  console.log(`\n${task.id} (${task.meta.type}) - ${name}`)
  for (const [k, v] of Object.entries(r.parts)) console.log(`  ${k.padEnd(12)} ${typeof v === 'number' ? v.toFixed(1) : v}`)
  if (r.caps?.length) {
    console.log(`  before caps  ${r.raw.toFixed(1)}`)
    for (const c of r.caps) console.log(`  CAP ${c.limit}: ${c.reason}`)
  }
  console.log(`  TOTAL ${r.total.toFixed(1)} / 100`)
  if (flag('verbose') || r.total < 100) for (const n of r.notes) console.log(`  ${n.replace(/\n/g, '\n  ')}`)
}
function saveReport(task, name, r) {
  fs.mkdirSync(REPORTS, { recursive: true })
  fs.writeFileSync(path.join(REPORTS, `${name}.json`), JSON.stringify({ lab: true, task: task.id, type: task.meta.type, name, score: Number(r.total.toFixed(2)), rawScore: Number((r.raw ?? r.total).toFixed(2)), parts: r.parts, caps: r.caps, notes: r.notes, date: new Date().toISOString() }, null, 2))
}

// ---------------------------------------------------------------- commands
if (command === 'list') {
  for (const id of taskDirs()) {
    const { meta } = loadTask(id)
    console.log(`${id.padEnd(22)} ${meta.type.padEnd(28)} ${meta.title}`)
  }
} else if (command === 'prepare') {
  const task = loadTask(positional[0])
  const dir = path.resolve(process.cwd(), positional[1])
  await prepare(task, dir)
  console.log(`prepared ${task.id} in ${dir}\nThe model gets TASK.md and the repository. Do not copy anything else in.`)
} else if (command === 'score') {
  const task = loadTask(positional[0])
  const dir = path.resolve(process.cwd(), positional[1])
  const name = option('name', `${task.id}-${path.basename(dir)}`).replace(/[^\w.-]/g, '_')
  const r = await scoreTask(task, dir, name)
  printScore(task, name, r)
  saveReport(task, name, r)
} else if (command === 'validate') {
  const ids = positional.length ? positional : taskDirs()
  let bad = 0
  for (const id of ids) {
    const task = loadTask(id)
    const solved = path.join(WORK, `validate-${id}-solved`)
    const untouched = path.join(WORK, `validate-${id}-untouched`)
    await prepare(task, solved)
    const solver = await hook(task, 'solve.mjs')
    await solver.solve(solved)
    await prepare(task, untouched)
    // Learn what the solved copy passes: that is the manifest and the regression set.
    if (!task.meta.custom) {
      const t = await vitest(solved, [`lab/tasks/${id}/tests/**/*.spec.{ts,tsx}`], `v-task-${id}`)
      fs.writeFileSync(path.join(task.dir, 'manifest.json'), JSON.stringify([...t.tests.keys()].sort(), null, 2) + '\n')
      const suite = await regressionSuite(task)
      const g = await vitest(solved, suite.include, `v-reg-${id}`, suite.setup)
      fs.writeFileSync(path.join(task.dir, 'regression.json'), JSON.stringify([...g.tests].filter(([, s]) => s === 'passed').map(([n]) => n).sort(), null, 2) + '\n')
    }
    const a = await scoreTask(task, solved, `validate-${id}-solved`)
    const b = await scoreTask(task, untouched, `validate-${id}-untouched`)
    const ok = a.total >= 97 && b.total <= 60
    if (!ok) bad += 1
    console.log(`${ok ? 'ok ' : 'BAD'} ${id.padEnd(22)} solved ${a.total.toFixed(1).padStart(5)}   untouched ${b.total.toFixed(1).padStart(5)}`)
    if (a.total < 97) for (const n of a.notes) console.log(`    solved: ${n.replace(/\n/g, '\n    ')}`)
    fs.rmSync(solved, { recursive: true, force: true })
    fs.rmSync(untouched, { recursive: true, force: true })
  }
  process.exit(bad ? 1 : 0)
} else if (command === 'matrix') {
  const rows = positional.map((n) => ({ n, s: readJson(path.join(REPORTS, `${n}.json`)), r: readJson(path.join(REPORTS, `${n}.run.json`)) }))
  console.log('Run'.padEnd(34) + 'Task type'.padEnd(30) + 'Score'.padEnd(8) + 'Cost'.padEnd(9) + 'Time'.padEnd(8) + 'Tokens')
  for (const { n, s, r } of rows) {
    console.log(n.padEnd(34) + (s?.type ?? (s?.categories ? 'greenfield build' : 'n/a')).padEnd(30) + (s ? s.score.toFixed(1) : 'n/a').padEnd(8) + (r ? `$${r.usd.toFixed(2)}` : 'n/a').padEnd(9) + (r ? `${(r.wallSeconds / 60).toFixed(1)}m` : 'n/a').padEnd(8) + (r ? `${(r.tokens.total / 1e6).toFixed(2)}M` : 'n/a'))
  }
} else if (command === 'pivot') {
  // Models in rows (grouped by tier), task types in columns.
  const files = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json') && !f.endsWith('.run.json')) : []
  const runs = files.map((f) => ({ score: readJson(path.join(REPORTS, f)), run: readJson(path.join(REPORTS, f.replace(/\.json$/, '.run.json'))) })).filter((r) => r.score?.lab && r.run)
  const tasks = taskDirs()
  const labels = Object.fromEntries(tasks.map((t) => [t, loadTask(t).meta.type]))
  const rows = new Map()
  for (const { score, run } of runs) {
    const key = `${run.tier ?? 'unknown'}|${run.modelLabel ?? run.name}`
    const row = rows.get(key) ?? { tier: run.tier ?? 'unknown', label: run.modelLabel ?? run.name, scores: {}, usd: 0, seconds: 0, tokens: 0, harness: run.harness }
    row.scores[score.task] = score.score
    row.usd += run.usd ?? 0
    row.seconds += run.wallSeconds ?? 0
    row.tokens += run.tokens?.total ?? 0
    rows.set(key, row)
  }
  const order = { frontier: 0, 'free-tier': 1, 'self-hosted': 2 }
  const sorted = [...rows.values()].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9) || a.label.localeCompare(b.label))
  const short = (t) => labels[t].replace(/,.*/, '').slice(0, 14).padEnd(15)
  console.log('Tier'.padEnd(12) + 'Model (harness)'.padEnd(36) + tasks.map(short).join('') + 'Avg'.padEnd(7) + 'Cost'.padEnd(9) + 'Time')
  for (const r of sorted) {
    const vals = tasks.map((t) => r.scores[t])
    const done = vals.filter((v) => v !== undefined)
    const avg = done.length ? (done.reduce((s, v) => s + v, 0) / done.length).toFixed(1) : 'n/a'
    console.log(r.tier.padEnd(12) + `${r.label} (${r.harness === 'lab-agent' ? 'lab agent' : 'claude code'})`.slice(0, 35).padEnd(36) + vals.map((v) => (v === undefined ? '-' : v.toFixed(1)).padEnd(15)).join('') + avg.padEnd(7) + `$${r.usd.toFixed(2)}`.padEnd(9) + `${(r.seconds / 60).toFixed(1)}m`)
  }
  console.log('\n"-" = not run. Scores out of 100. Cost is the total for the tasks that were run; free-tier and self-hosted models show $0 (self-hosted still costs hardware and time).')
} else {
  console.log('commands: list | prepare <task> <dir> | score <task> <dir> | validate [task...] | matrix <report...> | pivot')
}
fs.rmSync(path.join(WORK, '_json'), { recursive: true, force: true })
