# Waiting on Dispatched Subagents

Part of superpowers:subagent-driven-development. The wait contract differs by
platform; pick the branch that matches your harness before you call any wait
tool.

**Check your platform before you choose a wait.** On a platform where a
completed child *wakes the parent session natively* (pi, and any harness
with an async completion notifier), do not call a blocking wait tool for a
dispatched subagent at all: launch the child, then end the turn or do
other work, and let the completion wake you. The wait there buys nothing
and costs the whole wait in wall clock — it silently converts a parallel
workflow into a serial one. Reserve the blocking wait for provider or
detached work that has no wake path.

On a platform with no native wake (Claude Code, Codex), when you are
genuinely idle, wait in bounded stretches (five to ten minutes, where
your platform allows), and between stretches post one line of status and
reconcile your live children: list them, and chase any that finished
without reporting. A bounded stretch keeps nearly all of a long wait's
efficiency while guaranteeing a stuck or lost child is noticed within
minutes, not at the end of the session.
