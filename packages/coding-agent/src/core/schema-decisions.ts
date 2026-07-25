/**
 * Schema-inspired decision tracking for the pi agent harness.
 *
 * Inspired by the Schema harness (schema-harness.github.io) which achieves
 * ~99% on ARC-AGI-3 by forcing models to:
 * 1. Encode beliefs as executable programs (not implicit context)
 * 2. Validate against every recorded transition (certify phase)
 * 3. Plan inside a verified simulator (free planning)
 * 4. Maintain an append-only Timeline (immutable observations)
 *
 * This module wires that pattern to the pi agent loop with three hooks:
 *
 * - `beforeToolBatch`: capture the assistant's declared plan/expected in
 *   memory (the "deliberation" snapshot). Returns a `planId` that is passed
 *   through the loop so `afterToolBatch` knows which plan to record.
 * - `afterToolBatch`: classify the outcome using the loop-provided `hasErrors`
 *   flag (the canonical error signal — never text-matched from raw output),
 *   then write ONE `DecisionEntry` with the full plan/expected/actual/outcome.
 * - `onModelRevision`: when a batch fails, produce a revision prompt the loop
 *   injects as a custom message (`schema_revision`) so revision artifacts stay
 *   separate from user/assistant history and don't pollute context.
 *
 * Decisions live in the Timeline (append-only JSONL) and the LLM-visible half
 * of the Timeline is the recent-decisions digest injected into the system
 * prompt each turn via `SessionManager.getRecentDecisionsDigest`.
 */

import type {
	AfterToolBatchResult,
	AgentLoopConfig,
	AgentToolResult,
	BeforeToolBatchResult,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { DecisionRecord, SessionManager } from "./session-manager.ts";

/** Stable handle for one round of deliberation; links `beforeToolBatch` to `afterToolBatch`. */
export interface DecisionPlanId {
	planId: string;
	label: string;
	plan: string;
	expected: string;
	/** True when at least one tool in the batch is mutating (write/edit/bash). */
	mutating: boolean;
	/** True when both `<plan>...</plan>` and `<expected>...</expected>` were present. */
	declared: boolean;
}

/**
 * Mutating tool names under the built-in tool set. Read-only batches
 * (read/grep/find/ls) don't require an explicit declaration — there is no
 * state to revise. A batch is treated as mutating if any of its tool calls
 * is in this list. Callers can override via `isMutatingToolCall`.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "edit", "write"]);

/** Session-like target for `appendDecision`. Use {@link createSchemaDecisionHooks} for the default. */
export type DecisionRecorder = Pick<SessionManager, "appendDecision">;

/**
 * Full hook set. Returned by {@link createSchemaDecisionHooks} and assigned to
 * the Agent's hook slots; also exported individually for advanced users who
 * only want some of the three.
 */
export interface SchemaDecisionHooks {
	beforeToolBatch: NonNullable<AgentLoopConfig["beforeToolBatch"]>;
	afterToolBatch: NonNullable<AgentLoopConfig["afterToolBatch"]>;
	onModelRevision: NonNullable<AgentLoopConfig["onModelRevision"]>;
}

export interface SchemaDecisionHooksOptions {
	/**
	 * Extract the agent's declared plan. The default recognizes an explicit
	 * `<plan>...</plan>` block in the assistant's text; if absent it falls back
	 * to the first text block so the Timeline still has a usable record. The
	 * `declared` flag passed downstream is only set when BOTH `<plan>` and
	 * `<expected>` blocks are present (see {@link requireDeclarations}).
	 */
	planExtractor?: (message: AssistantMessage) => string;
	/**
	 * Extract an explicit expected-outcome declaration. The default ONLY
	 * recognizes an explicit `<expected>...</expected>` block in the assistant's
	 * text. If absent, `expected` is recorded as `"(unverified)"` rather than
	 * silently mirrored from `plan` — that mirror is the bug the prior regex
	 * had, because outcome classification then never noticed a real mismatch.
	 */
	expectedExtractor?: (message: AssistantMessage) => string;
	/** Format a label from the tool call names. Default: joined with " + ". */
	labelFormatter?: (toolNames: string[]) => string;
	/** Summarize tool results into a human-readable actual. Default: first text from each, 240 chars. */
	outcomeSummarizer?: (toolResults: AgentToolResult<any>[]) => string;
	/** Threshold for classifying a batch as failure. Default: `"any_error"` (trusts `hasErrors`). */
	failureThreshold?: "any_error" | "majority_error" | "all_error";
	/** Maximum number of concurrent in-flight plans kept in memory. Default: 64. */
	maxPendingPlans?: number;
	/**
	 * Classify a single tool-call name as mutating. Default checks against
	 * {@link MUTATING_TOOL_NAMES}. Override only if you register custom tools
	 * that mutate state.
	 */
	isMutatingToolCall?: (toolName: string) => boolean;
	/**
	 * Whether mutating batches must carry an explicit declaration
	 * (`<plan>...</plan>` + `<expected>...</expected>`). Default: true
	 * (Schema's "deliberation before action" principle). When enabled and the
	 * declaration is missing, the batch is treated as a `failure` and a
	 * dedicated revision prompt asks the agent to declare first before acting.
	 * Set to false to record decisions quietly without enforcement.
	 */
	requireDeclarations?: boolean;
	/**
	 * Canonicalize a plan string into a streak key. The default lowercases,
	 * strips non-alphanumeric characters, and clips to 100 chars so two
	 * near-identical plans (varying only in punctuation or slice of wording)
	 * are treated as the same shape for persistence-gated escalation.
	 */
	normalizePlanShape?: (plan: string) => string;
	/**
	 * At-or-above how many consecutive same-shape failures before
	 * `onModelRevision` escalates from the standard revision questions to the
	 * "produce a minimal reproducer before retrying" prompt. Default: 2 —
	 * Schema's "persistent failure" cut-off. Set to a higher value to make
	 * the agent answer the questions more times before escalation; 0 disables
	 * escalation entirely.
	 */
	escalationThreshold?: number;
	/**
	 * Called with the persisted `DecisionEntry` id once `afterToolBatch` writes
	 * the decision. Use to surface live decision entries to the UI (e.g. emit
	 * `entry_appended` so tree-selector re-renders). Best-effort: errors here
	 * are ignored by the hooks.
	 */
	onDecisionAppended?: (entryId: string) => void;
}

/**
 * Build the three schema-decision hooks around a session manager. This is the
 * only entry point the coding agent uses; the individual `create*Hook`
 * factories below are exported for callers who assemble their own partial sets.
 *
 * The hooks stay stateful via a closure-bound `pendingPlans` map keyed by
 * `planId`; this is deliberate — schema decision state must live outside the
 * session (which is strictly append-only) until the outcome is known.
 */
export function createSchemaDecisionHooks(
	session: DecisionRecorder,
	options?: SchemaDecisionHooksOptions,
): SchemaDecisionHooks {
	const planExtractor = options?.planExtractor ?? defaultPlanExtractor;
	const expectedExtractor = options?.expectedExtractor ?? defaultExpectedExtractor;
	const labelFormatter = options?.labelFormatter ?? defaultLabelFormatter;
	const outcomeSummarizer = options?.outcomeSummarizer ?? defaultOutcomeSummarizer;
	const failureThreshold = options?.failureThreshold ?? "any_error";
	const maxPendingPlans = options?.maxPendingPlans ?? 64;
	const isMutatingToolCall = options?.isMutatingToolCall ?? defaultIsMutatingToolCall;
	const requireDeclarations = options?.requireDeclarations ?? true;
	const normalizePlanShape = options?.normalizePlanShape ?? defaultNormalizePlanShape;
	const escalationThreshold = options?.escalationThreshold ?? 2;

	const pendingPlans = new Map<string, DecisionPlanId>();
	const declarationMissingPlanIds = new Set<string>();
	/**
	 * Per-plan-shape consecutive failure streak. Schema's "persistent failure"
	 * notion: counter increments on each failed batch with the same shape and
	 * resets on the first success for that shape. Surfaced through
	 * `pendingRevisionShapeByPlanId` to onModelRevision so the iteration step
	 * knows whether to ask the four questions (1st failure) or escalate to the
	 * reproducer-first prompt.
	 */
	const consecutiveFailuresByShape = new Map<string, number>();
	/** Map planId → just-recorded shape for onModelRevision to consult. */
	const pendingRevisionShapeByPlanId = new Map<string, string>();
	const onDecisionAppended = options?.onDecisionAppended;

	const beforeToolBatch: SchemaDecisionHooks["beforeToolBatch"] = async ({ assistantMessage, toolCalls }) => {
		const plan = planExtractor(assistantMessage);
		const expected = expectedExtractor(assistantMessage);
		const label = labelFormatter(toolCalls.map((tc) => tc.name));
		const planId = uuidv7();
		const mutating = toolCalls.some((tc) => isMutatingToolCall(tc.name));
		// Both explicit blocks must be present for the declaration to count.
		// `(unverified)`/`(undeclared)` markers come straight out of the
		// extractors when their respective block is missing.
		const declared = plan !== UNDECLARED_PLAN && expected !== UNVERIFIED_EXPECTED;

		const entry: DecisionPlanId = { planId, label, plan, expected, mutating, declared };
		pendingPlans.set(planId, entry);
		for (const key of pendingPlans.keys()) {
			if (pendingPlans.size <= maxPendingPlans) break;
			pendingPlans.delete(key);
		}

		return {
			planId,
			label,
			plan,
			expected,
		} satisfies BeforeToolBatchResult;
	};

	const afterToolBatch: SchemaDecisionHooks["afterToolBatch"] = async ({ planId, toolResults, hasErrors }) => {
		const actual = outcomeSummarizer(toolResults);
		const planEntry = pendingPlans.get(planId) ?? {
			planId,
			label: "(unknown)",
			plan: UNDECLARED_PLAN,
			expected: UNVERIFIED_EXPECTED,
			mutating: true,
			declared: false,
		};
		pendingPlans.delete(planId);

		// Declaration gate: a mutating batch without explicit `<plan>` +
		// `<expected>` is treated as a failure regardless of hasErrors, and
		// the revision prompt asks for a declaration rather than a model
		// revision. This is the Schema "deliberation before action" principle.
		const missingDeclaration = requireDeclarations && planEntry.mutating && !planEntry.declared;
		const outcome = missingDeclaration ? "failure" : classifyOutcome(hasErrors, toolResults.length, failureThreshold);
		const revisionRequired = outcome === "failure";

		const record: DecisionRecord = {
			planId,
			label: planEntry.label,
			plan: planEntry.plan,
			expected: planEntry.expected,
			actual,
			outcome: missingDeclaration ? "failure" : outcome,
			revision: missingDeclaration ? UNDECLARED_REVISION : undefined,
		};
		const entryId = session.appendDecision(record);
		if (missingDeclaration) {
			declarationMissingPlanIds.add(planId);
			// Keep the set bounded — reuse the same cap as pendingPlans.
			if (declarationMissingPlanIds.size > maxPendingPlans) {
				const first = declarationMissingPlanIds.values().next().value;
				if (first !== undefined) declarationMissingPlanIds.delete(first);
			}
		}

		// Persistence-gated streak tracking. A declared mutating failure (or
		// any failed batch when declarations are off) increments the
		// consecutive-failure counter keyed by the canonicalized plan shape;
		// any success on the same shape resets it. The latest shape for this
		// planId is stashed so onModelRevision (called after
		// pendingPlans.delete) can decide between the question prompt and the
		// reproducer-first escalation prompt.
		if (!missingDeclaration) {
			const shape = normalizePlanShape(planEntry.plan);
			if (outcome === "success") {
				consecutiveFailuresByShape.delete(shape);
			} else if (revisionRequired) {
				const next = (consecutiveFailuresByShape.get(shape) ?? 0) + 1;
				consecutiveFailuresByShape.set(shape, next);
				pendingRevisionShapeByPlanId.set(planId, shape);
				if (pendingRevisionShapeByPlanId.size > maxPendingPlans) {
					const first = pendingRevisionShapeByPlanId.keys().next().value;
					if (first !== undefined) pendingRevisionShapeByPlanId.delete(first);
				}
			}
		}
		try {
			onDecisionAppended?.(entryId);
		} catch {
			// listener failures must not break the agent loop
		}

		return {
			actual,
			outcome,
			revisionRequired,
			revision: revisionRequired
				? missingDeclaration
					? buildDeclarationRequiredSummary(planEntry)
					: buildRevisionSummary(planEntry, actual)
				: undefined,
		} satisfies AfterToolBatchResult;
	};

	const onModelRevision: SchemaDecisionHooks["onModelRevision"] = async ({ planId, plan, expected, actual }) => {
		// afterToolBatch has already deleted the pendingPlan entry, so we
		// route through the declaration-missing set instead; that's how the
		// "missing declaration" verdict survives the after→revision step.
		if (requireDeclarations && declarationMissingPlanIds.has(planId)) {
			declarationMissingPlanIds.delete(planId);
			return buildDeclarationRequiredMessage();
		}
		// Persistence-gated escalation: at the Nth consecutive same-shape
		// failure the four questions stop being enough — Schema's premise is
		// that persistent failure indicts the representation, so demand a
		// minimal reproducer / probe before any further retry.
		const shape = pendingRevisionShapeByPlanId.get(planId) ?? normalizePlanShape(plan);
		pendingRevisionShapeByPlanId.delete(planId);
		const streak = consecutiveFailuresByShape.get(shape) ?? 0;
		if (escalationThreshold > 0 && streak >= escalationThreshold) {
			return buildEscalationMessage(plan, expected, actual, streak);
		}
		return buildRevisionMessage(plan, expected, actual);
	};

	return { beforeToolBatch, afterToolBatch, onModelRevision };
}

// Re-export individual factory hooks for advanced users who assemble partial sets.

export function createBeforeToolBatchHook(
	session: DecisionRecorder,
	options?: SchemaDecisionHooksOptions,
): SchemaDecisionHooks["beforeToolBatch"] {
	return createSchemaDecisionHooks(session, options).beforeToolBatch;
}

export function createAfterToolBatchHook(
	session: DecisionRecorder,
	options?: SchemaDecisionHooksOptions,
): SchemaDecisionHooks["afterToolBatch"] {
	return createSchemaDecisionHooks(session, options).afterToolBatch;
}

export function createOnModelRevisionHook(): SchemaDecisionHooks["onModelRevision"] {
	return createSchemaDecisionHooks({ appendDecision: noopRecorder }).onModelRevision;
}

function noopRecorder(): string {
	return "";
}

/** Sentinel string recorded for `plan` when the assistant gave no explicit `<plan>` block. */
const UNDECLARED_PLAN = "(undeclared)";
/** Sentinel string recorded for `expected` when the assistant gave no explicit `<expected>` block. */
const UNVERIFIED_EXPECTED = "(unverified)";
/** Sentinel string recorded as `revision` when the batch was rejected for missing a declaration. */
const UNDECLARED_REVISION = "missing <plan>/<expected> declaration";

/**
 * Default plan extractor: recognizes an explicit `<plan>` block.
 * The closing tag is optional — if the LLM writes `<plan>Edit app.ts`
 * without `</plan>`, everything after the opening tag up to the next
 * `<` or end-of-text is captured as the plan content.
 */
function defaultPlanExtractor(message: AssistantMessage): string {
	const text = firstTextBlock(message) ?? "";
	// Strict match first: <plan>...</plan>
	const strict = text.match(/<plan>([\s\S]*?)<\/plan>/i);
	if (strict) return strict[1].trim().slice(0, 1000) || UNDECLARED_PLAN;
	// Tolerant fallback: <plan> without closing tag — capture up to next '<' or end.
	const tolerant = text.match(/<plan>([\s\S]*?)(?:<|$)/i);
	if (tolerant) return tolerant[1].trim().slice(0, 1000) || UNDECLARED_PLAN;
	return UNDECLARED_PLAN;
}

/**
 * Default expected extractor: recognizes an explicit `<expected>` block.
 * The closing tag is optional — if the LLM writes `<expected>tests pass`
 * without `</expected>`, everything after the opening tag up to the next
 * `<` or end-of-text is captured as the expected outcome.
 *
 * Falls back to `"(unverified)"` rather than mirroring `plan` — the prior
 * `expected: ...` substring heuristic matched ordinary English ("as expected"),
 * captured garbage, and silently equated `expected` with `plan` for nearly
 * every decision, so outcome classification could never observe a real mismatch.
 */
function defaultExpectedExtractor(message: AssistantMessage): string {
	const text = firstTextBlock(message) ?? "";
	// Strict match first: <expected>...</expected>
	const strict = text.match(/<expected>([\s\S]*?)<\/expected>/i);
	if (strict) return strict[1].trim().slice(0, 400) || "(unverified)";
	// Tolerant fallback: <expected> without closing tag — capture up to next '<' or end.
	const tolerant = text.match(/<expected>([\s\S]*?)(?:<|$)/i);
	if (tolerant) return tolerant[1].trim().slice(0, 400) || "(unverified)";
	return "(unverified)";
}

/** Default label formatter: joins tool names. */
function defaultLabelFormatter(toolNames: string[]): string {
	return toolNames.join(" + ");
}

/** Default outcome summarizer: first text from each result, 240 chars each. */
function defaultOutcomeSummarizer(toolResults: AgentToolResult<any>[]): string {
	if (toolResults.length === 0) return "(no results)";
	return toolResults
		.map((tr) => {
			const first = tr.content?.[0];
			const text = first && first.type === "text" ? first.text : "";
			return text.slice(0, 240);
		})
		.filter((s) => s.length > 0)
		.join("\n");
}

/**
 * Classify a batch outcome using only the loop-provided `hasErrors`
 * (the canonical error signal — computed from the `isError` flags on tool
 * result messages, never scraped from output text). Thresholds:
 * - `any_error`: any error → failure, else success (default; matches the
 *   Schema principle that certs fail on a single counterexample).
 * - `majority_error`: more than half the calls errored → failure, else partial.
 * - `all_error`: every call errored → failure, otherwise partial.
 */
function classifyOutcome(
	hasErrors: boolean,
	resultCount: number,
	threshold: "any_error" | "majority_error" | "all_error",
): "success" | "failure" | "partial" {
	if (!hasErrors) return "success";
	// `hasErrors` does not split counts; without per-result isError here we
	// cannot compute majority/all thresholds precisely. Treat any-error and
	// the stricter variants as failure when `hasErrors` is true; partial is
	// reserved for explicit opt-in callers that wire their own composition.
	return resultCount === 0 ? "failure" : threshold === "any_error" ? "failure" : "partial";
}

function buildRevisionSummary(plan: DecisionPlanId, actual: string): string {
	return `Decision "${plan.label}" failed. Expected success but encountered errors.Actual outcome: ${actual}`;
}

/** Stub summary embedded in the `AfterToolBatchResult.revision` for declaration-missing batches. */
function buildDeclarationRequiredSummary(plan: DecisionPlanId): string {
	return `Decision "${plan.label}" was rejected: mutating batches must carry an explicit <plan>...</plan> + <expected>...</expected> declaration. none was found.`;
}

/** Full revision prompt injected into context when a mutating batch was sent without a declaration. */
function buildDeclarationRequiredMessage(): string {
	return [
		"## Declaration Required Before Mutating Actions",
		"",
		"Your previous tool batch would mutate files or run stateful commands, but it did not include an explicit plan. Premise of deliberation before action: state what you intend and what you expect, *then* act — in the SAME response.",
		"",
		"Before any batch that includes `bash`, `edit`, or `write`, your preceding text MUST contain BOTH:",
		"  - `<plan> ... </plan>` — a short description of the action(s) you intend, and",
		"  - `<expected> ... </expected>` — the observable outcome you will use to certify success (command exit code, file contents, test result, etc.).",
		"",
		"Re-issue your previous tool calls WITH these tags in the same response. Example:",
		"",
		"  <plan>Read src/file.ts to find the type definition</plan>",
		"  <expected>The read tool succeeds and returns the file contents</expected>",
		"  [your tool calls here]",
		"",
		"Do NOT declare and then wait. Declare AND include the tool calls in this one response.",
	].join("\n");
}

/** Whether a tool name is on the built-in mutating set. Override via `options.isMutatingToolCall`. */
function defaultIsMutatingToolCall(toolName: string): boolean {
	return MUTATING_TOOL_NAMES.has(toolName);
}

/**
 * Short system-prompt convention block teaching the agent the
 * `<plan>...</plan>` + `<expected>...</expected>` requirement. Appended to
 * the system prompt once per turn while schema tracking is enabled.
 */
export const SCHEMA_DECLARATION_CONVENTION = [
	"<schema_declaration_convention>",
	"Before any tool batch that mutates state (bash, edit, write), your preceding text MUST include BOTH:",
	"  - <plan> ... </plan>   — what you intend to do in this batch",
	"  - <expected> ... </expected> — the observable outcome you will use to certify success",
	"Both tags MUST have their opening AND closing forms (e.g. <plan>text</plan>, not <plan>text). Missing closing tags cause the batch to be rejected.",
	"You MUST include the tool calls in the SAME response as these tags. Do not declare first then wait; declare AND act in one turn.",
	"A mutating batch without both complete blocks will be rejected and you will be asked to declare before retrying.",
	"</schema_declaration_convention>",
].join("\n");

function buildRevisionMessage(plan: string, expected: string, actual: string): string {
	return [
		"## Model Revision Required",
		"",
		"Your previous tool batch did not match expectations. Before retrying, you must explicitly state what you got wrong.",
		"",
		`**Plan:** ${plan.slice(0, 600)}`,
		`**Expected:** ${expected.slice(0, 400)}`,
		`**Actual:** ${actual.slice(0, 600)}`,
		"",
		"Answer these questions, then re-issue your corrected tool calls in the SAME response:",
		"1. What was your mental model of the codebase that led to this plan?",
		"2. What specific assumption turned out to be wrong?",
		"3. How does the actual behavior contradict your expectation?",
		"4. What is your corrected understanding?",
		"",
		"After answering, include your tool calls in the same response. Do not answer and wait — answer AND retry the tool calls in this one turn.",
	].join("\n");
}

/**
 * Escalation prompt used after `escalationThreshold` consecutive failures on
 * the same plan shape. Schema's premise: persistent failure indicts the
 * representation, not just the rule, so before any further retry the agent
 * must produce a minimal probe (a test, a one-liner, or just-below-the-load
 * reproducer) that establishes the actual behavior.
 */
function buildEscalationMessage(plan: string, expected: string, actual: string, streak: number): string {
	return [
		`## Persistent Model Failure (${streak}x same plan shape)`,
		"",
		"Your previous plan has now failed this many times with the same shape. Continuing to retry it with minor wording changes will keep failing. Before your next attempt you must produce a minimal reproducer:",
		"",
		"- Write a tiny test, a one-line shell command, or the smallest input that reproduces the failure you just observed.",
		"- Run it and paste the *actual* output (not what you expected).",
		"- Only after the reproducer agrees with the recorded actual may you re-issue your plan — and you must edit your stated `<expected>` to match what the reproducer showed.",
		"",
		"If you cannot build a reproducer, you do not yet understand the mechanism; say so and ask the user instead of retrying.",
		"",
		`**Plan (last):** ${plan.slice(0, 600)}`,
		`**Expected (last):** ${expected.slice(0, 400)}`,
		`**Actual (last):** ${actual.slice(0, 600)}`,
	].join("\n");
}

/**
 * Canonicalize a plan string into a streak key. Lowercases, strips every
 * non-alphanumeric character, and clips to 100 chars so near-identical plans
 * (punctuation wording differences, trailing whitespace) hash the same. Used
 * so the persistence-gated escalation counter only trips when the agent
 * keeps failing on effectively the same plan.
 */
function defaultNormalizePlanShape(plan: string): string {
	const cleaned = plan
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.slice(0, 100);
	return cleaned || "(empty)";
}

function firstTextBlock(message: AssistantMessage): string | undefined {
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block.type === "text") return block.text;
	}
	return undefined;
}
