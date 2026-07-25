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
}

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
	/** Extract plan from the assistant message text. Default: first text block, truncated to 1000 chars. */
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

	const pendingPlans = new Map<string, DecisionPlanId>();
	const onDecisionAppended = options?.onDecisionAppended;

	const beforeToolBatch: SchemaDecisionHooks["beforeToolBatch"] = async ({ assistantMessage, toolCalls }) => {
		const plan = planExtractor(assistantMessage);
		const expected = expectedExtractor(assistantMessage);
		const label = labelFormatter(toolCalls.map((tc) => tc.name));
		const planId = uuidv7();

		const entry: DecisionPlanId = { planId, label, plan, expected };
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
		const outcome = classifyOutcome(hasErrors, toolResults.length, failureThreshold);

		const planEntry = pendingPlans.get(planId) ?? {
			planId,
			label: "(unknown)",
			plan: "",
			expected: "(unverified)",
		};
		pendingPlans.delete(planId);

		const record: DecisionRecord = {
			planId,
			label: planEntry.label,
			plan: planEntry.plan,
			expected: planEntry.expected,
			actual,
			outcome,
		};
		const entryId = session.appendDecision(record);
		try {
			onDecisionAppended?.(entryId);
		} catch {
			// listener failures must not break the agent loop
		}

		const revisionRequired = outcome === "failure";
		return {
			actual,
			outcome,
			revisionRequired,
			revision: revisionRequired ? buildRevisionSummary(planEntry, actual) : undefined,
		} satisfies AfterToolBatchResult;
	};

	const onModelRevision: SchemaDecisionHooks["onModelRevision"] = async ({ plan, expected, actual }) => {
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

/** Default plan extractor: first text block in assistant message, capped. */
function defaultPlanExtractor(message: AssistantMessage): string {
	const text = firstTextBlock(message);
	return text ? text.slice(0, 1000) : "(no plan declared)";
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
