# claude-mods

Claude Code mods (plugins of function hooks) by Joan Velja.

## now-doing

A briefing band above the prompt for people who run many Claude Code sessions at once and come back to them after a while. One glance tells you whether the session is waiting on you, what it's waiting on, what came out while you were away, and whether its agents are still alive.

```
 now-doing  ◆ 2 open asks · 47m   Ship the release                     ← tinted strip

▌ Q2. Tag rc1 now, or wait for the GPU drills?                     3h
▌ • Delete the 12 scratch checkouts?                              47m

  spend ⚡ alloc 6841372 · 8h34m left
  found 848 passed, 10 known failures · drills blocked: budget out
  next  tag rc1 → GPU drills → promote to main
  plan  ▰▰▱▱▱ 2/5 · tag rc1

  ├ w-lora   fullgraph benches                       ● 2h · active 7m
  └ w-tree   GPU equivalence run                 ● 3h · ⚠ silent 48m
```

### Install

In a Claude Code terminal session:

```
/plugin install now-doing --marketplace joanvelja/claude-mods
```

Answer `y` to add the marketplace, then pick the user scope. New sessions load it. In a session that's already running, `/reload-plugins` should pick it up; if it doesn't, restart the session.

### What the card shows

The band is blocks separated by blank rows: a header strip, the asks, progress, and the workers. The strip is tinted with your theme's prompt background.

- **The header** shows the session's state: `◆ waiting on you`, `▸ working`, `▲ stuck`, `✗ errored` or `✓ done`. It also shows how long it's been in that state, how many asks are open, and the mission: the session's long-running goal, which a side request doesn't replace. If the summarizer has stopped or stalled, the reason replaces the mission.
- **Asks** (yellow bar): every question or decision the agent left for you, oldest first. Each keeps the agent's own label (`Q3.`), or gets a bullet if it had none. Each shows its age once it has been open a minute.
- **spend:** paid or scarce resources being held right now, such as cluster allocations, cloud VMs or remote shells.
- **found:** results, numbers and errors since you last sent a prompt, newest first. A finding restated in other words shows once.
- **next:** the next steps.
- **plan:** progress through the session's task list.
- **The tree:** each subagent and background shell, with its last activity. `⚠ silent` appears after 10 minutes without activity.

The band stays expanded while you type. Once you send a prompt or a slash command, it collapses to the header and the open asks for 2 minutes. When rows run short (say, while the prompt grows), the workers give way first, then the blank rows, then progress. Asks give way only to the header.

### Open asks

An ask stays on the card until you answer it or the agent resolves it itself. It never drops off just because its message scrolled away or the summary was reworded.

- **Opening:** the model may only open an ask by quoting the agent's own words. The code checks that the quote is really there.
- **Answering:** answer however you like: by number (`Q7. yes`, `decisions 2 and 4: go`), by quoting the question, or just by saying what you decided. The summarizer judges whether your prompt resolves the ask. A clarifying question back, a redirect or a partial answer leaves it open.
- **Code checks on closing** (the model can't override these):
  - only your own prompts count; teammate and agent messages, notifications and compaction summaries don't;
  - a bare `go` answers one ask, once;
  - a closed ask can't be reopened from its old sentence;
  - quotes must match whole words.

### Commands

| Command | What it does |
|---|---|
| `/now-doing` | Refresh now, and clear a stopped state |
| `/now-doing asks` | List every open ask, with its age and the agent's own words |
| `/now-doing sync` | Open the full briefing in a side pane |
| `/now-doing status` | Model, last error, age of the last summary, calls in flight |
| `/now-doing off` / `on` | Hide the card (no model calls while hidden) / show it |

### Cost and privacy

- **Model:** summaries come from `claude-haiku-5-5`, called through the session's own client and credentials (`$.model.complete`). No other service is involved and nothing needs signing in.
- **What's sent:** excerpts of the session's transcript (your prompts, the agent's messages, short tool and agent summaries), kept under 100k tokens per call.
- **How often:**
  - at most one call per 45 s, and only while the transcript is changing;
  - one at the end of each turn;
  - one per prompt you send (the mission check).
- **Size and price:** about 9–10k tokens in and 0.5–2k out per call. At Haiku 5.5's list price ($0.10/$0.50 per million tokens) that's about $0.002 per call, so a busy hour costs cents. On a subscription it counts toward your usage limits.

### Requirements

- A Claude Code build with function-hook plugins (developed on 2.1.291; the API is early access and may change between releases).
- Access to `claude-haiku-5-5` on your account.

### Known limits

- **Re-asked questions:** when the agent re-asks a question under a new label (`Q5` later becomes `(a)`), it shows twice. Different labels are never merged, because merging made distinct asks disappear.
- **Answers that end in `?`:** a reply ending in `?` counts as a question back. To close the ask with it, answer and then ask separately, or lead with the answer (`Q2 keep`).
- **Line-leading ranges:** a range at the start of a line, such as `10-15:`, can be read as answering asks 10–15.
- **Subagent shells:** background shells started inside subagents are tracked, but no test covers that path.

### How it was checked

- **Replay:** the card's prompts were evaluated offline on 22 real "came back after idling" moments from a 16-day research session, with hand-labelled ground truth and 3 samples per point. The final build catches about 80% of open asks at the return, and 0 of 59 accepted closes were wrong.
- **Experiment:** removing word-matching heuristics from the close checks recovered 12 real answers they had refused, without adding a single wrong close.
- **Tests:** 185 behaviour specs in `now-doing/tests` (`claude plugin test now-doing`).

## License

MIT, see [LICENSE](LICENSE).
