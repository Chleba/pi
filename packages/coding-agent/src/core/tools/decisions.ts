/**
 * Read-only `decisions` tool: lets the agent inspect its own schema decision
 * Timeline (plan / expected / actual / outcome / revision) on demand.
 *
 * The Timeline is normally surfaced to the LLM only via the compact
 * `getRecentDecisionsDigest` block in the system prompt (recent failed/partial
 * decisions). This tool is the explicit-query counterpart: the agent can pull a
 * longer or differently-filtered slice when it wants to verify the history of a
 * particular kind of failure before re-attempting a similar plan.
 *
 * Only registered when schema tracking is enabled
 * (`PI_EXPERIMENTAL=1` or `PI_SCHEMA_DECISIONS=1`).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { DecisionEntry, SessionManager } from "../session-manager.ts";

const decisionsSchema = Type.Object({
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of most-recent decisions to return. Default: 20, max: 100.",
		}),
	),
	outcome: Type.Optional(
		Type.Union([Type.Literal("all"), Type.Literal("failure"), Type.Literal("partial"), Type.Literal("success")], {
			description: "Filter by outcome (default: all)",
		}),
	),
});

export type DecisionsToolInput = Static<typeof decisionsSchema>;
export type DecisionsOutcomeFilter = "all" | "failure" | "partial" | "success";

export interface DecisionsToolDetails {
	returned: number;
	total: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Build the `decisions` tool bound to a session manager. The session is
 * captured in the execute closure; the tool definition is otherwise stateless.
 */
export function createDecisionsToolDefinition(
	sessionManager: SessionManager,
): ToolDefinition<typeof decisionsSchema, DecisionsToolDetails> {
	return {
		name: "decisions",
		label: "decisions",
		description:
			"List your recorded schema decision Timeline: the plan, expected outcome, actual result, and revision notes for past tool batches. Use this to inspect how previous plans matched reality before re-attempting similar work, especially after a failure.",
		promptSnippet: "List past schema decisions (plan/expected/actual/revision)",
		promptGuidelines: [
			"Before re-attempting a plan that previously failed, call decisions to inspect what went wrong last time.",
		],
		parameters: decisionsSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const requestedLimit = params.limit ?? DEFAULT_LIMIT;
			const limit = Math.min(Math.max(Math.trunc(requestedLimit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
			const outcome: DecisionsOutcomeFilter = (params.outcome as DecisionsOutcomeFilter | undefined) ?? "all";
			const all = sessionManager.getDecisions();
			const filtered = outcome === "all" ? all : all.filter((d) => d.outcome === outcome);
			// Newest first — agent almost always wants recent failures to compare
			// against, not the very first decisions of a long session.
			const slice = filtered.slice(-limit).reverse();
			const text = renderDecisions(slice, filtered.length);
			const content: TextContent[] = [{ type: "text", text }];
			return {
				content,
				details: { returned: slice.length, total: filtered.length } satisfies DecisionsToolDetails,
			} satisfies AgentToolResult<DecisionsToolDetails>;
		},
	};
}

function renderDecisions(entries: DecisionEntry[], totalMatched: number): string {
	if (entries.length === 0) {
		return totalMatched === 0 ? "(no decisions recorded)" : "(no decisions matched your filter)";
	}
	const blocks = entries.map((d, i) => {
		const tag = d.outcome ?? "pending";
		const header = `### ${i + 1}. [${tag}] ${d.label}`;
		const lines = [header, `Plan: ${d.plan}`, `Expected: ${d.expected}`];
		if (d.actual) lines.push(`Actual: ${d.actual}`);
		if (d.revision) lines.push(`Revision: ${d.revision}`);
		if (d.metadata?.planId) lines.push(`(planId: ${String(d.metadata.planId)})`);
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}
