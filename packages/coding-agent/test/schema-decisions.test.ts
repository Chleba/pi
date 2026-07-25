/**
 * Tests for Schema-inspired decision tracking.
 *
 * Verifies that:
 * - DecisionEntry is written once (append-only), with all fields
 * - getDecisions/getDecision round-trip the persisted entry
 * - getRecentDecisionsDigest only surfaces failed/partial decisions and
 *   formats them compactly for the LLM
 * - createSchemaDecisionHooks records a full decision after a batch (the
 *   before/after recommended package) and classifies by hasErrors
 */

import type { AgentContext, AgentToolCall, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createSchemaDecisionHooks } from "../src/core/schema-decisions.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeToolCall(name: string): AgentToolCall {
	return { type: "toolCall", id: `${name}-1`, name, arguments: {} };
}

function makeToolResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: {} } as AgentToolResult<unknown>;
}

const EMPTY_CONTEXT: AgentContext = { systemPrompt: "", messages: [], tools: [] };

describe("Schema Decision Tracking", () => {
	describe("SessionManager.appendDecision", () => {
		it("writes a full decision entry once with all fields", () => {
			const sm = SessionManager.inMemory();
			const entryId = sm.appendDecision({
				planId: "plan-1",
				label: "bash + read",
				plan: "make the tests pass",
				expected: "exit 0",
				actual: "exit 1",
				outcome: "failure",
				revision: "wrong import path",
			});

			const decision = sm.getDecision(entryId);
			expect(decision).toBeDefined();
			expect(decision?.type).toBe("decision");
			expect(decision?.label).toBe("bash + read");
			expect(decision?.plan).toBe("make the tests pass");
			expect(decision?.expected).toBe("exit 0");
			expect(decision?.actual).toBe("exit 1");
			expect(decision?.outcome).toBe("failure");
			expect(decision?.revision).toBe("wrong import path");
			expect(decision?.metadata?.planId).toBe("plan-1");
		});

		it("getDecisions returns entries in append order", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "a", plan: "p1", expected: "e1", outcome: "success" });
			sm.appendDecision({ planId: "p2", label: "b", plan: "p2", expected: "e2", outcome: "failure" });

			const decisions = sm.getDecisions();
			expect(decisions).toHaveLength(2);
			expect(decisions[0]?.label).toBe("a");
			expect(decisions[1]?.label).toBe("b");
		});

		it("getDecision returns undefined for unknown ids", () => {
			const sm = SessionManager.inMemory();
			expect(sm.getDecision("nope")).toBeUndefined();
		});

		it("getRecentDecisionsDigest is empty when there are no failures", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p", expected: "e", actual: "a", outcome: "success" });
			expect(sm.getRecentDecisionsDigest(5)).toBe("");
		});

		it("getRecentDecisionsDigest surfaces only failed and partial decisions, newest first", () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p1", expected: "e1", actual: "a1", outcome: "success" });
			sm.appendDecision({
				planId: "p2",
				label: "boom",
				plan: "p2",
				expected: "e2",
				actual: "a2",
				outcome: "failure",
				revision: "fix imports",
			});
			sm.appendDecision({
				planId: "p3",
				label: "half",
				plan: "p3",
				expected: "e3",
				actual: "a3",
				outcome: "partial",
			});

			const digest = sm.getRecentDecisionsDigest(5);
			expect(digest).toContain("<recent_decisions>");
			expect(digest).toContain("[failure] boom");
			expect(digest).toContain("[partial] half");
			expect(digest).not.toContain("ok");
			expect(digest).toContain("Revision: fix imports");
			// newest first: partial (p3) appears before failure (p2)
			expect(digest.indexOf("[partial] half")).toBeLessThan(digest.indexOf("[failure] boom"));
		});
	});

	describe("createSchemaDecisionHooks", () => {
		it("records a full decision after the batch and classifies by hasErrors", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("I will edit app.ts.\n<expected>tests pass</expected>");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			expect(before?.planId).toBeTruthy();

			const results = [makeToolResult("Error: file not found")];
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: results,
				hasErrors: true,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("failure");
			expect(after?.revisionRequired).toBe(true);
			expect(after?.actual).toContain("Error: file not found");

			const decisions = sm.getDecisions();
			expect(decisions).toHaveLength(1);
			expect(decisions[0]?.label).toBe("edit");
			expect(decisions[0]?.expected).toBe("tests pass");
			expect(decisions[0]?.outcome).toBe("failure");
			expect(decisions[0]?.metadata?.planId).toBe(before!.planId);
		});

		it("records expected as (unverified) when no explicit block is present", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("I will run the tests now.");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("bash")],
				context: EMPTY_CONTEXT,
			});
			await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			const decision = sm.getDecisions()[0]!;
			expect(decision.expected).toBe("(unverified)");
			expect(decision.outcome).toBe("success");
		});

		it("invokes onDecisionAppended after the entry is written", async () => {
			const seen: string[] = [];
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { onDecisionAppended: (id) => seen.push(id) });
			const assistant = makeAssistantMessage("plan");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("bash")],
				context: EMPTY_CONTEXT,
			});
			await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("ok")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(seen).toHaveLength(1);
			expect(sm.getDecision(seen[0]!)).toBeDefined();
		});

		it("onModelRevision returns a structured revision prompt", async () => {
			const hooks = createSchemaDecisionHooks(SessionManager.inMemory());
			const out = await hooks.onModelRevision({
				planId: "p",
				plan: "p",
				expected: "e",
				actual: "a",
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(out).toContain("Model Revision Required");
			expect(out).toContain("Answer these questions");
		});
	});
});
