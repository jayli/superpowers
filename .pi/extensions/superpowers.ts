import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for pi";
const BOOTSTRAP_CUSTOM_TYPE = "superpowers-bootstrap";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(extensionDir, "../..");
const skillsDir = resolve(packageRoot, "skills");
const bootstrapSkillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");

let cachedBootstrap: string | null | undefined;

export default function superpowersPiExtension(pi: ExtensionAPI) {
	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));

	// The bootstrap is injected as a persisted `custom_message` entry rather than as a
	// request-time `context` transform. A `context` transform is restored after each
	// request and never reaches the session file, so the next turn's history no longer
	// contains it and the dedup guard below would find nothing to match.
	pi.on("before_agent_start", async (_event, ctx) => {
		const bootstrap = getBootstrapContent();
		if (!bootstrap) return undefined;
		if (projectionHasBootstrap(ctx.sessionManager.buildContextEntries())) return undefined;

		return {
			message: {
				customType: BOOTSTRAP_CUSTOM_TYPE,
				content: bootstrap,
				display: false,
			},
		};
	});

	// Safety net for the one window `before_agent_start` cannot cover: compaction that
	// lands mid-run, after the persisted entry has been summarized away but before the
	// next run starts. It injects for that request only; the next run persists a fresh
	// entry through the handler above.
	pi.on("context", async (event) => {
		if (event.messages.some(messageContainsBootstrap)) return undefined;

		const bootstrap = getBootstrapContent();
		if (!bootstrap) return undefined;

		const bootstrapMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: bootstrap }],
			timestamp: Date.now(),
		};

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				bootstrapMessage,
				...event.messages.slice(insertAt),
			],
		};
	});
}

function getBootstrapContent(): string | null {
	if (cachedBootstrap !== undefined) return cachedBootstrap;

	try {
		const skillContent = readFileSync(bootstrapSkillPath, "utf8");
		const body = stripFrontmatter(skillContent);
		cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${body}

${piToolMapping()}
</EXTREMELY_IMPORTANT>`;
		return cachedBootstrap;
	} catch {
		cachedBootstrap = null;
		return null;
	}
}

function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function piToolMapping(): string {
	return `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, use Pi's native skill system instead: load the relevant \`SKILL.md\` with \`read\` when the skill applies, or let a human invoke \`/skill:name\` explicitly.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, plus optional \`grep\`, \`find\`, and \`ls\`. Use those for the corresponding actions: read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi does not ship a standard subagent tool. If a subagent tool such as \`subagent\` from \`pi-subagents\` is available, use it for Superpowers subagent workflows. If no subagent tool is available, do the work in this session or explain the missing capability instead of inventing \`Task\` calls.

On Pi 0.86.1 and later the \`subagent\` tool starts inactive: call \`subagents_enable\` before the first dispatch, and the tool becomes available on the next model request. Some provider bridges fix the tool list for a whole prompt, so there it appears only after the next *user* prompt — do not retry it in the same turn. Do not silently do the work yourself because the tool was not there yet.

Skills write dispatches as \`Subagent (general-purpose):\` with \`description\`, \`model\`, and \`prompt\` keys. That is prose, not a Pi call. \`general-purpose\` is a Claude Code agent name and Pi has no agent by that name — passing it fails with \`Unknown agent\`. Translate by intent to a real agent (\`worker\` to implement, \`reviewer\` to review, \`scout\` for recon, \`researcher\` for outside research, \`oracle\` for a second opinion, \`delegate\` for a parent-like child), and note the shape: \`prompt\` contents become the \`task\` string and \`description\` is not a field — only \`model\` carries over as written. Check \`subagent({ action: "list" })\` for the names actually installed.

When a skill tells you to choose a model per role and pass it explicitly, check \`subagents.modelScope\` in the user and project settings first. With \`enforce: true\` an out-of-scope *explicit* model is a hard error that aborts the run, and \`strict: true\` makes inherited models hard errors too; \`allow: ["inherit"]\` permits only the parent session's current model. If your chosen model is outside the list, omit the model and let the child inherit, or ask your human partner to widen the scope — never route around it yourself. Scope rejects or warns; it never selects a model.

Each agent's \`defaultContext\` decides whether a child starts clean or inherits your conversation: \`worker\`, \`reviewer\`, \`scout\`, \`researcher\`, and \`delegate\` start fresh, while \`oracle\` forks your history. Adversarial review wants fresh context — a forked reviewer tends to converge on your own framing — so use \`reviewer\` for a review seat and pass \`context: "fresh"\` explicitly if you review with another agent. Reserve \`oracle\` for its actual job: decision consistency against state agreed earlier. Explicit forking needs a persisted parent session; without one, an agent-level \`defaultContext: fork\` falls back to fresh.

For parallel fanout, sibling tool calls from one assistant message do run in parallel, but pi-subagents directs fanout through one workflow: \`subagent({ workflowScript: "const r = await runs.all([...]); return r.map(x => x.output)" })\`. Use that shape when you plan to aggregate, sequence, retry, or steer the children, and keep it to a single top-level orchestration per turn; use separate direct calls when the children are independent and you will read each receipt as it lands.

Pi has its own plan mode (\`enter_plan_mode\` / \`exit_plan_mode\`), and it is either-or with brainstorming, not a second step: if you already loaded \`brainstorming\` this run, follow that skill's approval gate and do not enter plan mode for the same task; if the task hits the plan gate without brainstorming loaded, plan mode is the gate, and inside it you write nothing and commit nothing — one-question-at-a-time there is \`ask_user_question\`.

Pi does not ship a standard task-list tool. If an installed todo/task tool is available, use it. Otherwise track work in plan files or a repo-local \`TODO.md\` when task tracking is needed. Treat older \`TodoWrite\` references as this task-tracking action.`;
}

/** True when the model-visible projection already carries a persisted bootstrap entry. */
function projectionHasBootstrap(entries: readonly unknown[]): boolean {
	return entries.some((entry) => {
		const record = entry as { type?: unknown; customType?: unknown };
		return record.type === "custom_message" && record.customType === BOOTSTRAP_CUSTOM_TYPE;
	});
}

function messageContainsBootstrap(message: unknown): boolean {
	const record = message as { role?: unknown; customType?: unknown; content?: unknown };
	if (record.role === "custom" && record.customType === BOOTSTRAP_CUSTOM_TYPE) return true;

	const content = record.content;
	if (typeof content === "string") return content.includes(BOOTSTRAP_MARKER);
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		return (
			part &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string" &&
			(part as { text: string }).text.includes(BOOTSTRAP_MARKER)
		);
	});
}

function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while ((messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}
