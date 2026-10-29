// What a finished run used: turns, tool calls, tokens, sub-agents and cost.
//
// DeepSeek harness runs: every model reply in the harness's session log carries its token counts, the model
// and OpenRouter's generation id. Cost comes from OpenRouter's generation records, which hold the amount
// actually charged for each reply. That is exact, and it does not depend on the key, so several runs can share
// one key at the same time. (The key's own "usage" total lags by a few seconds, so it under-counts.)
//
// Claude Code runs: the stream-json output holds the same figures, and the final "result" line has the cost.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const blank = () => ({ turns: 0, toolCalls: 0, edits: 0, shell: 0, input: 0, output: 0, cacheRead: 0, cost: 0 })
const EDIT_TOOLS = /^(edit|write|multi_?edit|apply_patch|replace|str_replace.*|notebook_?edit)$/i
const SHELL_TOOLS = /^(bash|shell|pwsh|powershell|run_command)$/i
const SPAWN_TOOLS = /^(subagent|subagent_fork|task|agent)$/i

const dshHome = () => process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')

// The harness keeps one folder of sessions per working directory, named after the path.
function sessionDir(cwd) {
  const real = fs.realpathSync(cwd)
  const root = path.join(dshHome(), 'sessions')
  const exact = path.join(root, `--${real.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`)
  if (fs.existsSync(exact)) return exact
  if (!fs.existsSync(root)) return null
  const tail = `-${path.basename(real)}--`
  const hit = fs.readdirSync(root).find((d) => d.endsWith(tail))
  return hit ? path.join(root, hit) : null
}

function findSessionFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findSessionFiles(full, found)
    else if (entry.name === 'session.v4.jsonl.zstd') found.push(full)
  }
  return found
}

// The harness appends one zstd frame per write. Node 22 decodes only the first frame of a buffer, so cut the
// buffer at each frame's magic number and decode the pieces. A cut that lands inside compressed data fails to
// decode, so that piece is joined to the next one and tried again.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
function decompressFrames(buffer) {
  const starts = []
  for (let i = buffer.indexOf(ZSTD_MAGIC); i !== -1; i = buffer.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i)
  if (starts.length <= 1) return zlib.zstdDecompressSync(buffer).toString()
  let text = ''
  let from = starts[0]
  for (let k = 1; k <= starts.length; k += 1) {
    const to = starts[k] ?? buffer.length
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(from, to)).toString()
      from = to
    } catch (err) {
      if (to === buffer.length) throw err
    }
  }
  return text
}

function readSession(file) {
  if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('this needs Node 22.15 or newer to read the harness session logs')
  const events = decompressFrames(fs.readFileSync(file)).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const head = events.find((e) => e.type === 'session')?.data ?? events[0] ?? {}
  return { file, id: head.id ?? path.basename(path.dirname(file)), depth: head.delegationDepth ?? 0, events }
}

// Sums a run's sessions by role: the main agent (depth 0) and its sub-agents (anything deeper).
export function summarizeDsh(cwd) {
  const dir = sessionDir(cwd)
  if (!dir) return null
  const files = findSessionFiles(dir)
  if (files.length === 0) return null
  const roles = { orchestrator: blank(), subagents: blank() }
  const perModel = {}
  const generations = []
  const toolNames = {}
  let spawnCalls = 0
  let childSessions = 0
  for (const session of files.map(readSession)) {
    const role = session.depth === 0 ? 'orchestrator' : 'subagents'
    if (role === 'subagents') childSessions += 1
    for (const event of session.events) {
      if (event.type === 'assistant/message' && event.data?.usage) {
        const u = event.data.usage
        const source = event.data.message?.source ?? {}
        const model = source.model ?? 'unknown'
        const r = roles[role]
        r.turns += 1
        r.input += u.inputTokens ?? 0
        r.output += u.outputTokens ?? 0
        r.cacheRead += u.cacheReadTokens ?? 0
        const m = (perModel[model] ??= { ...blank(), provider: source.provider ?? '' })
        m.turns += 1
        m.input += u.inputTokens ?? 0
        m.output += u.outputTokens ?? 0
        m.cacheRead += u.cacheReadTokens ?? 0
        const id = source.replayState?.response?.responseId
        if (source.provider === 'openrouter' && id) generations.push({ id, role, model })
      } else if (event.type === 'tool/call') {
        const name = event.data?.name ?? ''
        const r = roles[role]
        r.toolCalls += 1
        toolNames[name] = (toolNames[name] ?? 0) + 1
        if (EDIT_TOOLS.test(name)) r.edits += 1
        if (SHELL_TOOLS.test(name)) r.shell += 1
        if (SPAWN_TOOLS.test(name) && role === 'orchestrator') spawnCalls += 1
      }
    }
  }
  return { roles, perModel, generations, toolNames, spawned: Math.max(spawnCalls, childSessions), sessions: files.length }
}

// The charge OpenRouter made for each reply. Records can take a few seconds to appear, so retry.
export async function openRouterCosts(generations, key) {
  const costs = new Map()
  const fetchOne = async (id) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const res = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(15000),
        })
        if (res.ok) {
          const data = (await res.json())?.data
          const value = Number(data?.total_cost ?? data?.usage)
          if (Number.isFinite(value)) return value
        }
      } catch {
        // try again
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    }
    return null
  }
  const queue = [...generations]
  const worker = async () => {
    while (queue.length > 0) {
      const g = queue.shift()
      costs.set(g.id, await fetchOne(g.id))
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return costs
}

// A rough cost from list prices, for when the exact records cannot be read.
async function estimateCost(perModel) {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15000) })
    const list = (await res.json()).data
    let total = 0
    for (const [model, m] of Object.entries(perModel)) {
      const p = list.find((x) => x.id === model)?.pricing
      if (!p) continue
      total += m.input * Number(p.prompt) + m.output * Number(p.completion) + m.cacheRead * Number(p.input_cache_read ?? p.prompt)
    }
    return total
  } catch {
    return null
  }
}

// Fills in costs by role and in total. Returns { total, method }.
export async function priceDsh(summary, key) {
  if (summary.generations.length === 0) return { total: 0, method: 'no cloud calls (local models cost nothing in money)' }
  if (key) {
    const costs = await openRouterCosts(summary.generations, key)
    const missing = [...costs.values()].filter((v) => v === null).length
    if (missing === 0) {
      let total = 0
      for (const g of summary.generations) {
        const value = costs.get(g.id)
        summary.roles[g.role].cost += value
        summary.perModel[g.model].cost += value
        total += value
      }
      return { total, method: 'exact, from OpenRouter generation records' }
    }
  }
  const estimate = await estimateCost(Object.fromEntries(Object.entries(summary.perModel).filter(([, m]) => m.provider === 'openrouter')))
  return { total: estimate, method: 'estimate from list prices (OpenRouter records were not readable)' }
}

// Claude Code, from its stream-json output (one JSON object per line).
export function summarizeClaude(lines) {
  const roles = { orchestrator: blank(), subagents: blank() }
  const perModel = {}
  const seen = new Map()
  const toolNames = {}
  let result = null
  let spawnCalls = 0
  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'result') result = event
    if (event.type !== 'assistant' || !event.message) continue
    const role = event.parent_tool_use_id ? 'subagents' : 'orchestrator'
    const id = event.message.id ?? `${seen.size}`
    const u = event.message.usage ?? {}
    const entry = seen.get(id) ?? { role, model: event.message.model ?? 'unknown', input: 0, output: 0, cacheRead: 0, tools: [] }
    entry.input = Math.max(entry.input, (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0))
    entry.output = Math.max(entry.output, u.output_tokens ?? 0)
    entry.cacheRead = Math.max(entry.cacheRead, u.cache_read_input_tokens ?? 0)
    for (const block of event.message.content ?? []) if (block.type === 'tool_use' && !entry.tools.some((t) => t.id === block.id)) entry.tools.push({ id: block.id, name: block.name })
    seen.set(id, entry)
  }
  for (const entry of seen.values()) {
    const r = roles[entry.role]
    r.turns += 1
    r.input += entry.input
    r.output += entry.output
    r.cacheRead += entry.cacheRead
    const m = (perModel[entry.model] ??= { ...blank(), provider: 'anthropic' })
    m.turns += 1
    m.input += entry.input
    m.output += entry.output
    m.cacheRead += entry.cacheRead
    for (const tool of entry.tools) {
      r.toolCalls += 1
      toolNames[tool.name] = (toolNames[tool.name] ?? 0) + 1
      if (EDIT_TOOLS.test(tool.name)) r.edits += 1
      if (SHELL_TOOLS.test(tool.name)) r.shell += 1
      if (SPAWN_TOOLS.test(tool.name) && entry.role === 'orchestrator') spawnCalls += 1
    }
  }
  const modelUsage = result?.modelUsage ?? {}
  for (const [model, usage] of Object.entries(modelUsage)) {
    const key = Object.keys(perModel).find((k) => k === model || k.startsWith(model) || model.startsWith(k))
    if (key) perModel[key].cost = usage.costUSD ?? 0
  }
  for (const entry of seen.values()) roles[entry.role].cost = 0
  for (const [model, m] of Object.entries(perModel)) {
    const modelTurns = [...seen.values()].filter((e) => e.model === model)
    const owners = new Set(modelTurns.map((e) => e.role))
    if (owners.size === 1) roles[[...owners][0]].cost += m.cost
  }
  const spawned = result?.subagent_stats?.spawned ?? spawnCalls
  return {
    roles,
    perModel,
    toolNames,
    spawned,
    seconds: result?.duration_ms ? result.duration_ms / 1000 : null,
    cost: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null,
    turns: result?.num_turns ?? null,
    isError: result?.is_error === true,
    resultText: typeof result?.result === 'string' ? result.result.slice(0, 600) : '',
  }
}
