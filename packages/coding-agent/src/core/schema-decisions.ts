/**
 * Schema-inspired decision tracking for the pi agent harness.
 *
 * Inspired by the Schema harness (schema-harness.github.io) which achieves
 * ~99% on ARC-AGI-3 by forcing models to:
 * 1. Encode beliefs as executable programs (not implicit context)
 * 2. Validate against every recorded transition (run_backtest)
 * 3. Plan inside a verified simulator (free planning)
 * 4. Maintain an append-only Timeline (immutable observations)
 *
 * This module provides structured decision log support:
 * - Record what the agent planned, expected, and what actually happened
 * - Detect mismatches between plan and outcome
 * - Force explicit model revision on failure
 * - Enable post-mortem analysis of agent behavior
 */

import type {
	AfterToolBatchResult,
	AgentLoopConfig,
	AgentToolResult,
	BeforeToolBatchResult,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";

/** Extract text blocks from an assistant message's content. */
function getTextBlocks(message: AssistantMessage): string[] {
	const textBlocks: string[] = [];
	const content = message.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === "text") {
				textBlocks.push(block.text);
			}
		}
	}
	return textBlocks;
}

/** A decision batch that links planning to outcomes. */
export interface DecisionBatch {
	planId: string;
	label: string;
	plan: string;
	expected: string;
	actual?: string;
	outcome?: "success" | "failure" | "partial";
	revision?: string;
	toolResults: AgentToolResult<any>[];
	timestamp: string;
}

/**
 * Create a beforeToolBatch hook that captures the agent's declared plan.
 *
 * Extracts the plan from the assistant message content and creates a
 * decision entry that links to the outcome via planId.
 *
 * @param session - Session for appending decision entries
 * @param options - Configuration options
 */
export function createBeforeToolBatchHook(
	session: { appendDecision: (decision: Omit<DecisionBatch, "toolResults">) => Promise<void> },
	options?: {
		/** Extract plan from assistant message content. Default: first text block. */
		planExtractor?: (message: AssistantMessage) => string;
		/** Extract expected outcome from assistant message content. Default: second text block or same as plan. */
		expectedExtractor?: (message: AssistantMessage) => string;
		/** Label format function. Default: tool names. */
		labelFormatter?: (toolCalls: string[]) => string;
	},
): NonNullable<AgentLoopConfig["beforeToolBatch"]> {
	const planExtractor = options?.planExtractor ?? defaultPlanExtractor;
	const expectedExtractor = options?.expectedExtractor ?? defaultExpectedExtractor;
	const labelFormatter = options?.labelFormatter ?? defaultLabelFormatter;

	return async ({ assistantMessage, toolCalls, context: _context }) => {
		const plan = planExtractor(assistantMessage);
		const expected = expectedExtractor(assistantMessage);
		const toolNames = toolCalls.map((tc) => tc.name);
		const label = labelFormatter(toolNames);
		const planId = uuidv7();

		const decision = {
			planId,
			label,
			plan,
			expected,
			timestamp: new Date().toISOString(),
		};

		await session.appendDecision(decision);

		return {
			planId,
			label,
			plan,
			expected,
		} satisfies BeforeToolBatchResult;
	};
}

/**
 * Create an afterToolBatch hook that records outcomes and detects mismatches.
 *
 * Compares actual outcomes against expected results. If there's a mismatch
 * and errors occurred, signals that model revision is required.
 *
 * @param session - Session for appending decision entries
 * @param options - Configuration options
 */
export function createAfterToolBatchHook(
	session: {
		updateDecision: (planId: string, actual: string, outcome: "success" | "failure" | "partial") => Promise<void>;
	},
	options?: {
		/** Summarize tool results into a human-readable string. */
		outcomeSummarizer?: (toolResults: AgentToolResult<any>[]) => string;
		/** Threshold for considering a batch a "failure". Default: any error. */
		failureThreshold?: "any_error" | "majority_error" | "all_error";
	},
): NonNullable<AgentLoopConfig["afterToolBatch"]> {
	const outcomeSummarizer = options?.outcomeSummarizer ?? defaultOutcomeSummarizer;
	const failureThreshold = options?.failureThreshold ?? "any_error";

	return async ({ planId, toolResults, hasErrors, context: _context }) => {
		const actual = outcomeSummarizer(toolResults);
		const outcome = classifyOutcome(toolResults, hasErrors, failureThreshold);

		await session.updateDecision(planId, actual, outcome);

		const revisionRequired = outcome === "failure";

		return {
			actual,
			outcome,
			revisionRequired,
			revision:
				outcome === "failure"
					? `Decision "${planId}" failed. Expected success but encountered errors.\nActual outcome: ${actual}\n\nRevise your mental model of the codebase before retrying.`
					: undefined,
		} satisfies AfterToolBatchResult;
	};
}

/**
 * Create an onModelRevision hook that forces the agent to articulate
 * what it got wrong before continuing.
 *
 * Inspired by Schema's principle: "when predictions fail persistently,
 * they do not only adjust the law. They change what the state is."
 */
export function createOnModelRevisionHook(): NonNullable<AgentLoopConfig["onModelRevision"]> {
	return async ({ plan, expected, actual, toolResults }) => {
		const errorSummary = toolResults
			.filter((tr) => {
				if (tr.details?.type === "error") return true;
				const first = tr.content?.[0];
				const text = first && first.type === "text" ? first.text : "";
				return text.toLowerCase().includes("error");
			})
			.map((tr) => {
				const first = tr.content?.[0];
				const text = first && first.type === "text" ? first.text : "Unknown error";
				return text;
			})
			.join("\n");

		return [
			`## Model Revision Required`,
			``,
			`Your plan failed. Before continuing, you must explicitly state what you got wrong.`,
			``,
			`**Plan:** ${plan}`,
			`**Expected:** ${expected}`,
			`**Actual:** ${actual}`,
			...(errorSummary ? [`**Errors:** ${errorSummary}`] : []),
			``,
			`Answer these questions:`,
			`1. What was your mental model of the codebase that led to this plan?`,
			`2. What specific assumption turned out to be wrong?`,
			`3. How does the actual behavior contradict your expectation?`,
			`4. What is your corrected understanding?`,
			``,
			`Do NOT proceed with another attempt until you have answered these questions.`,
		].join("\n");
	};
}

/** Default plan extractor: first text block in assistant message. */
function defaultPlanExtractor(message: AssistantMessage): string {
	const textBlocks = getTextBlocks(message);
	return textBlocks.length > 0 ? textBlocks[0] : JSON.stringify(message.content);
}

/** Default expected extractor: looks for "expected:" or "expects:" in message. */
function defaultExpectedExtractor(message: AssistantMessage): string {
	const textBlocks = getTextBlocks(message);
	for (const block of textBlocks) {
		const lower = block.toLowerCase();
		const expectedMatch = lower.match(/expected[\s:]+([^\n]+)/i);
		if (expectedMatch) return expectedMatch[1].trim();
		const expectsMatch = lower.match(/expects[\s:]+([^\n]+)/i);
		if (expectsMatch) return expectsMatch[1].trim();
	}
	// Fallback: use the plan text
	return defaultPlanExtractor(message);
}

/** Default label formatter: joins tool names. */
function defaultLabelFormatter(toolNames: string[]): string {
	return toolNames.join(" + ");
}

/** Default outcome summarizer: joins first text from each result. */
function defaultOutcomeSummarizer(toolResults: AgentToolResult<any>[]): string {
	return toolResults
		.map((tr) => {
			const first = tr.content?.[0];
			const text = first && first.type === "text" ? first.text : "";
			return text.slice(0, 200);
		})
		.join("\n");
}

/** Classify batch outcome based on tool results and failure threshold. */
function classifyOutcome(
	toolResults: AgentToolResult<any>[],
	hasErrors: boolean,
	threshold: "any_error" | "majority_error" | "all_error",
): "success" | "failure" | "partial" {
	if (!hasErrors) return "success";

	const errorCount = toolResults.filter((tr) => tr.details?.type === "error" || isToolError(tr)).length;

	switch (threshold) {
		case "any_error":
			return errorCount > 0 ? "failure" : "success";
		case "majority_error":
			return errorCount > toolResults.length / 2 ? "failure" : "partial";
		case "all_error":
			return errorCount === toolResults.length ? "failure" : "partial";
	}
}

function isToolError(tr: AgentToolResult<any>): boolean {
	const first = tr.content?.[0];
	const text = first && first.type === "text" ? first.text : "";
	return text.toLowerCase().includes("error") || text.toLowerCase().includes("failed");
}
