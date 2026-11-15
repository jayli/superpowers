# Task Budgets

Part of superpowers:subagent-driven-development. An omitted deadline is the
right default on this machine; size the slice instead, and write an explicit
value only when the slice itself outgrows the cap.

**An omitted `timeoutMs` is the right default.** This machine's subagent config
(`~/.pi/agent/extensions/subagent/config.json`) already caps a run at 20 minutes
and asks the child to checkpoint 5 minutes before that, so a dispatch that names
no deadline still stops at a boundary instead of being cut off mid-work.

Write an explicit `timeoutMs` in exactly one case: the slice is itself longer
than 20 minutes (exploration, a gate probe, multi-file integration). Raising it
for an ordinary implementation is what produced the failure below.

An omitted value on a platform *without* such a cap lets that platform decide
when to kill the run — and that kill lands mid-work, not at a natural boundary.
A real session ran 23 dispatches with no timeout set; six hit the platform
default and four of them ended at a deadline checkpoint with nothing committed.

Pair it with `checkpointBeforeDeadlineMs`, which asks the child to *stop and
hand off* before the deadline instead of being cut off at it. The difference
matters: a child that checkpoints commits its work and reports; a child that
is cut off leaves work uncommitted, and the next round redoes it.

| Slice | When to write an explicit value | What to write |
|---|---|---|
| Single-file mechanical change | never | omit both — the config's 20 min / 5 min cap already fits |
| Normal implementation | never | omit both |
| Exploration, gate probe, multi-file integration | only when the slice itself exceeds 20 min | `timeoutMs` above the slice's real length, `checkpointBeforeDeadlineMs` 5 min (`300000`) before it |
| Full test suite, benchmarks | do not dispatch — see below | — |

Read the cap from `~/.pi/agent/extensions/subagent/config.json`. On this machine
it is `timeoutMs: 1200000` (20 min) with `checkpointBeforeDeadlineMs: 300000`
(5 min) — `loadConfig()` reads only that file; `subagents.timeoutMs` in
`settings.json` is never consulted, so setting it there does nothing.

Note the two knobs are not equally broad: `timeoutMs` covers foreground launches
and plain single-agent async runs, while `checkpointBeforeDeadlineMs` applies to
async single-agent runs only — a composite async workflow is unbounded at the
top level, so its children need their own values.

**Long-running validation is the controller's job, not a child's.** Run the
full suite, benchmarks, or any command that outlives a single child turn with
`run_in_background` from the controller session. A subagent's background
tasks are killed when its own run terminates, so a child that backgrounds a
long command and ends its turn orphans the work — a real session lost a full
E2E run this way and had to diagnose the dead process by watching file size.

**Size the budget to the slice, not to the task.** A worker asked to land a
whole task in one 60-minute run has no safe place to stop; a worker asked for
a slice that ends in a commit can be cut anywhere without losing ground.
Prefer several bounded dispatches that each end in a commit over one long one.
