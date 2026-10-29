# Presenting the benchmark

The story in one line: **one mission, seven setups, one report. Which setup is good enough for which job, and what does each cost in money, time and privacy?**

Everything below assumes the deck "Inference at the Edge of Your IDE" (22 slides) and the commands in [WORKSHOP.md](WORKSHOP.md). All commands run from `bench/task-board`.

## The mission and the seven setups

The mission is [mission.md](mission.md): add labels to tasks across about 20 files of a small React app. Every setup gets exactly that text as `MISSION.md` in a fresh folder, works in one pass, and is scored by hidden tests it never sees.

| # | Setup | Command |
|---|---|---|
| 1 | Sonnet alone | `node lab/workshop/bench.mjs run 1` |
| 2 | Sonnet orchestrates, Haiku implements | `node lab/workshop/bench.mjs run 2` |
| 3 | DeepSeek V4 Pro alone | `node lab/workshop/bench.mjs run 3` |
| 4 | V4 Pro orchestrates, V4 Flash implements | `node lab/workshop/bench.mjs run 4` |
| 5 | V4 Flash orchestrates, local Gemma 4 implements | `node lab/workshop/bench.mjs run 5` |
| 6 | Local Qwen 3.5 alone | `node lab/workshop/bench.mjs run 6` |
| 7 | Local Qwen 3.5 orchestrates, local Gemma 4 implements | `node lab/workshop/bench.mjs run 7` |

At the same time: `node lab/workshop/bench.mjs run-all --only 1,2,3,4 --parallel`. The report: `node lab/workshop/bench.mjs report --open`.

## Before the day (do this at home)

1. `node setup.mjs` on Node 22.22+ or 24.15+. It installs the harness and the scorer and finds your local models.
2. Export your OpenRouter key (`export OPENROUTER_API_KEY=...`). Sign in to Claude Code.
3. Pull the local models and start the server with a large enough context, for example `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`. Run `node setup.mjs --check` and read the model names it prints.
4. **Run all seven once on the real mission** and keep the results folder (`~/task-board-bench`). That is your fallback report if the network or a local run fails on the day. Local runs on a laptop are slow, so do not plan to run them live from scratch.
5. Cost to expect for that dry run: setups 3 to 5 are cents to under a dollar. The two Claude setups are the expensive ones (a few dollars each on the hard mission, counted against your Claude plan). Local runs cost no money.

## Run of show (90 minutes)

The trick is to **start the runs early and teach while they run**. A hard-mission cloud run takes about 8 to 15 minutes, which is exactly the time the concept slides need.

| Min | Segment | Deck slides | What you do |
|---|---|---|---|
| 0–8 | Why | 1 Title, 2 Goals, 3 The big picture | Three choices stack: the coding agent, where the model runs, which model. Say the point: the best model is not always the right model |
| 8–14 | The mission | 4 The path ahead | Show `mission.md` and `bench.mjs setups`. Change the slide to "seven setups, one mission" (see below) |
| 14–20 | Everyone's ready | 5 Setup before we start | `node setup.mjs --check`, key exported, scorer installed |
| 20–22 | **Start the cloud runs** | none | `run-all --only 1,2,3,4 --parallel`. Attendees run their own pick of 3 and 4 |
| 22–50 | Teach while they run | 8 Stop 1, 10 Stop 2, 12 Stop 3, 14–15 harness and OpenRouter, 16 Stop 5, 18 Stop 6, 20 Stop 7 | Present each stop as "this is setup N, running right now". Slide 10 (context rot) is the reason sub-agents matter for small models |
| 50–60 | Cloud results | live report | Open the report. Read the scoreboard, then the "what the numbers say" box |
| 60–78 | Local | new slides (see below) | Setups 5, 6, 7. Show your pre-run results. Run the easy mission live on one local setup: `bench.mjs run 6 --task fix-date-file` |
| 78–86 | Decide | report, WORKSHOP.md decision table | Fill in: which model for which job. Privacy: run a local setup with Wi-Fi off |
| 86–90 | Close | 22 Thank you | What to try next: change the mission with `--task` |

## How to talk through the report

1. **Scoreboard first.** Score, then cost, then time. A setup that scores the same for less money is the story.
2. **Compare the pairs.** 1 against 2, 3 against 4, 6 against 7: what did adding sub-agents change in score, cost and time? The report prints this for you.
3. **Look at the Rules column.** A setup that was meant to use sub-agents but did the work alone, or an orchestrator that edited files itself, is not a clean example. Say so out loud. (On our easy-mission test, setup 5's orchestrator edited files itself, and the report flagged it.)
4. **Local against cloud.** Local costs $0 in money and costs time, memory and power. In our easy-mission test, local Qwen 3.5 scored 68.8 alone and 41.2 with Gemma 4 as the implementer, against 100 for the cloud setups. Orchestration did not rescue the small models. Check whether your own hard-mission run says the same.
5. **Close on honesty.** One run is a sample, not a ranking. The same model scored 100 three times and then 46.5 on one easy task.

## Changes to make to the deck

The deck was built for building Agent Clinic in four setups. For the benchmark:

- **Slide 4 (path ahead):** change "four setups, one app" to "seven setups, one mission". Use the table above.
- **Slides 6 and 7 (specs, project kickoff):** these describe the spec files and the project folder, which the repo no longer has. Replace them with "The mission" (show `mission.md`) and "Run it" (the two commands).
- **Results slides 9, 11, 13, 17, 19, 21:** these ask people to fill in a table by hand. Replace them with the live report. The report already has turns, tool calls, tokens, number of sub-agents, main agent against sub-agents, cost and time.
- **Add three stops** for setups 5, 6 and 7 (hybrid, local alone, local orchestrating). The deck introduces them on slide 4 but has no slides for them.
- **Names:** some slides and notes say "Prompt Pantry" and others "Agent Clinic". Pick one, or drop both.

## What is tested and what is not

- Tested: all seven setups on the easy mission, including setups 1 to 4 running at the same time. The orchestrators made no edits in setups 2 and 4, the sub-agent split and the exact cost were recorded, and the report builds.
- Not tested: the seven setups on the hard mission, and a real local server. Our local runs used OpenRouter's copies of Qwen 3.5 and Gemma 4 as stand-ins, so their numbers are not what your laptop will give.
- Time comparisons are only fair for runs done one at a time.
