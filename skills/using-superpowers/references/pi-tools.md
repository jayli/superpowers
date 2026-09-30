# Pi Tool Mapping

Skills speak in actions ("dispatch a subagent", "create a todo", "read a file"). On Pi these resolve to the tools below.

| Action skills request | Pi equivalent |
| --- | --- |
| Dispatch a subagent (`Subagent (general-purpose):` template) | Call `subagents_enable` first, then `subagent({ agent, task })` — see [Subagents](#subagents) for the agent-name mapping |
| Task tracking ("create a todo", "mark complete") | Use an installed todo/task tool if available, otherwise track tasks in the plan or `TODO.md` |

## Subagents

Pi core does not ship a standard subagent tool. The `pi-subagents` package is a strong optional companion. If no subagent tool is available, do not fabricate `Task` calls; execute sequentially in the current session or explain that the optional subagent capability is not installed.

### Activate the tool before dispatching

On Pi 0.86.1 and later the `subagent` tool starts **inactive**. Call `subagents_enable` before the first dispatch; the tool becomes available on the next model request. Enabling launches nothing and is not a request to delegate.

Some providers — bridges to another agent SDK — fix the tool list for a whole prompt. On those, `subagent` appears only after the next *user* prompt, so do not retry it in the same turn; say you are ready and continue when the next message arrives.

Reaching for `subagent` while it is inactive fails, and the tempting recovery — silently doing the work yourself — is the one outcome the calling skill forbids. If `subagents_enable` is also unavailable, say the capability is not installed, the same as having no subagent tool at all.

### The dispatch templates are not Pi calls

Skills write dispatches as:

```text
Subagent (general-purpose):
  description: "Implement Task N: [task name]"
  model: [MODEL]
  prompt: |
    ...
```

That is prose, not a callable shape. `general-purpose` is a Claude Code agent name and **pi has no agent by that name**; passing it fails with `Unknown agent`. The `prompt:` block is not a `subagent` field either — its contents become the `task` string, and `description` is not a field. Only `model` carries over as written.

Translate the template by intent, then pass a real agent:

| Template intent | Pi agent |
| --- | --- |
| Implement a task | `worker` |
| Review a diff, task by task | `reviewer` |
| Recon before acting: files, entry points, data flow | `scout` |
| Research outside the repo, with sources | `researcher` |
| A second opinion before a risky decision | `oracle` |
| A child that behaves close to the parent session | `delegate` |

### The call shape: one child, or a fanout

Pick the agent from the table above, then pick the shape.

**One bounded child (the common case):**

```js
subagent({ agent: "worker", task: "Implement Task 2: <task text>" })
```

**Parallel fanout — two shapes, and they differ in what you get back.** A skill may say "issue all the dispatches in the same response": Pi does run sibling tool calls from one assistant message in parallel, so several direct `subagent` calls in one turn really do overlap. What that shape does not give you is aggregation — each child lands in its own receipt, and correlating them is your job.

pi-subagents directs fanout through one workflow instead, which returns an ordered array you can destructure:

```js
subagent({ workflowScript: `
  const results = await runs.all([
    { key: "abort",       agent: "worker",  task: "Fix agent-tool-abort.test.ts" },
    { key: "batch",       agent: "worker",  task: "Fix batch-completion-behavior.test.ts" },
    { key: "approval",    agent: "worker",  task: "Fix tool-approval-race-conditions.test.ts" }
  ]);
  return results.map(r => r.output);
` })
```

Use the workflow form when you plan to aggregate, sequence, retry, or steer the children, and keep it to one top-level orchestration call: `runs.all` takes the batch, `runs.run` takes a keyed step, and plain JavaScript between them does the branching. Use sibling direct calls when the children are genuinely independent and you will read each result as it lands. Do not mix the two in one turn — a second top-level orchestration duplicates the first.

Either way the fanout only works for genuinely independent work. Two children editing the same files conflict regardless of how they were launched.

Everything the template puts in `prompt` becomes the `task` string. Read the prompt file the calling skill points at (for example `subagent-driven-development/implementer-prompt.md`) and fold its instructions into that text; do not paste the template's `Subagent (general-purpose):` header through.

Run `subagent({ action: "list" })` to see the agents actually installed — a user or project agent can override a builtin name, and an external CLI agent may exist. Use the installed name.

### Model selection interacts with `subagents.modelScope`

Skills such as `subagent-driven-development` instruct the controller to choose a model per role and always pass it explicitly. Under a configured scope that instruction can abort the run instead of routing it:

```json
{ "subagents": { "modelScope": { "enforce": true, "strict": true, "allow": ["inherit"] } } }
```

`inherit` expands to the parent session's current model. With `enforce: true`, a model outside the allow list is rejected, and the severity depends on where it came from:

| Model source | `strict: false` | `strict: true` |
| --- | --- | --- |
| Explicit — the `model` field on your call | error | error |
| Inherited — parent session, agent frontmatter, `defaultModel` | warning | error |

So under strict scope the *explicit* model the skill demands is refused, and an out-of-scope inherited model is refused too. Before following a skill's model-routing section, check `subagents.modelScope` in the user and project settings. If a chosen model is outside the list, either omit the model and let the child inherit, or ask your human partner to widen the scope — never route around it by editing settings yourself.

Scope is policy, not selection: it rejects or warns, it never picks a cheaper model. If you need a specific child model, put it in `subagents.agentOverrides.<agent>.model` and allow it in the scope.

### Child context is a decision, not a default

Each agent declares `defaultContext`, and it decides whether the child starts clean or inherits your conversation. It is not cosmetic — a forked child receives the parent's history as a branched thread, not a filtered summary of it.

| Agent | `defaultContext` | What the child sees |
| --- | --- | --- |
| `worker` | `fresh` | Its brief only — the unfinished agenda of your session does not steer the implementation |
| `reviewer` | `fresh` | The diff, the brief, and the report; not your reasoning about them |
| `scout` | `fresh` | The task text; recon results come back as compressed context |
| `researcher` | `fresh` | The task text |
| `delegate` | `fresh` | The task text |
| `oracle` | `fork` | Your conversation so far, as a branched thread |

Two consequences worth knowing before you dispatch:

- **Adversarial review wants fresh, and `oracle` is not that.** pi-subagents advises fresh context for adversarial reviewers; forked history for an adversarial reviewer is the classic way an independent check quietly converges on your own framing. For a review seat, dispatch `reviewer` — or pass `context: "fresh"` explicitly if you have a reason to use another agent there. Pass `context: "fork"` only when inherited conversation history is genuinely what the task needs.
- **`oracle` inherits on purpose.** Its job is decision consistency: it needs the inherited state to notice that your current plan drifts from something agreed earlier. Use it for that question, not as a general second reviewer.

Explicit forking needs a persisted parent session with a current leaf. Without one — an ephemeral or headless run — an agent-level `defaultContext: fork` falls back to fresh, while an explicit `context: "fork"` is strict and fails. When a skill says "a fresh subagent" or "a fresh reviewer", fresh context is the mechanism that claim rests on, so verify it rather than trusting the agent name.

### Dispatched children do not inherit your skills

Every builtin pi agent sets `inheritSkills: false`, so a child does not see the Superpowers skill catalog the way you do. A dispatch that says "follow superpowers:test-driven-development" leaves the child unable to read it.

Put the requirement in the `task` text itself, or pass the file path and tell the child to read it (the SDD dispatch templates already work this way: the brief file carries the requirements, and the child reads that). Do not assume a dispatch can hand off a skill by name.

### Resume for fix rounds

Fix loops that say "resume the original implementer" need a run id, so record the `runId` from the dispatch result. Use `subagent({ action: "resume", id: "<run-id>", message })`; inspect a known id with `{ action: "status", id: "<run-id>" }` first. `{ action: "children.list" }` is a workflow-only roster of up to the last 10 retained children — it is not an exhaustive list of direct native children, so a direct dispatch you cannot find there may still be resumable by exact id. Resume performs its own eligibility check and may reject the attempt. Do not use `steer` as the resume action. When resume is unavailable, dispatch a fresh implementer carrying the brief path, the report path, and the findings — the report file is the persistent memory either way.

## Plan mode

Pi ships a plan mode — `enter_plan_mode` and `exit_plan_mode` — that blocks writes while you explore and then submits a plan for approval. The Superpowers skills gate implementation behind a different flow. These are **one design flow, not two**: run one, not both, or you will design twice and ask for approval twice.

- **Already read `brainstorming` this run:** stay in that skill to the end. Its own clarify → options → approval → design-doc flow is the gate, and plan mode's read-only window would only duplicate it. Do not call `enter_plan_mode` for the same task.
- **Not in brainstorming, and the task hits the plan gate:** use plan mode as usual. Inside it, the brainstorming file layout does not apply — write nothing and commit nothing, and let `exit_plan_mode` produce the design document.

Inside plan mode, one-question-at-a-time is `ask_user_question`; the skill's "ask one question per message" is that tool, not a sequence of separate messages.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.
