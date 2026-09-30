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
