import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');
const packageJsonPath = resolve(repoRoot, 'package.json');
const extensionPath = resolve(repoRoot, '.pi/extensions/superpowers.ts');
const piToolsPath = resolve(repoRoot, 'skills/using-superpowers/references/pi-tools.md');

const BOOTSTRAP_CUSTOM_TYPE = 'superpowers-bootstrap';
const BOOTSTRAP_MARKER = 'using-superpowers bootstrap for pi';

async function readPackageJson() {
  return JSON.parse(await readFile(packageJsonPath, 'utf8'));
}

async function loadExtension() {
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
  };
  const mod = await import(pathToFileURL(extensionPath).href + `?cachebust=${Date.now()}-${Math.random()}`);
  mod.default(pi);
  return { handlers };
}

function firstHandler(handlers, event) {
  const eventHandlers = handlers.get(event) ?? [];
  assert.equal(eventHandlers.length, 1, `expected one ${event} handler`);
  return eventHandlers[0];
}

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/**
 * A pi context stub whose projection is the source of truth for dedup.
 * `entries` stands in for `sessionManager.buildContextEntries()`.
 */
function makeCtx(entries = []) {
  return { sessionManager: { buildContextEntries: () => entries } };
}

/** Shape of the persisted entry `before_agent_start` produces, as pi stores it. */
function persistedEntry() {
  return { type: 'custom_message', customType: BOOTSTRAP_CUSTOM_TYPE };
}

test('package.json declares a pi package with skills and extension resources', async () => {
  const pkg = await readPackageJson();

  assert.equal(pkg.name, 'superpowers');
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi.skills, ['./skills']);
  assert.deepEqual(pkg.pi.extensions, ['./.pi/extensions/superpowers.ts']);
});

test('extension registers persistence and safety-net hooks', async () => {
  const { handlers } = await loadExtension();

  for (const event of ['resources_discover', 'before_agent_start', 'context']) {
    assert.equal((handlers.get(event) ?? []).length, 1, `missing ${event} handler`);
  }
  // Regression guard: a per-turn `agent_end` reset is what made the bootstrap
  // single-turn. Its absence is now part of the contract.
  assert.equal((handlers.get('agent_end') ?? []).length, 0, 'agent_end must not reset injection');
  assert.equal((handlers.get('session_before_compact') ?? []).length, 0);
});

test('resources_discover contributes the bundled skills directory', async () => {
  const { handlers } = await loadExtension();
  const discover = firstHandler(handlers, 'resources_discover');

  const result = await discover({ type: 'resources_discover', cwd: repoRoot, reason: 'startup' }, makeCtx());

  assert.deepEqual(result.skillPaths, [resolve(repoRoot, 'skills')]);
});

test('before_agent_start persists the bootstrap when the projection lacks it', async () => {
  const { handlers } = await loadExtension();
  const beforeAgentStart = firstHandler(handlers, 'before_agent_start');

  const result = await beforeAgentStart(
    { type: 'before_agent_start', prompt: 'Let us make a react todo list', systemPrompt: '' },
    makeCtx([]),
  );

  assert.ok(result, 'handler should return a message');
  assert.equal(result.message.customType, BOOTSTRAP_CUSTOM_TYPE);
  assert.equal(result.message.display, false, 'bootstrap should not render in the TUI');
  assert.match(result.message.content, /You have superpowers/);
  assert.match(result.message.content, /Pi tool mapping/);

  // The injected mapping is always present, unlike the reference file the model
  // may or may not read. The two failure modes that leave a dispatch with no
  // reachable tool belong here: an inactive `subagent` tool, and a template
  // agent name (`general-purpose`) that pi does not have.
  assert.match(
    result.message.content,
    /subagents_enable/,
    'injected mapping must name the step that activates the subagent tool',
  );
  assert.match(
    result.message.content,
    /general-purpose/,
    'injected mapping must warn that the template agent name is not a pi agent',
  );

  // A, B, C — the injected text is the only copy the model is guaranteed to
  // read, so each dispatch-shaping decision has to be visible here and not
  // only in the reference file.
  assert.match(
    result.message.content,
    /defaultContext/,
    'injected mapping must carry the child-context policy',
  );
  assert.match(
    result.message.content,
    /runs\.all/,
    'injected mapping must carry the parallel fanout shape',
  );
  assert.match(
    result.message.content,
    /enter_plan_mode/,
    'injected mapping must relate plan mode to the brainstorming gate',
  );
});

test('before_agent_start does not re-inject when the projection already has the entry', async () => {
  const { handlers } = await loadExtension();
  const beforeAgentStart = firstHandler(handlers, 'before_agent_start');

  const result = await beforeAgentStart(
    { type: 'before_agent_start', prompt: 'second turn', systemPrompt: '' },
    makeCtx([persistedEntry()]),
  );

  assert.equal(result, undefined, 'persisted entry should satisfy the dedup guard');
});

test('bootstrap survives across turns because it is persisted, not request-scoped', async () => {
  const { handlers } = await loadExtension();
  const beforeAgentStart = firstHandler(handlers, 'before_agent_start');
  const context = firstHandler(handlers, 'context');

  // Turn 1: empty projection -> inject and persist.
  const projection = [];
  const turn1 = await beforeAgentStart(
    { type: 'before_agent_start', prompt: 'first', systemPrompt: '' },
    makeCtx(projection),
  );
  assert.ok(turn1, 'turn 1 should inject');
  // pi appends the returned message to the session; the projection now carries it.
  projection.push(persistedEntry());

  // Turn 2: the entry is still in the projection, so the model still sees the
  // bootstrap and no duplicate is injected. This is the case that previously
  // regressed to MISSING, because a `context` transform never reached the session.
  const turn2 = await beforeAgentStart(
    { type: 'before_agent_start', prompt: 'second', systemPrompt: '' },
    makeCtx(projection),
  );
  assert.equal(turn2, undefined, 'turn 2 must not duplicate the persisted entry');

  const afterTurn2 = await context(
    { type: 'context', messages: [{ role: 'custom', customType: BOOTSTRAP_CUSTOM_TYPE, content: 'x' }] },
    makeCtx(projection),
  );
  assert.equal(afterTurn2, undefined, 'safety net must not duplicate either');
});

test('safety net re-injects after compaction dropped the persisted entry', async () => {
  const { handlers } = await loadExtension();
  const context = firstHandler(handlers, 'context');

  // Compaction summarized the bootstrap entry away, mid-run: no `before_agent_start`
  // is due, so the request-time safety net is the only thing that can cover it.
  const summary = { role: 'compactionSummary', summary: 'Prior work summary', tokensBefore: 123, timestamp: 1 };
  const user = { role: 'user', content: [{ type: 'text', text: 'Continue' }], timestamp: 2 };
  const result = await context({ type: 'context', messages: [summary, user] }, makeCtx([]));

  assert.ok(result, 'safety net should inject after compaction');
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0], summary);
  assert.equal(result.messages[1].role, 'user');
  assert.match(textOf(result.messages[1]), /You have superpowers/);
  assert.equal(result.messages[2], user, 'injection belongs after the summary, before real history');
});

test('pi tools reference documents pi-specific mappings', async () => {
  assert.equal(existsSync(piToolsPath), true, 'pi-tools.md should exist');
  const text = await readFile(piToolsPath, 'utf8');

  // Assert against the mapping-table rows only. The surrounding prose mentions
  // these same tokens, so matching the whole file would still pass if the table
  // were deleted — the exact regression this test exists to catch.
  const rows = text.split('\n').filter((line) => line.startsWith('|'));
  assert.ok(
    rows.some((row) => /subagent/i.test(row)),
    'mapping table documents subagent dispatch',
  );
  assert.ok(
    rows.some((row) => /todo|task/i.test(row)),
    'mapping table documents task tracking',
  );
});

// Four Pi-specific gaps that make a dispatched workflow fail outright rather
// than degrade. Each one is silent: the model reads a skill that says "dispatch
// a subagent", reaches for a tool or a name that Pi does not have, and either
// stalls or reports success without ever running the child.
test('pi tools reference maps the generic dispatch template to a real pi agent', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  // Skills write `Subagent (general-purpose):` — a Claude Code agent name. pi's
  // builtins are scout/worker/reviewer/oracle/delegate/etc; a literal
  // `general-purpose` fails with "Unknown agent". The reference must name the
  // mapping AND state the real call shape, since only `model` survives as a
  // field and the `prompt` body has to become the `task` string.
  assert.match(text, /general-purpose/, 'reference must name the template name it maps away from');
  assert.ok(
    /\bworker\b/.test(text),
    'reference must name at least one real pi agent for implementation work',
  );
  assert.ok(
    /\breviewer\b/.test(text),
    'reference must name at least one real pi agent for review work',
  );
  assert.match(
    text,
    /`?agent`?\s*\+\s*`?task`?|\{ ?agent, task ?\}/i,
    'reference must state the real pi call shape (agent + task)',
  );
});

test('pi tools reference tells the model to enable the subagent tool first', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  // On pi >= 0.86.1 `subagent` starts inactive; `subagents_enable` must be
  // called before any dispatch. A skill that says "dispatch a subagent" without
  // this step has no reachable tool, and the failure mode is the agent quietly
  // doing the work itself instead of reporting the missing capability.
  assert.match(
    text,
    /subagents_enable/,
    'reference must name the enable step that activates the subagent tool',
  );
});

test('pi tools reference warns that a model scope can reject explicit models', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  // subagent-driven-development instructs the controller to pick a model per
  // role and pass it explicitly. Under `subagents.modelScope: { enforce: true,
  // strict: true }` an explicit out-of-scope model is a hard error that aborts
  // the run, so the skill that follows its own Model Selection section most
  // faithfully is the one most likely to fail. The reference must surface the
  // interaction and name the setting so the reader can check it.
  assert.match(
    text,
    /modelScope/,
    'reference must name the setting that can reject an explicit model',
  );
  assert.ok(
    /explicit/i.test(text),
    'reference must distinguish explicit models from inherited ones',
  );
});

// Two facts verified against the installed pi-subagents package (0.73.1), not
// read off prose: `model` really is a subagent field (only `prompt`/`description`
// are template-only), and every builtin agent ships `inheritSkills: false`.
test('pi tools reference is accurate about fields and child capabilities', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  assert.match(
    text,
    /`model` carries over as written/,
    'reference must not claim model is not a subagent field — it is one',
  );
  assert.match(
    text,
    /inheritSkills/,
    'reference must record that dispatched children do not inherit skills',
  );
});

// B: context policy. pi-subagents gives forked runs the parent's history, and
// its own guidance is to use fresh context for adversarial review. The skill
// catalog never names this dimension, so a controller that reaches for `oracle`
// (defaultContext: fork) for a review gets history it did not intend to hand
// over, while the reviewer it should have used inverts that expectation.
test('pi tools reference documents child context policy', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  assert.match(text, /defaultContext/, 'reference must name the field that decides child context');
  assert.match(
    text,
    /\bfork\b/,
    'reference must describe the forked case, since oracle defaults to it',
  );
  assert.ok(
    /oracle/.test(text) && /fork/.test(text),
    'reference must flag that oracle inherits parent history by default',
  );
  assert.match(
    text,
    /adversarial/i,
    'reference must carry pi-subagents advice to keep adversarial review fresh',
  );
});

// A: parallel dispatch. A skill says "issue all dispatches in the same
// response". Pi does run sibling tool calls from one message in parallel, so
// the instruction is not wrong — but pi-subagents directs fanout through one
// `runs.all(...)` workflow, so the reference has to separate "can" from
// "should" instead of leaving the reader to guess.
test('pi tools reference covers both parallel dispatch shapes', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  assert.match(text, /runs\.all/, 'reference must name the workflow fanout helper');
  assert.match(
    text,
    /one assistant message/i,
    'reference must state that sibling tool calls from one message run in parallel',
  );
  assert.match(
    text,
    /workflowScript/,
    'reference must name the single-orchestration form for fanout',
  );
});

// C: two design flows. The repo's skills gate implementation behind
// brainstorming; the Pi harness has its own plan mode. A reader that does not
// know they are the same gate, not two, will run both.
test('pi tools reference relates plan mode to the brainstorming gate', async () => {
  const text = await readFile(piToolsPath, 'utf8');

  assert.match(text, /enter_plan_mode/, 'reference must name the harness plan-mode tool');
  assert.match(
    text,
    /either-or|one design flow|not both/i,
    'reference must say brainstorming and plan mode are alternatives, not a sequence',
  );
});
