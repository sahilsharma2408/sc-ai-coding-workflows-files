#!/usr/bin/env node
// Workshop setup for "Inference at the Edge of Your IDE".
//
// Checks your machine, pre-downloads the DeepSeek harness, checks OpenRouter,
// installs the model-ladder scorer and looks for a local model server.
// Uses only Node built-ins, so it runs before anything else is installed.
//
//   node setup.mjs                 interactive setup
//   node setup.mjs --check         check only: change nothing, ask nothing
//   node setup.mjs --help          all options
//
// Your OpenRouter key is only ever sent to openrouter.ai to check it.
// This script never writes it to disk.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const HARNESS_PACKAGE = '@deepseek-ai/dsh';
const HARNESS_PORT = 3080;
const HARNESS_LAST_PORT = 3089; // other apps on 3080 push the harness up to here
const OPENROUTER_API = process.env.WORKSHOP_OPENROUTER_API ?? 'https://openrouter.ai/api/v1';
const DEEPSEEK_MODELS = ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash'];

const HELP = `Usage: node setup.mjs [options]

Options:
  --check           Check only. Create nothing, install nothing, ask nothing
  --yes, -y         Accept the default answer to every question
  --skip-harness    Skip downloading and starting the DeepSeek harness
  --skip-bench      Skip installing the scorer for the model ladder (bench/task-board, about 170 MB)
  --no-color        Plain output
  --help, -h        Show this help

Environment:
  OPENROUTER_API_KEY   Checked without a prompt if set (OPENROUTER_KEY works too). If neither is
                       set, you are asked for one. It is never written to disk.
`;

// ---------- arguments ----------

export function parseArgs(argv) {
  const opts = {
    check: false,
    yes: false,
    skipHarness: false,
    skipBench: false,
    color: process.stdout.isTTY && !process.env.NO_COLOR,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--yes' || arg === '-y') opts.yes = true;
    else if (arg === '--skip-harness') opts.skipHarness = true;
    else if (arg === '--skip-bench') opts.skipBench = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

// ---------- output ----------

let useColor = false;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

const ICON = { ok: '✔', warn: '!', fail: '✖', info: '•' };
const COLOR = { ok: green, warn: yellow, fail: red, info: cyan };
const results = [];

function record(status, name, detail = '', fix = '') {
  results.push({ status, name, detail, fix });
  const line = `  ${COLOR[status](ICON[status])} ${name}${detail ? dim(` — ${detail}`) : ''}`;
  console.log(line);
  if (fix) for (const fixLine of fix.split('\n')) console.log(`      ${fixLine}`);
}

function section(title) {
  console.log(`\n${bold(title)}`);
}

// ---------- helpers ----------

// The workshop stack sets the floor: jsdom 30 needs ^22.22.2 || ^24.15.0 || >=26,
// and Vitest 5 rejects the odd-numbered releases.
export function nodeSupported([major, minor]) {
  if (major === 22) return minor >= 22;
  if (major === 24) return minor >= 15;
  return major >= 26 && major % 2 === 0;
}

export function parseVersion(text) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? match.slice(1, 4).map(Number) : null;
}

// Runs a command and returns { ok, code, stdout, stderr }. Never throws.
// On Windows, npm, npx and globally installed CLIs are .cmd shims, so go through the shell.
function run(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: IS_WINDOWS,
    timeout: options.timeout ?? 30_000,
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    error: result.error,
  };
}

// Like run(), but async, with a spinner and elapsed time while it runs. Used for
// the multi-minute harness download, so the screen does not look frozen (people
// press Enter). npm reports no progress we can read, so there is no percentage.
function runWithProgress(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: IS_WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // Redrawn in place on one line, so only for a terminal: CI logs stay clean.
    const frames = IS_WINDOWS ? '|/-\\' : '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
    const startedAt = Date.now();
    let frame = 0;
    const ticker = process.stdout.isTTY && setInterval(() => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const elapsed = `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
      process.stdout.write(`\r  ${frames[frame++ % frames.length]} Downloading… ${elapsed}`);
    }, 100);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    let settled = false;
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearInterval(ticker);
      clearTimeout(timer);
      if (ticker) process.stdout.write('\r\x1b[2K'); // erase the spinner line
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: timedOut ? { code: 'ETIMEDOUT' } : error,
      });
    };
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(code));
  });
}

function onPath(cmd) {
  const probe = IS_WINDOWS ? run('where', [cmd]) : run('sh', ['-c', `command -v ${cmd}`]);
  return probe.ok && probe.stdout.length > 0;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

// Without a login, the harness answers every request with a 401 and this text,
// which tells it apart from any other app on the port.
async function isHarness(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return response.status === 401 && (await response.text()).includes('dsh web authentication required');
  } catch {
    return false;
  }
}

// Walks 3080-3089 and stops at the first port that is free, or that already
// runs the harness (reused, so reruns do not start a second copy). Ports held
// by other apps are skipped. Returns undefined when every port is taken.
async function findHarnessPort() {
  for (let port = HARNESS_PORT; port <= HARNESS_LAST_PORT; port++) {
    if (!(await portInUse(port))) return { port, running: false };
    if (await isHarness(port)) return { port, running: true };
  }
  return undefined;
}

// Copy-paste commands for the participant's own OS. Nothing here is run by the script.
function portCommands(port) {
  return IS_WINDOWS
    ? { find: `Get-NetTCPConnection -LocalPort ${port} -State Listen`,
        stop: `Stop-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess` }
    : { find: `lsof -iTCP:${port} -sTCP:LISTEN`,
        stop: `kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)` };
}

// ---------- prompts ----------

// People press Enter while the long steps run silently. The terminal keeps
// those keys, and the next question would take them as its answer. So every
// question throws away pending input first, then opens a fresh readline.
// Raw mode makes half-typed lines readable too, so they are dropped as well.
async function openReadline() {
  if (process.stdin.isTTY) {
    const discard = () => {};
    process.stdin.setRawMode(true);
    process.stdin.on('data', discard).resume();
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.stdin.off('data', discard).pause();
    process.stdin.setRawMode(false);
  }
  return readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
}

function canAsk(opts) {
  return !opts.yes && !opts.check && process.stdin.isTTY;
}

async function ask(opts, question, fallback) {
  if (!canAsk(opts)) return fallback;
  const r = await openReadline();
  const answer = await new Promise((resolve) => r.question(`  ${question} `, resolve));
  r.close();
  return answer.trim() || fallback;
}

async function confirm(opts, question, fallback) {
  const hint = fallback ? '[Y/n]' : '[y/N]';
  const answer = await ask(opts, `${question} ${hint}`, fallback ? 'y' : 'n');
  return /^y(es)?$/i.test(answer);
}

// Reads a line without echoing it, for the API key.
async function askSecret(opts, question) {
  if (!canAsk(opts)) return '';
  const r = await openReadline();
  const write = r._writeToOutput;
  r._writeToOutput = (text) => {
    if (text.includes(question)) write.call(r, text);
    else if (text.includes('\n') || text.includes('\r')) write.call(r, '\n');
  };
  const answer = await new Promise((resolve) => r.question(`  ${question} `, resolve));
  r.close();
  return answer.trim();
}

// ---------- checks ----------

function checkSystem() {
  section('Your machine');
  const memGb = Math.round(os.totalmem() / 1024 ** 3);
  const cpu = os.cpus()[0]?.model ?? 'unknown CPU';
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64';
  record('info', `${os.type()} ${os.release()} (${process.arch})`, `${cpu}, ${memGb} GB RAM`);
  if (appleSilicon && memGb >= 16) {
    record('ok', 'Hardware for local models', 'Apple silicon with 16 GB or more');
  } else {
    record('warn', 'Hardware for local models', `${memGb} GB RAM${appleSilicon ? ', Apple silicon' : ''}`,
      'Running models on your laptop works best with Apple silicon or a GPU with 16 GB+\n' +
      'of memory. You can still compare the cloud models.');
  }
}

function checkGit() {
  section('Git');
  const git = run('git', ['--version']);
  if (!git.ok) {
    record('fail', 'Git', 'not found', 'Install it from https://git-scm.com/downloads');
    return false;
  }
  record('ok', 'Git', git.stdout.replace('git version ', ''));
  // Run outside this clone so its local config does not count.
  const name = run('git', ['config', '--get', 'user.name'], { cwd: os.homedir() }).stdout;
  const email = run('git', ['config', '--get', 'user.email'], { cwd: os.homedir() }).stdout;
  if (name && email) {
    record('ok', 'Git identity', `${name} <${email}>`);
  } else {
    record('warn', 'Git identity', 'user.name or user.email not set',
      'The workshop commits between runs. Set them with:\n' +
      '  git config --global user.name "Your Name"\n' +
      '  git config --global user.email "you@example.com"');
  }
  return true;
}

function checkNode() {
  section('Node.js');
  if (!nodeSupported(parseVersion(process.version))) {
    record('fail', 'Node.js', `${process.version} is not supported`,
      'Install the current LTS from https://nodejs.org (22.22+, 24.15+ or newer).');
    return false;
  }
  record('ok', 'Node.js', process.version);
  const npm = run('npm', ['--version']);
  if (!npm.ok) {
    record('fail', 'npm', 'not found', 'npm ships with Node.js. Reinstall Node.js from https://nodejs.org');
    return false;
  }
  record('ok', 'npm', npm.stdout);
  return true;
}

function checkEditor() {
  section('Editor');
  const found = [];
  if (onPath('code')) found.push('VS Code');
  if (onPath('orca') || existsSync('/Applications/Orca.app')) found.push('Orca');
  if (!found.includes('VS Code') && existsSync('/Applications/Visual Studio Code.app')) found.push('VS Code');
  if (found.length) record('ok', 'Editor', found.join(', '));
  else record('warn', 'Editor', 'Orca or VS Code not found',
    'Install Orca (https://www.onorca.dev) or VS Code (https://code.visualstudio.com).\nAny editor works.');
}

async function checkClaude(opts) {
  section('Your frontier coding agent (bring your own)');
  let version = run('claude', ['--version']);
  if (!version.ok) {
    const installCmd = IS_WINDOWS
      ? 'powershell -NoProfile -Command "irm https://claude.ai/install.ps1 | iex"'
      : 'curl -fsSL https://claude.ai/install.sh | bash';
    if (canAsk(opts) && await confirm(opts, 'Claude Code is not installed. Install it now?', true)) {
      run(IS_WINDOWS ? 'powershell' : 'bash',
        IS_WINDOWS ? ['-NoProfile', '-Command', 'irm https://claude.ai/install.ps1 | iex'] : ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
        { inherit: true, timeout: 300_000 });
      version = run('claude', ['--version']);
      if (!version.ok) {
        record('warn', 'Claude Code', 'installed, but not on your PATH yet',
          'Open a new terminal and run this script again.');
        return;
      }
    } else {
      record('warn', 'Claude Code', 'not installed',
        `Install it with: ${installCmd}\n` +
        'Claude Code is the frontier agent we compare against. If you use\n' +
        'another agent with a frontier model (Codex, Cursor, Gemini CLI...), you can follow along with that instead.');
      return;
    }
  }
  record('ok', 'Claude Code', version.stdout);

  if (process.env.ANTHROPIC_API_KEY) {
    record('ok', 'Claude Code sign-in', 'using ANTHROPIC_API_KEY from your environment');
    return;
  }
  const auth = run('claude', ['auth', 'status'], { timeout: 20_000 });
  let status = null;
  try { status = JSON.parse(auth.stdout); } catch { /* older versions print text */ }
  if (status?.loggedIn) {
    record('ok', 'Claude Code sign-in', `signed in (${status.authMethod ?? 'unknown method'})`);
  } else if (status) {
    record('warn', 'Claude Code sign-in', 'not signed in',
      'Run `claude` and sign in with a paid Claude plan, or set ANTHROPIC_API_KEY.\n' +
      'Claude Code needs paid access.');
  } else {
    record('warn', 'Claude Code sign-in', 'could not check',
      'Run `claude` once and make sure it answers a message.');
  }
}

// Picks a port, downloads the harness through npx, starts the web UI there and
// waits for it to listen. Returns { status, port }: status 'running' when the
// harness already serves that port, 'checked' when our own test start worked.
// Returns undefined if the harness is skipped, broken, or has no free port.
async function checkHarness(opts) {
  section('DeepSeek harness');
  if (opts.skipHarness) {
    record('info', 'DeepSeek harness', 'skipped (--skip-harness)');
    return;
  }
  if (process.platform === 'darwin' && readdirSafe('/Applications').some((app) => /deepseek/i.test(app))) {
    record('ok', 'DeepSeek harness desktop app', 'found in /Applications');
  }
  const slot = await findHarnessPort();
  if (!slot) {
    record('fail', 'DeepSeek harness web UI', `ports ${HARNESS_PORT}-${HARNESS_LAST_PORT} are all used by other apps`,
      `Either free one of them, then rerun: node setup.mjs\n` +
      `  See what holds a port: ${portCommands(HARNESS_PORT).find}\n` +
      `Or start the harness yourself on any free port:\n` +
      `  npx ${HARNESS_PACKAGE} web --port 3100     (or --port 0 to let it pick one)`);
    return;
  }
  const { port } = slot;
  if (slot.running) {
    record('ok', 'DeepSeek harness web UI', `already running on 127.0.0.1:${port}`);
    return { status: 'running', port };
  }
  if (port !== HARNESS_PORT) {
    console.log(dim(`  Port ${HARNESS_PORT} is used by another app, so the harness will use port ${port}.`));
  }

  // The first download is close to 1 GB and takes minutes. That is why it happens
  // here at home instead of on conference Wi-Fi. Later starts take seconds.
  console.log(dim(`  Downloading ${HARNESS_PACKAGE} (about 900 MB the first time, can take 5 minutes)...`));
  const download = await runWithProgress('npx', ['-y', HARNESS_PACKAGE, '--version'], 900_000);
  if (!download.ok) {
    record('fail', 'DeepSeek harness download', download.error?.code === 'ETIMEDOUT' ? 'timed out after 15 minutes' : `npx failed (exit ${download.code})`,
      `Try it by hand: npx ${HARNESS_PACKAGE} web\n` + lastLines(download.stderr || download.stdout));
    return;
  }
  record('ok', 'DeepSeek harness download', `version ${parseVersion(download.stdout)?.join('.') ?? download.stdout.split('\n').pop()}`);

  console.log(dim('  Starting the web UI to check it runs...'));
  const started = await startHarness(120_000, port);
  if (started.ok) {
    record('ok', 'DeepSeek harness web UI', `started on 127.0.0.1:${port}, then stopped again`,
      `Start it again later with: npx ${HARNESS_PACKAGE} web${port === HARNESS_PORT ? '' : ` --port ${port}`}`);
    return { status: 'checked', port };
  } else {
    record('fail', 'DeepSeek harness web UI', started.reason,
      `Try it by hand: npx ${HARNESS_PACKAGE} web\n` +
      'Or install the desktop app (macOS on Apple silicon, Windows): https://www.deepseek.com/en/harness/' +
      (started.log ? `\nLast output:\n${started.log.split('\n').slice(-8).map((l) => `  ${dim(l)}`).join('\n')}` : ''));
  }
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function startHarness(timeoutMs, port) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['-y', HARNESS_PACKAGE, 'web', '--no-open', '--port', String(port)], {
      shell: IS_WINDOWS,
      detached: !IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(timer);
      stopTree(child);
      resolve({ ...result, log: log.trim() });
    };
    const onData = (chunk) => { log = (log + chunk).slice(-4000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => finish({ ok: false, reason: `could not run npx (${err.message})` }));
    child.on('exit', (code) => finish({ ok: false, reason: `exited early with code ${code}` }));
    const poll = setInterval(async () => {
      if (await portInUse(port)) finish({ ok: true });
    }, 1000);
    const timer = setTimeout(() => finish({ ok: false, reason: `did not start within ${timeoutMs / 1000}s` }), timeoutMs);
  });
}

function stopTree(child) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    if (IS_WINDOWS) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
}

// Participants run this at the workshop and go straight to the DeepSeek UI, so
// setup ends by leaving it running. dsh opens the default browser on its login
// link itself (and skips that over SSH). Only for a person at a terminal: never
// in --check mode, and never when output is piped (CI, the Docker sandbox).
async function openHarness(opts, harness) {
  if (!harness || opts.check || !process.stdout.isTTY) return;
  const { status, port } = harness;
  if (status === 'running') {
    console.log(`DeepSeek web UI already running: http://127.0.0.1:${port}`);
    console.log('Seeing "authentication required"? Stop it, then rerun node setup.mjs:');
    console.log(`  ${portCommands(port).stop}\n`);
    return;
  }
  // stopTree() does not wait, so the test server may still hold the port.
  for (let i = 0; i < 20 && await portInUse(port); i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(bold('Opening the DeepSeek web UI...\n'));
  const child = spawn('npx', ['-y', HARNESS_PACKAGE, 'web', '--port', String(port)], {
    shell: IS_WINDOWS,
    cwd: os.homedir(),
    detached: true,     // its own process group, so it outlives this script
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function checkOpenRouter(opts) {
  section('OpenRouter (DeepSeek models)');
  try {
    const models = await fetchJson(`${OPENROUTER_API}/models`);
    const ids = new Set((models.body?.data ?? []).map((m) => m.id));
    const missing = DEEPSEEK_MODELS.filter((id) => !ids.has(id));
    if (models.status !== 200) {
      record('warn', 'OpenRouter reachable', `HTTP ${models.status}`);
    } else if (missing.length) {
      record('warn', 'DeepSeek models on OpenRouter', `not listed: ${missing.join(', ')}`,
        'The speakers will share the current model IDs at the start of the session.');
    } else {
      record('ok', 'DeepSeek models on OpenRouter', DEEPSEEK_MODELS.join(', '));
    }
  } catch (err) {
    record('warn', 'OpenRouter reachable', `could not reach openrouter.ai (${err.cause?.code ?? err.message})`,
      'Check your internet connection, VPN or proxy.');
    return;
  }

  // OPENROUTER_API_KEY is the name the harness and the ladder read; OPENROUTER_KEY is accepted too.
  let key = (process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY)?.trim() ?? '';
  const fromEnvironment = key !== '';
  if (!key && canAsk(opts)) {
    console.log(dim('  No OpenRouter key is exported in this terminal.'));
    console.log(dim('  Paste your own key to check it (input is hidden, nothing is saved).'));
    console.log(dim('  No key? Press Enter. We provide a workshop key with limited credit at the session.'));
    key = await askSecret(opts, 'OpenRouter API key:');
  }
  if (!key) {
    record('info', 'OpenRouter key', 'not provided',
      'That is fine: we provide a workshop key for the DeepSeek models.\n' +
      'Want your own? https://openrouter.ai/keys, with about $10 of credit.');
    return;
  }
  try {
    const check = await fetchJson(`${OPENROUTER_API}/key`, { Authorization: `Bearer ${key}` });
    if (check.status === 200) {
      const data = check.body?.data ?? {};
      const remaining = data.limit_remaining ?? null;
      const credit = remaining === null ? 'no spending limit set' : `$${Number(remaining).toFixed(2)} left on this key`;
      const low = remaining !== null && remaining < 2;
      record(low ? 'warn' : 'ok', 'OpenRouter key', `valid, ${credit}`,
        (low ? 'Add credit: about $10 covers the whole workshop.\n' : '') +
        (fromEnvironment ? '' : 'This script does not keep it. In the terminal you will run the ladder from, export it first:\n' +
          '  export OPENROUTER_API_KEY=your-key-here        (PowerShell: $env:OPENROUTER_API_KEY = "your-key-here")\n') +
        'Never commit it to Git.');
    } else {
      record('warn', 'OpenRouter key', `rejected (HTTP ${check.status})`,
        'Create a new one at https://openrouter.ai/keys, or use the workshop key we provide.');
    }
  } catch (err) {
    record('warn', 'OpenRouter key', `could not check (${err.message})`);
  }
}

// Installs the scorer for the model ladder (bench/task-board). In check mode it only looks.
function checkBench(opts) {
  section('Model ladder (scores the models you compare)');
  if (opts.skipBench) {
    record('info', 'Model ladder scorer', 'skipped (--skip-bench)');
    return;
  }
  const benchDir = path.join(REPO_DIR, 'bench', 'task-board');
  if (!existsSync(path.join(benchDir, 'package.json'))) {
    record('fail', 'Model ladder scorer', `not found at ${benchDir}`, 'Run this script from the cloned workshop repo.');
    return;
  }
  const installed = () => existsSync(path.join(benchDir, 'node_modules', 'vitest'));
  if (!installed() && !opts.check) {
    console.log(dim('  Installing the scorer dependencies (about 170 MB)...'));
    const install = run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: benchDir, timeout: 600_000 });
    if (!install.ok) {
      record('fail', 'Model ladder scorer', `npm ci failed (exit ${install.code})`, lastLines(install.stderr || install.stdout));
      return;
    }
  }
  if (installed()) record('ok', 'Model ladder scorer', 'installed');
  else record('warn', 'Model ladder scorer', 'not installed yet', `Run: cd bench/task-board && npm ci`);
}

// Looks for a model server already running on this laptop. Read-only, and only ever asks 127.0.0.1.
// WORKSHOP_LOCAL_URLS (comma-separated, ending in /v1) replaces the usual addresses, for tests.
const LOCAL_SERVERS = [
  ['Ollama', 'http://127.0.0.1:11434/v1'],
  ['LM Studio', 'http://127.0.0.1:1234/v1'],
  ['llama.cpp', 'http://127.0.0.1:8080/v1'],
];

async function checkLocalModels() {
  section('Local models (only needed for the local comparison)');
  const servers = process.env.WORKSHOP_LOCAL_URLS === undefined
    ? LOCAL_SERVERS
    : process.env.WORKSHOP_LOCAL_URLS.split(',').filter(Boolean).map((url) => ['Local server', url]);
  let found = 0;
  for (const [name, base] of servers) {
    try {
      const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) });
      const ids = ((await response.json().catch(() => null))?.data ?? []).map((m) => m.id).filter(Boolean);
      if (!response.ok) continue;
      found += 1;
      const shown = ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, and ${ids.length - 5} more` : '');
      record('ok', `${name} at ${base}`, ids.length ? shown : 'running, no models loaded yet');
    } catch {
      // nothing listening here
    }
  }
  if (found === 0) {
    record('info', 'Local model server', 'none found',
      'Start Ollama, LM Studio or llama.cpp with a model that supports tool calls. See harness/README.md.');
  } else {
    console.log(dim('      Compare it with: node bench/task-board/lab/workshop/ladder.mjs run <task> --model <label> --local --id <model name>'));
  }
}

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const lastLines = (text, n = 8) => stripAnsi(text).split('\n').slice(-n).map((l) => dim(l)).join('\n');

// ---------- main ----------

function printSummary(opts) {
  const fails = results.filter((r) => r.status === 'fail');
  const warns = results.filter((r) => r.status === 'warn');
  section('Summary');
  if (fails.length === 0 && warns.length === 0) console.log(green('  Everything is ready. See you at the workshop!'));
  if (fails.length) console.log(red(`  ${fails.length} problem(s) to fix before the workshop: ${fails.map((r) => r.name).join(', ')}`));
  if (warns.length) console.log(yellow(`  ${warns.length} thing(s) to look at: ${warns.map((r) => r.name).join(', ')}`));

  console.log(`\n${bold('About models and keys')}`);
  console.log('  • Bring your own frontier model access: a paid Claude plan or Anthropic API key for');
  console.log('    Claude Code, or another frontier coding agent you already pay for.');
  console.log('  • DeepSeek models run through OpenRouter. Your own key (about $10 of credit) is best.');
  console.log('    No key? We provide one with limited credit. Ask the speakers at the start.');

  if (!opts.check) {
    console.log(`\n${bold('Try the model ladder')}`);
    console.log('  export OPENROUTER_API_KEY=your-key-here');
    console.log('  node bench/task-board/lab/workshop/ladder.mjs run fix-date-file --model flash');
    console.log('  node bench/task-board/lab/workshop/ladder.mjs table');
  }
  console.log('');
  return fails.length === 0 ? 0 : 1;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  useColor = opts.color;

  console.log(bold('Inference at the Edge of Your IDE: workshop setup'));
  if (opts.check) console.log(dim('Check mode: nothing will be installed.'));

  checkSystem();
  checkGit();
  const nodeOk = checkNode();
  checkEditor();
  await checkClaude(opts);
  const harness = nodeOk ? await checkHarness(opts) : undefined;
  await checkOpenRouter(opts);
  if (nodeOk) checkBench(opts);
  await checkLocalModels();
  const code = printSummary(opts);
  await openHarness(opts, harness);
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (err) => {
    console.error(err);
    process.exit(1);
  });
}
