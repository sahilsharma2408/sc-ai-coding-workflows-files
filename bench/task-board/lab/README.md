# Task-type lab

Running this as a workshop with the DeepSeek harness and OpenRouter? See [workshop/WORKSHOP.md](workshop/WORKSHOP.md).

The first benchmark (`../README.md`) builds an app from a spec. That is one kind of work. Real work is also fixing a bug in one file, tracing a bug across layers, adding a feature that touches twenty files, renaming something everywhere, changing a function that other code depends on, and reviewing someone else's change. A model that is good at one is not always good at the others. This lab gives a model an **existing repository** and **one job per task type**, scores each job on its own, and puts the results side by side, so you can see which model or setup fits which kind of work.

## The tasks

| Task | Type | What it tests | Files touched by a good answer |
|---|---|---|---|
| `fix-date-file` | single-file fix | Reading symptoms, finding one root file, a small precise change | 1 |
| `debug-four-layers` | multi-file debug | Tracing four unrelated symptoms to four causes in four layers, with no error output | 4 |
| `labels-feature` | cross-file feature | Planning and consistency: a new field that runs from the types to the styles, with a reducer rule that spans actions | about 20 |
| `migrate-status` | mechanical migration | Thoroughness: two renames across code, tests, a tool and docs, with a "no old word left" check | about 15 |
| `contract-change` | contract change, hidden consumer | Changing two signatures, then finding every caller, including a second consumer outside `src/` that nothing in `src/` mentions (the closest this setup gets to several repositories) | 6 plus tests |
| `review-labels-pr` | code review | Finding 7 planted defects in a 557-line diff, and not crying wolf | none (writes `review.json`) |

The greenfield build in `../spec.md` is the seventh task type and is scored by `../score.mjs`.

All tasks start from `lab/baseline/`, a complete, working copy of the Task Board with a README that gives its layout and house rules, plus `tools/report/`, a small separate consumer of the same code. The type check covers both `src/` and `tools/`.

## How a task is scored

`node lab/lab.mjs score <task> <dir>` gives a score out of 100:

| Part | Points | How |
|---|---|---|
| Task tests | 60 | Hidden tests for this job. Curved: points x (share passed) ^ 3 |
| Regression | 25 | The whole hidden suite of the first benchmark (behaviour and code-quality rules), restricted to the tests a correct solution passes. Curved the same way |
| Hygiene | 15 | Type check clean (5), `vite build` works (4), only the expected files changed (4), no existing tests deleted (2) |

Caps: a failed build caps the total at 60, a broken rule of the run at 50. The code review task is scored by its own scorer: `100 x F1^2` over findings, where F1 balances found defects against false alarms.

The regression part is what makes a "feature" task honest: it fails a model that adds the feature but breaks the sort, the shortcuts or a code-quality limit on the way.

## Rules of the run

Every task ends with the same rules (`RULES.md`): one pass with no command that runs the project, at most 3 sub-agents in total, an orchestrator that does not edit the repository itself, and no reading outside the folder. `../judge/audit.mjs` checks them from the agent logs and adds up tokens and cost for every agent in the tree.

## Running one task

```bash
node lab/lab.mjs prepare labels-feature ../../runs/labels-sonnet     # the model gets TASK.md and the repo
# ... let the model work in that folder, following TASK.md ...
node judge/audit.mjs --root <agentId> --workdir ../../runs/labels-sonnet --name labels-sonnet [--orchestrator]
node lab/lab.mjs score labels-feature ../../runs/labels-sonnet --name labels-sonnet --violations reports/labels-sonnet.run.json
node lab/lab.mjs matrix labels-sonnet other-run ...                 # one table across runs
```

## Checking the lab itself

`node lab/lab.mjs validate` prepares every task twice, applies a known-good solution to one copy, and scores both. A good lab gives the solved copy about 100 and the untouched copy 60 or less. It also rewrites each task's `manifest.json` and `regression.json` from the solved copy. Run it after changing a task, a test or the baseline.

| Task | Solved | Untouched |
|---|---|---|
| `fix-date-file` | 100 | 37.7 |
| `debug-four-layers` | 100 | 37.6 |
| `labels-feature` | 100 | 40.1 |
| `migrate-status` | 100 | 21.0 |
| `contract-change` | 100 | 57.8 |
| `review-labels-pr` | 100 | 0 |

## Adding a task

Create `lab/tasks/<id>/` with `meta.json` (`id`, `type`, `title`, optional `allowedFiles`), `task.md` (what the model reads), `tests/*.spec.tsx` (hidden tests, titled with `lt(weight, name, fn)` from `lab/support/tags.ts`), `solve.mjs` (a known-good solution applied to a prepared folder) and, when the task starts from a modified repository, `prepare.mjs`. Defects can be taken from `judge/bugs.mjs` with `lab/support/patches.mjs`. A task with its own scoring adds `score.mjs` and sets `"custom": true`. Run `validate`.

## Honest limits

- One run per task and model shows a tendency, not a ranking. The tasks are small enough to repeat if the answer matters.
- The tests only check what each `task.md` says. A model that does something sensible that the task did not ask for is neither rewarded nor punished.
- Everything is one codebase in one language. "Several repositories" is approximated by a consumer outside `src/`, not real packages with versions.
- The review task has a fixed set of 7 defects. A model that finds a real, unplanted defect is counted as a false alarm.

## Free-tier and self-hosted models

The six tasks can be run by any model that has an OpenAI-compatible chat endpoint: a local server (Ollama, LM Studio, llama.cpp, vLLM), a free tier of a hosted provider, or a paid model. `lab/agent/run-model.mjs` drives the model through one small agent loop with the same tools, prompt and limits for everyone:

| Tool | What it does |
|---|---|
| `list_dir`, `read_file`, `search_text` | Look around the repository (reads are capped at 400 lines per call, so small context windows survive) |
| `write_file`, `replace_in_file` | Change files (`replace_in_file` needs the old text to occur exactly once) |
| `finish` | End the run with a summary |

There is no shell, so "no command that runs the project" holds by construction, and file paths cannot leave the repository. The runner records tokens (from the endpoint's `usage` field; estimated and flagged when a local server omits it), cost (from the price in `models.json`, 0 for free and self-hosted), wall time, turns, tool errors and why the run stopped. A model without native tool calling can be set to `"toolMode": "json"`, where it replies with a JSON block instead. Old tool output is dropped when the context window fills (`contextTokens`), and rate limits are retried with a backoff.

### Setting up and running

1. Edit `lab/models.json`: set `enabled`, `model`, `baseUrl`, the price and the context size for each model you want. Model names change often, so check the provider's or your server's current list. Put API keys in environment variables, never in the file.
2. Check the plumbing without any model: `node lab/agent/selftest.mjs` (a mock model; 14 checks).
3. Run one model on every task: `node lab/agent/run-suite.mjs --model ollama-local`, or on some: `--tasks fix-date-file,debug-four-layers`.
4. Compare everything: `node lab/lab.mjs pivot` prints models in rows, grouped by tier (frontier, free-tier, self-hosted), and task types in columns, with average score, cost and time.

Runs of Claude models made through Claude Code agents can sit in the same table: pass `--label` and `--tier` to `judge/audit.mjs`.

### Reading the comparison fairly

- **Same harness for a clean comparison.** The Claude Code agent harness is more capable than the lab loop (better tools, better context handling). To compare models and not harnesses, run the frontier models through the lab loop as well (for example through a provider that serves them over the same API). Claude Code results are still worth keeping, as the "what you get in practice" row, but they differ in two things at once: the model and the harness.
- **Free tiers are not stable.** Models come and go, are rate-limited and may be quantised or truncated, so note the date and the exact model id with every result.
- **Self-hosted costs hardware and time, not tokens.** The table shows $0. Compare wall time and, if it matters, the machine it ran on.
- **Small models fail differently.** Common failures are bad tool-call arguments, edits that do not match exactly once, forgetting to call `finish`, or running out of context. The run report shows these (`toolErrors`, `stopReason`, `trimmedToolOutputs`), so a low score can be traced to a cause.
