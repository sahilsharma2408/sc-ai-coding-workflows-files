// Tests for the benchmark pieces that need no network, no keys and no models.
// Run with: node --test test/bench.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildReport } from '../bench/task-board/lab/workshop/report.mjs';
import { summarizeClaude } from '../bench/task-board/lab/workshop/usage.mjs';

const config = JSON.parse(readFileSync(fileURLToPath(new URL('../bench/task-board/lab/workshop/setups.json', import.meta.url)), 'utf8'));

describe('setups.json', () => {
  test('has seven setups with unique ids and slugs', () => {
    assert.equal(config.setups.length, 7);
    assert.equal(new Set(config.setups.map((s) => s.id)).size, 7);
    assert.equal(new Set(config.setups.map((s) => s.slug)).size, 7);
  });

  test('every setup names models that exist, and uses one agent for both roles', () => {
    for (const s of config.setups) {
      const main = config.models[s.orchestrator];
      assert.ok(main, `${s.id}: unknown main model ${s.orchestrator}`);
      if (s.subagent) assert.ok(config.models[s.subagent], `${s.id}: unknown sub-agent model ${s.subagent}`);
      if (s.agent === 'claude') {
        assert.equal(main.agent, 'claude');
        if (s.subagent) assert.equal(config.models[s.subagent].agent, 'claude');
      } else {
        assert.equal(main.agent, 'dsh');
      }
    }
  });

  test('the seven setups are the ones the workshop describes', () => {
    const shape = config.setups.map((s) => `${s.orchestrator}${s.subagent ? `>${s.subagent}` : ''}`);
    assert.deepEqual(shape, ['sonnet', 'sonnet>haiku', 'deepseek-pro', 'deepseek-pro>deepseek-flash', 'deepseek-flash>gemma', 'qwen', 'qwen>gemma']);
  });
});

describe('summarizeClaude', () => {
  const line = (o) => JSON.stringify(o);
  const lines = [
    line({ type: 'system', subtype: 'init' }),
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Agent' }] } }),
    // the same message repeated once per content block must be counted once
    line({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'tool_use', id: 't1', name: 'Agent' }] } }),
    line({ type: 'assistant', parent_tool_use_id: 't1', message: { id: 'm2', model: 'claude-haiku-5-5', usage: { input_tokens: 7, output_tokens: 3 }, content: [{ type: 'tool_use', id: 't2', name: 'Edit' }, { type: 'tool_use', id: 't3', name: 'Write' }] } }),
    line({ type: 'result', total_cost_usd: 0.1234, num_turns: 3, duration_ms: 42000, subagent_stats: { spawned: 1 },
      modelUsage: { 'claude-sonnet-5-5': { costUSD: 0.12 }, 'claude-haiku-5-5': { costUSD: 0.0034 } }, result: 'done' }),
    'not json',
  ];
  const u = summarizeClaude(lines);

  test('splits turns, tool calls and edits between the main agent and sub-agents', () => {
    assert.deepEqual([u.roles.orchestrator.turns, u.roles.subagents.turns], [1, 1]);
    assert.deepEqual([u.roles.orchestrator.toolCalls, u.roles.subagents.toolCalls], [1, 2]);
    assert.deepEqual([u.roles.orchestrator.edits, u.roles.subagents.edits], [0, 2]);
    assert.equal(u.spawned, 1);
  });

  test('adds up tokens once per message, and reports the cost per model and in total', () => {
    assert.equal(u.roles.orchestrator.input, 10);
    assert.equal(u.roles.orchestrator.cacheRead, 100);
    assert.equal(u.cost, 0.1234);
    assert.equal(u.perModel['claude-haiku-5-5'].cost, 0.0034);
    assert.equal(u.roles.subagents.cost, 0.0034);
  });
});

describe('buildReport', () => {
  const run = (over) => ({
    setup: '1', slug: 's1-sonnet', name: 'Sonnet alone', task: 'labels-feature', agent: 'Claude Code',
    orchestrator: { key: 'sonnet', model: 'sonnet', label: 'Claude Sonnet', source: 'anthropic' }, subagent: null,
    score: 91.5, parts: { task: 55, regression: 25 }, notes: [], changed: true, seconds: 125, cost: 0.4321, costMethod: 'exact',
    turns: { orchestrator: 10, subagents: 0 }, toolCalls: { orchestrator: 20, subagents: 0 }, edits: { orchestrator: 8, subagents: 0 },
    tokens: { orchestrator: { input: 1000, output: 500, cacheRead: 9000 }, subagents: { input: 0, output: 0, cacheRead: 0 }, total: 10500 },
    perModel: {}, subagentsStarted: 0, ruleCheck: { ok: true, problems: [] }, timedOut: false, date: '2026-10-29T10:00:00Z', ...over,
  });

  test('shows finished setups, marks the others as not run, and flags rule problems', () => {
    const html = buildReport([run({}), run({ setup: '2', slug: 's2-sonnet-haiku', name: 'Sonnet orchestrates, Haiku implements', ruleCheck: { ok: false, problems: ['the orchestrator edited files itself'] } })], { task: 'labels-feature', config, models: [] });
    assert.match(html, /Sonnet alone/);
    assert.match(html, /91\.5/);
    assert.match(html, /\$0\.43/);
    assert.match(html, /2:05/);
    assert.equal((html.match(/not run/g) ?? []).length >= 5, true);
    assert.match(html, /1 problem/);
    assert.match(html, /the orchestrator edited files itself/);
  });

  test('escapes text that comes from run records', () => {
    const html = buildReport([run({ name: '<script>alert(1)</script>' })], { task: 'labels-feature', config, models: [] });
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.match(html, /&lt;script&gt;/);
  });

  test('builds with no runs at all', () => {
    assert.match(buildReport([], { task: 'labels-feature', config, models: [] }), /No results yet/);
  });
});
