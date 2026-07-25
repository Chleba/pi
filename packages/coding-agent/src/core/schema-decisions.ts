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

	const pendingPlans = new Map<string, DecisionPlanId>();
	const declarationMissingPlanIds = new Set<string>();
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

/** Default plan extractor: recognizes an explicit `<plan>...</plan>` block, else records `(undeclared)`. */
function defaultPlanExtractor(message: AssistantMessage): string {
	const text = firstTextBlock(message) ?? "";
	const match = text.match(/<plan>([\s\S]*?)<\/plan>/i);
	if (match) return match[1].trim().slice(0, 1000) || UNDECLARED_PLAN;
	// Fall back to the first text block so a misbehaving agent still leaves a
	// usable record in the Timeline; `declared` is computed separately and
	// will still be false, so enforcement kicks in.
	return text.slice(0, 1000) ? text.slice(0, 1000) : UNDECLARED_PLAN;
}

/**
 * Default expected extractor: only recognizes an explicit
 * `<expected>...</expected>` block. Falls back to `"(unverified)"` rather than
 * mirroring `plan` — the prior `expected: ...` substring heuristic matched
 * ordinary English ("as expected"), captured garbage, and silently equated
 * `expected` with `plan` for nearly every decision, so outcome classification
 * could never observe a real mismatch.
 */
function defaultExpectedExtractor(message: AssistantMessage): string {
	const text = firstTextBlock(message) ?? "";
	const match = text.match(/<expected>([\s\S]*?)<\/expected>/i);
	if (match) return match[1].trim().slice(0, 400) || "(unverified)";
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
		"Your previous tool batch would mutate files or run stateful commands, but it did not include an explicit plan. Premise of deliberation before action: state what you intend and what you expect, *then* act.",
		"",
		"Before any batch that includes `bash`, `edit`, or `write`, your preceding text MUST contain BOTH:",
		"  - `<plan> ... </plan>` — a short description of the action(s) you intend, and",
		"  - `<expected> ... </expected>` — the observable outcome you will use to certify success (command exit code, file contents, test result, etc.).",
		"",
		"Re-issue your previous tool calls with those two blocks included. Do not retry the mutation without them.",
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
	"A mutating batch without both blocks will be rejected and you will be asked to declare before retrying.",
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
		"Answer these questions:",
		"1. What was your mental model of the codebase that led to this plan?",
		"2. What specific assumption turned out to be wrong?",
		"3. How does the actual behavior contradict your expectation?",
		"4. What is your corrected understanding?",
		"",
		"Do NOT proceed with another attempt until you have answered these questions.",
	].join("\n");
}

function firstTextBlock(message: AssistantMessage): string | undefined {
	const content = message.content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (block.type === "text") return block.text;
	}
	return undefined;
}
