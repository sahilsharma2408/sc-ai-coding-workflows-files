# The model ladder: pick the cheapest model that is good enough

A hands-on part of *Inference at the Edge of Your IDE*. Attendees run the same coding jobs, from easy to hard, with different models in the DeepSeek harness through OpenRouter. They score each result and see time and cost side by side.

**The point to land:** the best model is not always the right model. An easy job on a cheap model can score as well as on a strong one, at a fraction of the cost. A hard job can expose the cheap model. And some jobs should run on a local model whatever the score, because the code is private or the network is not there.

## What attendees need

| Need | How |
|---|---|
| The workshop repo and the harness | `node setup.mjs` (see the root README) |
| The scorer | `node setup.mjs` installs it (about 170 MB, do it at home). Use `--skip-bench` to skip it |
| An OpenRouter key | Their own, or the workshop key from the speakers. Export it as `OPENROUTER_API_KEY`. If it is missing, `setup.mjs` and `ladder.mjs run` ask for it (hidden, not saved) |
| A local model (optional) | A runtime added as a custom provider, see `harness/README.md` |

## The ladder

Three scored jobs and one review job. Each works on the Task Board app, a small React and TypeScript Kanban board in `bench/task-board/reference`.

| Level | Task id | The job | What it shows |
|---|---|---|---|
| Easy | `fix-date-file` | Three date bugs, all in one file | Cheap models often do as well as strong ones |
| Medium | `debug-four-layers` | Four bugs in four layers, with no stack traces | Where cheap models start to slip |
| Hard | `labels-feature` | Add a feature across about 20 files | Planning and keeping many files consistent |
| Review | `review-labels-pr` | Read a pull request and report 7 planted defects | A good job for a local model, because the code never leaves the laptop |

Measured time per run on the cloud models: about 2 to 3 minutes for easy, 2 minutes for medium and 8 to 13 for hard. A local model will be slower. In a 90-minute session, give everyone easy and medium, and run hard as a group or on one model only.

## The mission file

Every run gets a folder with a `MISSION.md` in it. That one file is what you hand to the model. It holds the job, the rules of the run, what "done" means and how the work will be judged. It is filled in from `mission.template.md` in this folder, so you can change the wording there.

| Section | What it says |
|---|---|
| The mission | The job, in plain words (for example, three date bugs reported by users) |
| The project | The Task Board app, and that `README.md` holds the house rules |
| Rules of the run | One pass. Do not run the project. At most 3 sub-agents. Stay inside the folder |
| Done means | What must be true at the end |
| How you will be judged | The score parts, without the hidden tests |
| When you finish | A short note: what changed, and what you were unsure about |

`ladder.mjs run` passes it to DeepSeek for you with this prompt: *"Read MISSION.md in this folder and carry out the mission. Follow its rules of the run."* In the web UI, open the folder and send the same sentence. `MISSION.md` is ignored by the scorer, so it never counts as a change.

## How the benchmark works, end to end

1. **Setup.** `start` copies the Task Board app into a fresh folder, writes `MISSION.md`, and notes the time and the key's spending so far.
2. **One pass.** The model reads the mission and edits files. It may not run the project, so there is no run, check, fix loop. This is what makes weaker models show.
3. **Judging.** `finish` stops the clock and scores the folder with tests the model never saw. The score is out of 100: the mission itself 60, the behaviour that already worked 25, and hygiene 15 (type-check, build, staying in scope, keeping existing tests). Each part is curved, so "almost right" earns much less. A failed build caps the score at 60.
4. **Cost and time.** Cost is the change in the key's spending between start and finish. Time is the wall clock between the same two points.
5. **The table.** One row per model, one column per level. Compare the cheapest model that scores well with the strongest one, and read the cost and time columns next to the score.

What the numbers can and cannot say: **one run is a sample, not a ranking.** In our own testing the same cloud model, on the same easy task, scored 100 three times and then 46.5 once, because it fixed two of the three bugs and stopped. For a point you care about, run it twice. A "!" next to a score means the model changed no files, so the score is just the untouched-folder score and the run did not work.

## One run, in one command

The harness has a headless mode (one task in, one answer out), so a whole run is a single command. It makes the folder, starts the clock, sends the prompt through the harness, scores the result and records time and cost.

```bash
export OPENROUTER_API_KEY=your-key-here       # use the variable name the harness expects
cd sc-ai-coding-workflows-files/bench/task-board
node lab/workshop/ladder.mjs run fix-date-file --model flash     # flash and pro are built in
node lab/workshop/ladder.mjs table
```

For any other OpenRouter model, add `--id vendor/model-name`. The harness overlay that makes this work is `openrouter.patch.yml` in this folder. It holds only the name of the key variable, never the key.

## Comparing with a model on your own laptop

Anyone with a local model can add a row to the same table.

1. Start a local runtime (Ollama, LM Studio or llama.cpp) and load a model that supports **tool calls**. A model without tool calling cannot edit files in the harness.
2. Run `node setup.mjs --check`. The "Local models" section lists the server it found and the model names.
3. Run a task, giving the model name exactly as your runtime lists it:

```bash
node lab/workshop/ladder.mjs run fix-date-file --model local-qwen --local --id qwen3-coder:30b
```

| Option | Default | What it does |
|---|---|---|
| `--local` | off | Use `local.patch.yml` and a server on this laptop instead of OpenRouter |
| `--id` | none, required | The model name as the runtime lists it |
| `--base-url` | `http://127.0.0.1:11434/v1` (Ollama) | LM Studio is `http://127.0.0.1:1234/v1`, llama.cpp is `http://127.0.0.1:8080/v1` |
| `--context` | `32768` | Context window in tokens. **Set the server's context length to the same number**, or it may cut the prompt without telling you |
| `--timeout` | `30` | Minutes before the run is stopped and scored as it stands |

The cost is recorded as $0. Say out loud that it still costs time and laptop power, and compare the time column. Nothing leaves the laptop, so this is also the row for the privacy and offline demo.

Things that go wrong with local models: no tool-call support (llama.cpp needs `--jinja`), a context window that is too small, and very slow runs without a GPU or Apple silicon. A run that is stopped by the timeout is still scored, and a low score there is a real result.

### Running the cloud model and the local model at the same time

`compare` runs one cloud model and one local model on the same task together and prints them side by side. It waits for both and shows a table.

```bash
node lab/workshop/ladder.mjs compare fix-date-file --cloud flash --local local-qwen --local-id qwen3-coder:30b
```

It also takes `--cloud-id` (any OpenRouter model), `--base-url`, `--context`, `--timeout` and `--again`. It checks the local server first, so nothing is started and no money is spent if the local model is missing.

What to know when you run both at once:

| Point | Detail |
|---|---|
| Scores and cost | Not affected. Each run has its own folder, and the local run does not touch your OpenRouter key |
| Time | Not a fair comparison. Both share the CPU of one laptop, so the local model can run slower while the cloud run and the scoring are busy. Compare time in a separate, one-at-a-time run |
| Cost with two cloud models | Do not run two cloud models together on one key. The cost is read from the key's total spending, so the two runs would be mixed up |
| Memory | The local model already needs most of your memory. Close other heavy apps |

**Use a coding or instruct model, not a "thinking" model, for the local route.** In our testing, DeepSeek V4 Flash (a model that reasons aloud) went through the local route twice and made no edits: one run stopped after 1.4 minutes and the other ran until the 30-minute limit. The same model works through the cloud route. A non-reasoning coder model, Qwen3-Coder 30B-A3B, scored 100 through the same local route. We do not yet know why reasoning models fail there, so check any new local model on the easy task first. The tool now warns when a run changed no files.

## One run, step by step (the manual way, using the web UI)

Use a short label for the model, such as `flash`, `pro` or `local-8b`.

```bash
cd sc-ai-coding-workflows-files/bench/task-board

# 1. make the folder and start the clock
node lab/workshop/ladder.mjs start fix-date-file --model flash

# 2. open that folder in the harness, choose the model, send the prompt the tool printed, once
#    (no second tries: one pass is part of the test)

# 3. when the model says it is done, score it
node lab/workshop/ladder.mjs finish fix-date-file --model flash

# 4. after a few runs, see your table
node lab/workshop/ladder.mjs table
```

The folder is made under `~/task-board-ladder/`. The model sees the repository and a `TASK.md` with the job and the rules. It does not see the hidden tests.

### Cost

The tool reads the spending of your `OPENROUTER_API_KEY` at start and at finish and shows the difference. Two cases need care:

- **Shared key.** If several people use one key at the same time, the difference is wrong. Read the cost for your run from the OpenRouter activity page and pass it: `finish ... --cost 0.013`.
- **Local model.** The cost is $0 in money. Say out loud that it still costs time and laptop power.

## How a run is scored

Out of 100. Each part is curved, so a half-working fix earns well under half of the points.

| Part | Points | Question |
|---|---|---|
| The task's own tests | 60 | Did it fix or build what was asked? |
| Existing behaviour | 25 | Did it break anything that worked? |
| Hygiene | 15 | Does it type-check and build, stay in scope, and keep the existing tests? |

A failed build caps the score at 60. The review task is scored on how many of the 7 defects were found, with a penalty for false alarms.

## Suggested model lineup

The speaker fills in the last row.

| Label | Model | Role in the story |
|---|---|---|
| `flash` | DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`) | The cheap cloud model |
| `pro` | DeepSeek V4 Pro (`deepseek/deepseek-v4-pro`) | The strong cloud model |
| `local-...` | A model on the attendee's laptop | The private and offline option |

The two DeepSeek IDs are the ones already checked in `harness/README.md`. Claude Code can be a fourth row for anyone who has it, using the same ladder, but it is a different harness, so say so.

## The decision table (fill it in as a room)

| If the job is... | Use | Because |
|---|---|---|
| Easy and common | Cheap cloud | Same score, lower cost (check the table) |
| Hard or spread over many files | Strong cloud | The cheap model's score falls (check the table) |
| On private code, or with no network | Local | Nothing leaves the laptop. Accept slower and weaker |

The room's results decide whether the first two rows are true. If they are not, say so. That is the lesson too.

## Privacy and offline demo (5 minutes)

Run the review task on a local model with Wi-Fi switched off. It still works. Then say plainly what the cloud runs sent to OpenRouter: the task text and the files the model read.

## Fair-play notes to say out loud

- One run per model and task shows a tendency, not a ranking. Models vary from run to run.
- The harness is the same for every model in the table, but a local model may fail for a different reason, such as no tool-calling support or a context window that is too small.
- Do not tell the model what the tests check. The hidden tests are the whole point.

## Suggested 90-minute plan

| Minutes | Segment |
|---|---|
| 0 to 10 | Why: cost, speed, privacy. Show the Task Board and the idea of one pass with a score |
| 10 to 20 | Demo: easy task on `flash`, live, start to table |
| 20 to 45 | Everyone: easy and medium on `flash` and `pro` |
| 45 to 60 | Everyone: the same on a local model |
| 60 to 75 | Hard task, one model each, or the speaker runs it |
| 75 to 85 | Privacy and offline demo, then the review task |
| 85 to 90 | Fill in the decision table from the room's results |

## Tested on 2026-10-29

Run through the harness (`@deepseek-ai/dsh` 0.2.1, headless) on OpenRouter, one run per cell, Node 24:

| Model | Easy | Medium | Hard | Total cost | Total time |
|---|---|---|---|---|---|
| DeepSeek V4 Flash | 100 (3.0 min, $0.016) | 100 (2.2 min, $0.051) | 100 (8.5 min, $0.161) | $0.23 | 13.6 min |
| DeepSeek V4 Pro | 100 (2.6 min, $0.032) | 100 (1.7 min, $0.093) | 99.8 (12.8 min, $0.501) | $0.63 | 17.1 min |

- The overlay file works, and `--model` switches models through `DSH_MODEL`.
- In the one run whose session log was read (easy task, Flash), the model only read, searched and edited files, and ran no commands.
- The cost from the ladder tool matched the key's total usage on OpenRouter for the first run ($0.0164).
- The setup script needs Node 22.22+ or 24.15+. Node 20 is refused.
- The mission file (`MISSION.md`) is read by the harness, and a solved run still scores 100 with it in the folder.
- Cloud and local at the same time (`compare`): both ran at once and finished separately. The local route was tested by pointing it at OpenRouter, since there was no local server on the test machine. Qwen3-Coder 30B-A3B scored 100 in 2.5 minutes. A teammate's commit (which resolves Ollama model tags) describes a run against a real Ollama server.
- Variation: cloud Flash on the easy task scored 100, 100, 100 and then 46.5 (two of three bugs fixed). Show this honestly.

## Still to verify

- **TODO(verify):** a local model that handles tool calls on a typical attendee laptop, and how long the medium task takes on it. We tested the local route (`--local`, `local.patch.yml`) by pointing it at OpenRouter, not at a real local server, so check it once on your own machine.
- **TODO(verify):** why a reasoning model makes no edits through the local route. We saw it with DeepSeek V4 Flash and have not found the cause.
- **TODO(verify):** the web UI route (adding the provider by hand) on a clean machine. Only the headless route was tested.
- **TODO(verify):** a shared workshop key. Cost is measured per key, so simultaneous runs on one key will give wrong costs. Use `--cost`.
- Both cloud models passed all three jobs, so this ladder does not yet show where a cheap model fails. A small local model or a harder job is needed for that. Run it once yourselves before the day and keep the table as a fallback in case the network fails.
