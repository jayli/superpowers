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

So a full dispatch reads:

```js
subagent({ agent: "worker", task: "Implement Task 2: <task text>. Read <brief path> first..." })
```

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

### Resume for fix rounds

Fix loops that say "resume the original implementer" need a run id, so record the `runId` from the dispatch result. Use `subagent({ action: "resume", id: "<run-id>", message })`; inspect a known id with `{ action: "status", id: "<run-id>" }` first. `{ action: "children.list" }` is a workflow-only roster of up to the last 10 retained children — it is not an exhaustive list of direct native children, so a direct dispatch you cannot find there may still be resumable by exact id. Resume performs its own eligibility check and may reject the attempt. Do not use `steer` as the resume action. When resume is unavailable, dispatch a fresh implementer carrying the brief path, the report path, and the findings — the report file is the persistent memory either way.

### Dispatched children do not inherit your skills

Every builtin pi agent sets `inheritSkills: false`, so a child does not see the Superpowers skill catalog the way you do. A dispatch that says "follow superpowers:test-driven-development" leaves the child unable to read it.

Put the requirement in the `task` text itself, or pass the file path and tell the child to read it (the SDD dispatch templates already work this way: the brief file carries the requirements, and the child reads that). Do not assume a dispatch can hand off a skill by name.

## Task lists

Pi core does not ship a standard task-list tool. If a todo/task extension is installed, use its documented tool. Otherwise use Superpowers plan files, checklists in Markdown, or a repo-local `TODO.md` for task tracking. Older Superpowers docs may refer to `TodoWrite`; treat that as the task-tracking action above.
