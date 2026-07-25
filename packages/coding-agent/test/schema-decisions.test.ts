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
import { createDecisionsToolDefinition } from "../src/core/tools/decisions.ts";

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
		it("requires an explicit <plan>/<expected> declaration on mutating batches (default)", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			// No <plan>/<expected> blocks → must be rejected as missing-declaration.
			const assistant = makeAssistantMessage("let me edit app.ts now");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Outcome is forced to failure even though hasErrors is false.
			expect(after?.outcome).toBe("failure");
			expect(after?.revisionRequired).toBe(true);

			const decision = sm.getDecisions()[0]!;
			expect(decision.expected).toBe("(unverified)");
			expect(decision.revision).toContain("declaration");
			expect(decision.outcome).toBe("failure");

			// onModelRevision now routes through the missing-declaration path.
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: decision.plan,
				expected: decision.expected,
				actual: after!.actual,
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Declaration Required Before Mutating Actions");
		});

		it("accepts a declared mutating batch and certifies the outcome normally", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage(
				"<plan>Edit app.ts to fix the import</plan>\n<expected>tsgo --noEmit exits 0</expected>",
			);

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);

			const decision = sm.getDecisions()[0]!;
			expect(decision.plan).toBe("Edit app.ts to fix the import");
			expect(decision.expected).toBe("tsgo --noEmit exits 0");
		});

		it("does not enforce declarations on read-only batches (read/grep/find/ls)", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage("let me grep for the symbol");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("grep")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("matches: 3")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			// Read-only + no declaration → still success, no revision required.
			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
		});

		it("skips declaration enforcement when requireDeclarations is false", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { requireDeclarations: false });
			const assistant = makeAssistantMessage("just edit it");

			const before = await hooks.beforeToolBatch({
				assistantMessage: assistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const after = await hooks.afterToolBatch({
				assistantMessage: assistant,
				planId: before!.planId,
				toolResults: [makeToolResult("done")],
				hasErrors: false,
				context: EMPTY_CONTEXT,
			});

			expect(after?.outcome).toBe("success");
			expect(after?.revisionRequired).toBe(false);
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: "p",
				expected: "e",
				actual: "a",
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Model Revision Required");
		});

		it("records a full decision after the batch and classifies by hasErrors", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const assistant = makeAssistantMessage(
				"<plan>Edit app.ts</plan>\n<expected>tests pass</expected>\n<plan>nothing</plan>",
			);

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

			// When declared but failed, onModelRevision goes through the regular revision prompt.
			const revision = await hooks.onModelRevision({
				planId: before!.planId,
				plan: decisions[0]!.plan,
				expected: decisions[0]!.expected,
				actual: after!.actual,
				toolResults: [],
				context: EMPTY_CONTEXT,
			});
			expect(revision).toContain("Model Revision Required");
		});

		it("records expected as (unverified) when no explicit block is present", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { requireDeclarations: false });
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
			const hooks = createSchemaDecisionHooks(sm, {
				requireDeclarations: false,
				onDecisionAppended: (id) => seen.push(id),
			});
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

		it("onModelRevision returns a structured revision prompt when declared and failed", async () => {
			// requireDeclarations=false so we exercise the regular revision path
			// without having to first set up a declared plan.
			const hooks = createSchemaDecisionHooks(SessionManager.inMemory(), { requireDeclarations: false });
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

	describe("decisions tool", () => {
		it("returns all decisions by default, newest first", async () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({
				planId: "p1",
				label: "first",
				plan: "p1",
				expected: "e1",
				actual: "a1",
				outcome: "success",
			});
			sm.appendDecision({
				planId: "p2",
				label: "second",
				plan: "p2",
				expected: "e2",
				actual: "a2",
				outcome: "failure",
			});

			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", {}, undefined, undefined, undefined as never);

			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("first");
			expect(text).toContain("second");
			// newest first: second appears before first
			expect(text.indexOf("second")).toBeLessThan(text.indexOf("first"));
			expect(result.details.returned).toBe(2);
			expect(result.details.total).toBe(2);
		});

		it("filters by outcome", async () => {
			const sm = SessionManager.inMemory();
			sm.appendDecision({ planId: "p1", label: "ok", plan: "p", expected: "e", actual: "a", outcome: "success" });
			sm.appendDecision({ planId: "p2", label: "boom", plan: "p", expected: "e", actual: "a", outcome: "failure" });

			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", { outcome: "failure" }, undefined, undefined, undefined as never);

			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("boom");
			expect(text).not.toContain("ok");
			expect(result.details.returned).toBe(1);
			expect(result.details.total).toBe(1);
		});

		it("clamps excessive limit to 100 and respects small limits", async () => {
			const sm = SessionManager.inMemory();
			for (let i = 0; i < 5; i++) {
				sm.appendDecision({ planId: `p${i}`, label: `d${i}`, plan: "p", expected: "e", outcome: "success" });
			}

			const def = createDecisionsToolDefinition(sm);
			const r2 = await def.execute("t1", { limit: 2 }, undefined, undefined, undefined as never);
			expect(r2.details.returned).toBe(2);

			const rHuge = await def.execute("t1", { limit: 10_000 }, undefined, undefined, undefined as never);
			expect(rHuge.details.returned).toBe(5); // only 5 exist
		});

		it("reports empty timeline explicitly", async () => {
			const sm = SessionManager.inMemory();
			const def = createDecisionsToolDefinition(sm);
			const result = await def.execute("t1", {}, undefined, undefined, undefined as never);
			const text = (result.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("(no decisions recorded)");
			expect(result.details.total).toBe(0);
		});
	});

	describe("persistence-gated escalation (P3)", () => {
		async function planRunWithOutcome(
			hooks: ReturnType<typeof createSchemaDecisionHooks>,
			assistant: AssistantMessage,
			planText: string,
			hasErrors: boolean,
		): Promise<{ planId: string; revision?: string }> {
			const fullAssistant = makeAssistantMessage(`<plan>${planText}</plan>\n<expected>success</expected>`);
			// Reuse the assistant argument — the extractor only needs its `.content`.
			void assistant;
			const before = await hooks.beforeToolBatch({
				assistantMessage: fullAssistant,
				toolCalls: [makeToolCall("edit")],
				context: EMPTY_CONTEXT,
			});
			const result = await hooks.afterToolBatch({
				assistantMessage: fullAssistant,
				planId: before!.planId,
				toolResults: [makeToolResult(hasErrors ? "Error!" : "done")],
				hasErrors,
				context: EMPTY_CONTEXT,
			});
			// Only consult onModelRevision when the loop actually would (i.e. when
			// afterToolBatch said revision was required). On a successful batch the
			// loop short-circuits and never calls onModelRevision.
			let revision: string | undefined;
			if (result?.revisionRequired) {
				revision = await hooks.onModelRevision({
					planId: before!.planId,
					plan: planText,
					expected: "success",
					actual: result!.actual,
					toolResults: [],
					context: EMPTY_CONTEXT,
				});
			}
			return { planId: before!.planId, revision };
		}

		it("returns the standard revision prompt on the first failure", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm);
			const { revision } = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(revision).toContain("Model Revision Required");
			expect(revision).toContain("Answer these questions");
			expect(revision).not.toContain("Persistent Model Failure");
		});

		it("escalates to the reproducer-first prompt after escalationThreshold same-shape failures", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 2 });
			// First failure on this shape: standard prompt.
			const r1 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r1.revision).toContain("Model Revision Required");
			// Second failure on the same (canonicalized) shape: escalation.
			const r2 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "Fix import a.", true);
			expect(r2.revision).toContain("Persistent Model Failure");
			expect(r2.revision).toContain("minimal reproducer");
			expect(r2.revision).toContain("2x");
		});

		it("resets the streak after a success on the same shape", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 2 });
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			// Success on the same shape resets the streak.
			const success = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", false);
			expect(success.revision).toBeUndefined();
			// First failure again: standard prompt, no escalation.
			const r3 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r3.revision).toContain("Model Revision Required");
			expect(r3.revision).not.toContain("Persistent Model Failure");
		});

		it("does not escalate when escalationThreshold is 0", async () => {
			const sm = SessionManager.inMemory();
			const hooks = createSchemaDecisionHooks(sm, { escalationThreshold: 0 });
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			const r3 = await planRunWithOutcome(hooks, makeAssistantMessage(""), "fix import a", true);
			expect(r3.revision).toContain("Model Revision Required");
			expect(r3.revision).not.toContain("Persistent Model Failure");
		});
	});
});
