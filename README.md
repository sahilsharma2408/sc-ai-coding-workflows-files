# Inference at the Edge of Your IDE

Companion files for the workshop *Inference at the Edge of Your IDE: Agentic React Development from Cloud LLMs to On-Device Models*.

In the workshop you run the same coding jobs, from easy to hard, with different models in the DeepSeek harness: cloud models through OpenRouter and a model on your own laptop. Each result is scored out of 100, with the time and cost beside it. The point is to see which model is good enough for which job, when a cheaper model is the better value, and when you should use a local model because the code is private or the network is not there.

## How to use this repo

Run `node setup.mjs` at home (see [Before you arrive](#before-you-arrive)). At the workshop, follow [bench/task-board/lab/workshop/WORKSHOP.md](bench/task-board/lab/workshop/WORKSHOP.md).

| Path | Purpose |
|---|---|
| `setup.mjs` | Pre-workshop setup and check script (see [Before you arrive](#before-you-arrive)) |
| `test/` | Tests for `setup.mjs`, including Docker sandbox runs |
| `bench/task-board/` | Benchmarks for coding models: a build-from-spec benchmark and a task-type lab (single-file fix, multi-file debug, cross-file feature, migration, contract change, code review) with hidden tests, scorers and a token and cost audit. See its [README](bench/task-board/README.md) and the [lab README](bench/task-board/lab/README.md) |
| `bench/task-board/lab/workshop/` | The workshop benchmark: one mission given to seven setups (Claude Code and the DeepSeek harness, cloud and local models, with and without sub-agents), run one at a time or in parallel, with an HTML report of score, cost, time and tokens. Start with [WORKSHOP.md](bench/task-board/lab/workshop/WORKSHOP.md), the mission in [mission.md](bench/task-board/lab/workshop/mission.md), and the talk plan in [PRESENTING.md](bench/task-board/lab/workshop/PRESENTING.md) |
| `bench/task-board/lab/workshop/live/` | The live-demo run sheet: [prompts.html](bench/task-board/lab/workshop/live/prompts.html) has the launch command and prompt for each of the seven setups, each with a copy button, plus the DeepSeek harness patch files (`s3` to `s7`) it points to. See [Following the live demo](#following-the-live-demo) |
| `bench/task-board/lab/workshop/slides/` | The workshop slide deck as source files (`project/deck.json` and one HTML file per slide, speaker notes included) |
| `bench/task-board/lab/workshop/reports/` | A saved benchmark report, [report-fix-date-file.html](bench/task-board/lab/workshop/reports/report-fix-date-file.html), for the easy `fix-date-file` task. Open it in a browser |
| `harness/README.md` | Draft notes for connecting the DeepSeek harness to OpenRouter and local models, and for subagent models |
| `.gitignore` | Excludes `node_modules`, build output, local env files and editor files |

## Before you arrive

Do this at home. The setup downloads about 1 GB, which conference Wi-Fi won't handle for a full room.

### 1. Install two things by hand

- [Git](https://git-scm.com/downloads/)
- [Node.js](https://nodejs.org/), current LTS: 22.22+ or 24.15+ (the workshop's test tools don't run on Node 20)

### 2. Clone the repo and run the setup script

```bash
git clone https://github.com/sahilsharma2408/sc-ai-coding-workflows-files.git
cd sc-ai-coding-workflows-files
node setup.mjs
```

The script works on macOS, Linux and Windows. It:

- checks Git, your Git identity, Node.js, npm and your editor
- checks Claude Code is installed and signed in, and offers to install it
- downloads the DeepSeek harness (about 900 MB, a few minutes), starts its web UI on `127.0.0.1:3080` (or the next free port up to 3089, if another app uses it) to check it works, then stops it
- checks that the DeepSeek models are on OpenRouter and checks your key. It reads `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`) from your terminal and **asks for one if neither is set**. The key is never saved or printed
- installs the scorer for the model ladder in `bench/task-board` (about 170 MB, skip with `--skip-bench`)
- looks for a model server already running on your laptop (Ollama, LM Studio or llama.cpp) and lists its models
- says whether your laptop can handle local models

It ends with a summary, then opens the DeepSeek web UI in your browser and leaves it running (not with `--check`). Fix anything marked ✖ before the workshop. Items marked ! are worth a look but won't block you. Run `node setup.mjs --check` on the day to recheck without changing anything, and `node setup.mjs --help` for all options.

### 3. Models and keys

| What | Who provides it |
|---|---|
| **DeepSeek V4 Pro and V4 Flash on OpenRouter**, the cloud models in the comparison | **We do, if you need it.** Bring your own [OpenRouter key](https://openrouter.ai/keys) with about $10 of credit if you can, which covers the whole workshop. Without one, ask the speakers at the start of the session for a workshop key with limited credit. |
| **A model on your laptop** (optional) | **You.** Run Ollama, LM Studio or llama.cpp with a model that supports tool calls. See [WORKSHOP.md](bench/task-board/lab/workshop/WORKSHOP.md#comparing-with-a-model-on-your-own-laptop) |
| **A frontier coding agent** (optional): Claude Code with a paid plan or an API key | **You.** It is a different harness from the one in the ladder, so treat it as a side comparison. We can't provide this access. |

The ladder reads your key from the terminal it runs in, so export it first:

```bash
export OPENROUTER_API_KEY=your-key-here        # macOS / Linux
$env:OPENROUTER_API_KEY = "your-key-here"      # Windows PowerShell
```

If you forget, the ladder asks for it (hidden, not saved). Copy an OpenRouter key when you create it, because you can't view it again. Never commit it to Git.

### 4. Also install

- An editor: [Orca](https://www.onorca.dev/) or [VS Code](https://code.visualstudio.com/download)
- Optional: the DeepSeek harness [desktop app](https://www.deepseek.com/en/harness/) (macOS on Apple silicon, or Windows). The web UI the script sets up works too: `npx @deepseek-ai/dsh web`

### Hardware

Running a model on your own laptop works best with Apple silicon or a GPU with 16 GB+ of memory. On a smaller machine you can still compare the cloud models.

### Helpful to know

- Basic Git and terminal use
- React, TypeScript, Vite and Vitest
- Some experience with an AI coding agent

### Testing the setup script

```bash
node --test test/setup.test.mjs   # unit and integration tests, no network or keys needed
node --test test/bench.test.mjs   # the benchmark report, usage parser and setup list, no network needed
test/sandbox.sh                   # full runs in clean Docker containers (Node 22 and 24; Node 18 and 20 must be rejected)
```

## Following the live demo

1. Open `bench/task-board/lab/workshop/live/prompts.html` in your browser.
2. Run the one-time "Before you start" step to create the seven mission folders.
3. Open one terminal per setup, copy its command and prompt with the Copy buttons, and run them.
4. Open `bench/task-board/lab/workshop/reports/report-fix-date-file.html` to compare with a finished run.

The run sheet assumes the repo is at `~/workspace/sc-ai-coding-workflows-files`. If you cloned it somewhere else, edit the `REPO` line at the top of the script in `prompts.html`, and the `L=` line in its "Before you start" box.

## Credits

This repository began from the course materials for [*AI Coding Workflows: From Cloud to Local*](https://www.deeplearning.ai/) by DeepLearning.AI, built in partnership with JetBrains (original files: [https-deeplearning-ai/sc-ai-coding-workflows-files](https://github.com/https-deeplearning-ai/sc-ai-coding-workflows-files)). The course-derived app specs, prompts and demo app have been removed. What remains was written for this workshop: the benchmark, the model ladder, the setup script and the harness notes. The upstream repository does not state a license, so contact DeepLearning.AI before reusing any of its material.
