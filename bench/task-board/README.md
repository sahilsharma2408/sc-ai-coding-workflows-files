# Task Board benchmark

A spec, a hidden test suite and a scorer for judging how well a model builds a small React and TypeScript app. Give a model `spec.md`, let it build the project, then score the result out of 100.

Task Board is a small React app, big enough that sloppy output shows up in the numbers.

## What is in this folder

| Path | Purpose | Show it to the model? |
|---|---|---|
| `spec.md` | The full specification the model builds from | **Yes**. This is the only file it needs |
| `tests/` | The hidden suite: about 300 behaviour and static checks | No |
| `judge/bugs.mjs` | 52 bugs injected into the reference to test the model's own tests | No |
| `judge/audit.mjs` | Reads the agent transcripts: tokens, dollars, sub-agent count, rule breaks | No |
| `judge/pricing.json` | Price per million tokens for each model, with the assumptions behind it | No |
| `judge/compare.mjs` | Prints one table from the score and cost reports of several runs | No |
| `reference/` | A model-quality solution. It proves the spec can be met and is the base for the bug runs | No |
| `score.mjs` | The scorer | No |
| `vitest.config.ts`, `vitest.own.config.ts` | Test configs used by the scorer | No |
| `tests/manifest.json` | List of every hidden check, so a check that cannot load still counts as a failure | No |

Keep `tests/`, `judge/` and `reference/` out of the model's working folder. A model that can read the tests writes code to pass them, and the score stops meaning anything.

## One-time setup

```bash
cd bench/task-board
npm install --legacy-peer-deps
```

The scorer uses this folder's `node_modules` for every run. A model's project does not need its own `npm install` to be scored. `jsdom` is pinned to version 26 because newer versions need Node 22 or later.

## Running one model

1. Make an empty folder for the run and copy in `spec.md` only:

   ```bash
   mkdir -p ../../runs/claude-code-opus && cp spec.md ../../runs/claude-code-opus/
   ```

2. Start the model in that folder and give it this prompt:

   ```
   Read @spec.md and build the whole project in the current directory, exactly as specified:
   the app, the stylesheets, the configuration, and the tests the spec asks for.
   Follow section 14 of the spec: write the project in one pass, do not run any command, and use at most 3 sub-agents.
   Do not ask me questions. When something is ambiguous, follow the spec's wording.
   ```

3. Audit the run, then score it. The audit reads the agent transcripts, so it needs the id of the agent that did the work:

   ```bash
   node judge/audit.mjs --root <agentId> --workdir ../../runs/claude-code-opus --name claude-code-opus [--orchestrator]
   node score.mjs --target ../../runs/claude-code-opus --name claude-code-opus --violations reports/claude-code-opus.run.json
   node judge/compare.mjs claude-code-opus other-run
   ```

   Use `--orchestrator` for a run where an Opus agent hands the writing to sub-agents (it may not write files itself).

### Rules of the run (spec section 14)

| Rule | How it is checked |
|---|---|
| One pass: no `npm`, `npx`, `node`, `tsc`, `vitest` or `vite` command | `audit.mjs` lists every Bash command of every agent in the tree |
| At most 3 sub-agents in total, nested ones included | `audit.mjs` counts the agents started from the root |
| An orchestrator does not write project files | `audit.mjs --orchestrator` flags a Write or Edit by the root agent |
| Nothing is read or written outside the working folder | `audit.mjs` checks every file path and flags paths into the repo, `bench` or `judge` |

Any broken rule caps the total at 50 (`--violations`). The cap leaves the other numbers visible. These checks read the log, so they catch what a run did and not what it thought.

### Tokens and cost

`audit.mjs` adds up the token use of **every** agent in the tree (input, output, cache reads, cache writes) from each API call, and prices it with `judge/pricing.json`. The prices come from the Anthropic model table. Cache-write prices and Haiku cache-read prices are not in that table and are assumptions, listed in the file. Change the file and re-run the audit to re-price a run.

Each run takes about a minute to score. The report is printed and saved to `reports/<name>.json` (score) and `reports/<name>.run.json` (cost and audit). Add `--verbose` to list every failing check.

## Reading the report

```
Requirements completeness               98/98         25.0/25     100%
Behaviour and edge cases                74/74         18.0/18     100%
State design and render efficiency      40/40         14.0/14     100%
...
TOTAL 99.2 / 100   grade A
```

| Category | Points | Mostly judged by |
|---|---|---|
| Requirements completeness | 25 | Behaviour tests: every feature, label and message in the spec |
| Behaviour and edge cases | 18 | Behaviour tests: boundaries, no-ops, time zones, keyboard, stable keys, sort ties |
| State design and render efficiency | 14 | Render counting plus code analysis (see below) |
| Architecture and modularity | 10 | Code analysis, plus a real `vite build` |
| TypeScript quality | 8 | The compiler (`tsc`) plus code analysis |
| Code quality | 7 | Code analysis |
| Styles, HTML and accessibility | 5 | CSS analysis plus checks on the rendered HTML |
| Quality of the model's own tests | 13 | Code analysis of its tests, plus the three dynamic checks below |

Grades: A is 90 or more, B 80 or more, C 70 or more, D 60 or more, F below that.

### Steep marking

Each category earns `points x (share of checks passed) ^ 3`. Passing 90% of a category earns about 73% of its points; 80% earns about 51%. On top of that the total has hard caps:

| Situation | Total can be at most |
|---|---|
| `vite build` fails | 60 |
| `tsc --noEmit` reports errors | 85 |
| A rule of the run was broken (`--violations`) | 50 |

### How the state checks work

The state design checks catch state that looks tidy but is not:

- **Render counting.** The app is rendered inside React's `Profiler`, and `TaskCard` is wrapped with a counter. A user action must cause **at most one commit**. A second commit means an effect copied state into state. Typing in the add form must re-render **zero** cards, so form state has to stay local. Mounting must render each card exactly once.
- **Reference stability.** A reducer no-op must return the same state object. Untouched tasks must keep their identity. The hook's functions and `columns` must keep their identity across renders.
- **Immutability.** The reducer and selectors run on deeply frozen input.
- **Code analysis.** The scorer parses the source and fails any `useEffect` that calls a setter or `dispatch`, any `useState` holding a derived value such as `filtered…` or `…count`, a context value built as a fresh object, and any mutation inside the reducer.

### How the model's own tests are judged

Beyond the static rules in section 12 of the spec, three dynamic checks run:

1. **Do they pass on the model's own code?** (needs at least 20 tests)
2. **Do they also pass on the reference?** The model's test files are copied onto the reference solution. Tests that depend on private structure fail here.
3. **Do they catch bugs?** Each of the 52 bugs is applied to the reference one at a time, and the model's tests are run against it. A bug counts as caught when a test that passed on the clean reference now fails. Catching 85% or more earns full marks.

The report lists the bugs the model's tests missed. That list is a quick way to see which behaviours it never tested.

## Flags

| Flag | Effect |
|---|---|
| `--target <dir>` | Project to score. Defaults to `reference` |
| `--name <label>` | Name for the work folder and report |
| `--skip-dynamic` | Run only the hidden suite. Takes seconds. The own-tests category is left out and the total is scaled |
| `--verbose` | List every failing check |
| `--violations <file>` | Read `reports/<name>.run.json` from `audit.mjs`; a broken run rule caps the total at 50 |
| `--validate-bugs` | Also confirm the hidden suite catches each injected bug |
| `--concurrency <n>` | Parallel runs in the bug step. Default 4 |
| `--write-manifest` | Rewrite `tests/manifest.json` from this run. Only do this against `reference` |

## Calibration

Measured on this machine with the same scorer:

| Project | Score | What it is |
|---|---|---|
| `reference` | 100 | A careful solution to the spec. Its own tests catch 46 of the 52 injected bugs (88%), past the 85% bar for full marks. The hidden suite catches all 52 |
| Earlier model outputs (v1 benchmark) | 54.5 to 56.8 | Three runs that scored 98 to 100 on the first version of this benchmark. They were built before sort, Clear completed and the shortcuts existed, so they miss those checks. Hidden suite only (`--skip-dynamic`) |

The first version of this benchmark scored linearly and its top end was compressed: every strong run landed between 98 and 100. This version curves each category and adds three cross-file features, so small gaps cost more. Compare models by category as well as by total.

## Keeping it honest

- **Time zone.** Every run uses `America/Los_Angeles`. A date written as `new Date('2026-03-05')` (UTC) shifts by a day there and fails. This is intended.
- **Pinned names.** Tests only use names, labels and messages that `spec.md` states. If a test needs a new detail, add it to the spec first.
- **Heuristics.** The code-analysis checks are rules of thumb: they parse the source with the TypeScript compiler, but they cannot judge intent. If a check rejects something reasonable, loosen the check, regenerate the baseline and note the change here. Do not special-case a model.
- **Adding a check.** Tag the test title with `[CATEGORY weight]` using the helpers in `tests/support/tags.ts`. Then run `node score.mjs --target reference --skip-dynamic --write-manifest`.
- **Adding a bug.** Add an entry to `judge/bugs.mjs` with an exact `find` string that appears once, then run `node score.mjs --target reference --validate-bugs`.
- **Cheating.** The scorer reads the model's source and runs its tests in a copy. It never executes anything outside that copy, but treat model output as untrusted code and run the scorer on a machine you are happy to run it on.
