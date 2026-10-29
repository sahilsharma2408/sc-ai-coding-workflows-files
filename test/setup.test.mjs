// Tests for setup.mjs. Run with: node --test test/setup.test.mjs
// Integration tests run the real script against a temp HOME, a stubbed `claude`
// and a fake OpenRouter server, so they need no network and no real keys.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { nodeSupported, parseArgs, parseVersion } from '../setup.mjs';

const SCRIPT = fileURLToPath(new URL('../setup.mjs', import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'stubs are shell scripts' : false };

describe('parseVersion and nodeSupported', () => {
  test('parses versions', () => {
    assert.deepEqual(parseVersion('v22.12.0'), [22, 12, 0]);
    assert.deepEqual(parseVersion('2.1.311 (Claude Code)'), [2, 1, 311]);
    assert.equal(parseVersion('nope'), null);
  });

  test('accepts the Node versions the workshop stack supports', () => {
    for (const v of ['v22.22.2', 'v22.23.4', 'v24.15.0', 'v24.22.1', 'v26.1.0']) {
      assert.ok(nodeSupported(parseVersion(v)), v);
    }
    for (const v of ['v18.20.0', 'v20.19.0', 'v21.7.0', 'v22.12.0', 'v23.0.0', 'v24.14.0', 'v25.1.0', 'v27.0.0']) {
      assert.ok(!nodeSupported(parseVersion(v)), v);
    }
  });
});

describe('parseArgs', () => {
  test('everything is off by default', () => {
    const opts = parseArgs([]);
    assert.deepEqual([opts.check, opts.yes, opts.skipHarness, opts.skipBench], [false, false, false, false]);
  });

  test('reads every flag', () => {
    const opts = parseArgs(['--check', '-y', '--skip-harness', '--skip-bench', '--no-color']);
    assert.deepEqual([opts.check, opts.yes, opts.skipHarness, opts.skipBench, opts.color], [true, true, true, true, false]);
  });

  test('rejects unknown flags, including the removed project and demo flags', () => {
    assert.throws(() => parseArgs(['--nope']), /Unknown option/);
    assert.throws(() => parseArgs(['--project', 'x']), /Unknown option/);
    assert.throws(() => parseArgs(['--skip-demo']), /Unknown option/);
  });
});

// ---------- integration ----------

let fakeOpenRouter;
let apiBase;
const KEYS = {
  'sk-or-good': { limit_remaining: 9.5 },
  'sk-or-low': { limit_remaining: 0.4 },
  'sk-or-unlimited': { limit_remaining: null },
};

before(async () => {
  fakeOpenRouter = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-pro' }, { id: 'deepseek/deepseek-v4-flash' }] }));
    } else if (req.url === '/api/v1/key') {
      const key = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (KEYS[key]) res.end(JSON.stringify({ data: KEYS[key] }));
      else { res.statusCode = 401; res.end(JSON.stringify({ error: { message: 'No auth credentials found' } })); }
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => fakeOpenRouter.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${fakeOpenRouter.address().port}/api/v1`;
});

after(() => fakeOpenRouter.close());

// PATH without any real `claude`, plus an optional stub that reports a sign-in state.
function makeEnv({ claude, gitIdentity = true, extra = {} } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'setup-home-'));
  const bin = path.join(home, 'stub-bin');
  mkdirSync(bin);
  const hostPath = (process.env.PATH ?? '').split(path.delimiter)
    .filter((dir) => dir && !existsSync(path.join(dir, 'claude')));
  if (claude) {
    const status = JSON.stringify({ loggedIn: claude === 'logged-in', authMethod: 'claude.ai' });
    writeFileSync(path.join(bin, 'claude'),
      `#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9 (Claude Code)";;\n  auth) echo '${status}';;\nesac\n`);
    chmodSync(path.join(bin, 'claude'), 0o755);
  }
  if (gitIdentity) {
    writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = Test Person\n\temail = test@example.com\n');
  }
  const env = {
    PATH: [bin, ...hostPath].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    NO_COLOR: '1',
    WORKSHOP_OPENROUTER_API: apiBase,
    WORKSHOP_LOCAL_URLS: '', // do not probe the real Ollama or LM Studio ports
    npm_config_cache: process.env.npm_config_cache ?? path.join(os.homedir(), '.npm'),
    ...extra,
  };
  return { home, env };
}

// Async, so the fake OpenRouter server in this process can answer while the script runs.
function runSetup(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--no-color', ...args], { env, cwd: env.HOME });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const FAST = ['--skip-harness', '--skip-bench'];

describe('setup.mjs end to end (no network)', posixOnly, () => {
  test('missing Claude Code is a warning that names other frontier agents', async () => {
    const { env } = makeEnv();
    const { code, out } = await runSetup(['--check', ...FAST], env);
    assert.equal(code, 0, out);
    assert.match(out, /! Claude Code — not installed/);
    assert.match(out, /claude\.ai\/install/);
    assert.match(out, /another agent with a frontier model/);
  });

  test('signed-out Claude Code is flagged; ANTHROPIC_API_KEY counts as signed in', async () => {
    const signedOut = makeEnv({ claude: 'logged-out' });
    assert.match((await runSetup(['--check', ...FAST], signedOut.env)).out, /! Claude Code sign-in — not signed in/);
    const apiKey = makeEnv({ claude: 'logged-out', extra: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
    assert.match((await runSetup(['--check', ...FAST], apiKey.env)).out, /using ANTHROPIC_API_KEY/);
  });

  test('no OpenRouter key: tells you we provide one', async () => {
    const { env } = makeEnv({ claude: 'logged-in' });
    const { out } = await runSetup(['--check', ...FAST], env);
    assert.match(out, /DeepSeek models on OpenRouter — deepseek\/deepseek-v4-pro, deepseek\/deepseek-v4-flash/);
    assert.match(out, /OpenRouter key — not provided/);
    assert.match(out, /we provide a workshop key/);
  });

  test('checks an OpenRouter key from the environment and never prints it', async () => {
    const cases = [
      ['sk-or-good', /✔ OpenRouter key — valid, \$9\.50 left on this key/],
      ['sk-or-unlimited', /✔ OpenRouter key — valid, no spending limit set/],
      ['sk-or-low', /! OpenRouter key — valid, \$0\.40 left on this key[\s\S]*Add credit/],
      ['sk-or-wrong', /! OpenRouter key — rejected \(HTTP 401\)/],
    ];
    for (const [key, expected] of cases) {
      const { home, env } = makeEnv({ claude: 'logged-in', extra: { OPENROUTER_API_KEY: key } });
      const { code, out } = await runSetup(['--yes', ...FAST], env);
      assert.equal(code, 0, out);
      assert.match(out, expected);
      assert.ok(!out.includes(key), `key ${key} leaked into output`);
      const grep = spawnSync('grep', ['-r', key, home], { encoding: 'utf8' });
      assert.equal(grep.stdout, '', `key ${key} written to disk`);
    }
  });

  test('OPENROUTER_KEY is accepted as the key, and never printed', async () => {
    const { env } = makeEnv({ claude: 'logged-in', extra: { OPENROUTER_KEY: 'sk-or-good' } });
    const { code, out } = await runSetup(['--check', ...FAST], env);
    assert.equal(code, 0, out);
    assert.match(out, /✔ OpenRouter key — valid, \$9\.50 left on this key/);
    assert.doesNotMatch(out, /export OPENROUTER_API_KEY/);
    assert.ok(!out.includes('sk-or-good'));
  });

  test('finds a local model server and lists its models', async () => {
    const local = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'qwen3-coder:30b' }, { id: 'llama3.1:8b' }] }) : '{}');
    });
    await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${local.address().port}/v1`;
      const { env } = makeEnv({ claude: 'logged-in', extra: { WORKSHOP_LOCAL_URLS: base } });
      const { code, out } = await runSetup(['--check', ...FAST], env);
      assert.equal(code, 0, out);
      assert.match(out, /✔ Local server at http:\/\/127\.0\.0\.1:\d+\/v1 — qwen3-coder:30b, llama3\.1:8b/);
      assert.match(out, /ladder\.mjs run <task> --model <label> --local/);
    } finally {
      local.close();
    }
  });

  test('no local model server is information, not a problem', async () => {
    const { env } = makeEnv({ claude: 'logged-in' });
    const { code, out } = await runSetup(['--check', ...FAST], env);
    assert.equal(code, 0, out);
    assert.match(out, /• Local model server — none found/);
  });

  test('--skip-bench leaves the ladder scorer alone', async () => {
    const { env } = makeEnv({ claude: 'logged-in' });
    const { out } = await runSetup(['--check', ...FAST], env);
    assert.match(out, /• Model ladder scorer — skipped \(--skip-bench\)/);
  });

  test('unreachable OpenRouter is a warning, not a failure', async () => {
    const { env } = makeEnv({ claude: 'logged-in', extra: { WORKSHOP_OPENROUTER_API: 'http://127.0.0.1:1/api/v1' } });
    const { code, out } = await runSetup(['--check', ...FAST], env);
    assert.equal(code, 0, out);
    assert.match(out, /! OpenRouter reachable — could not reach openrouter\.ai/);
  });

  test('a harness already listening on 3080 is reported, not restarted', async (t) => {
    const server = await occupy(3080, fakeHarness());
    if (!server) return t.skip('port 3080 is busy on this machine');
    try {
      const { env } = makeEnv({ claude: 'logged-in' });
      const { code, out } = await runSetup(['--check', '--skip-bench'], env);
      assert.equal(code, 0, out);
      assert.match(out, /already running on 127\.0\.0\.1:3080/);
      assert.doesNotMatch(out, /Downloading/);
    } finally {
      server.close();
    }
  });

  test('another app on 3080 moves the harness to 3081', async (t) => {
    const other = await occupy(3080);
    const next = other && await occupy(3081);
    if (!next) { other?.close(); return t.skip('ports 3080-3081 are busy on this machine'); }
    next.close(); // only checked that 3081 is free; the stub harness takes it
    try {
      const { home, env } = makeEnv({ claude: 'logged-in' });
      // Stub npx: reports a version, and serves like the harness on the --port it gets.
      writeFileSync(path.join(home, 'stub-bin', 'npx'), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.2.1'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
require('node:http').createServer((req, res) => { res.statusCode = 401; res.end('dsh web authentication required'); }).listen(port, '127.0.0.1');
`);
      chmodSync(path.join(home, 'stub-bin', 'npx'), 0o755);
      const { code, out } = await runSetup(['--check', '--skip-bench'], env);
      assert.equal(code, 0, out);
      assert.match(out, /Port 3080 is used by another app, so the harness will use port 3081/);
      assert.match(out, /started on 127\.0\.0\.1:3081, then stopped again/);
      assert.match(out, /npx @deepseek-ai\/dsh web --port 3081/);
    } finally {
      other.close();
    }
  });

  test('every port taken by other apps fails with what to do next', async (t) => {
    const servers = [];
    for (let port = 3080; port <= 3089; port++) servers.push(await occupy(port));
    try {
      if (servers.includes(null)) return t.skip('ports 3080-3089 are busy on this machine');
      const { env } = makeEnv({ claude: 'logged-in' });
      const { code, out } = await runSetup(['--check', '--skip-bench'], env);
      assert.equal(code, 1, out);
      assert.match(out, /ports 3080-3089 are all used by other apps/);
      assert.match(out, /rerun: node setup\.mjs/);
      assert.match(out, /npx @deepseek-ai\/dsh web --port 3100/);
      assert.doesNotMatch(out, /Downloading/);
    } finally {
      for (const server of servers) server?.close();
    }
  });
});

// Holds a port for a test: by default a plain TCP app that is not the harness.
// Resolves null when the port is already taken on this machine.
function occupy(port, server = createTcpServer((socket) => socket.end())) {
  return new Promise((resolve) => {
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// Answers like the harness does before login.
function fakeHarness() {
  return createServer((req, res) => {
    res.statusCode = 401;
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  });
}
