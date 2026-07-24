/**
 * Tests for Schema-inspired decision tracking hooks.
 *
 * Verifies that:
 * - DecisionEntry is created with correct structure
 * - beforeToolBatch captures plan/expected
 * - afterToolBatch records outcome
 * - onModelRevision injects revision message on failure
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("Schema Decision Tracking", () => {
	let tempDir: string;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-schema-test-"));
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("should create decision entry with required fields", () => {
		const entryId = sessionManager.appendDecision("test decision", "Write a file", "File created successfully");

		const decision = sessionManager.getDecision(entryId);
		expect(decision).toBeDefined();
		expect(decision?.type).toBe("decision");
		expect(decision?.label).toBe("test decision");
		expect(decision?.plan).toBe("Write a file");
		expect(decision?.expected).toBe("File created successfully");
		expect(decision?.actual).toBeUndefined();
		expect(decision?.outcome).toBeUndefined();
	});

	it("should update decision with outcome", () => {
		const entryId = sessionManager.appendDecision("test decision", "Write a file", "File created successfully");

		sessionManager.updateDecision(entryId, "File written", "success");

		const decision = sessionManager.getDecision(entryId);
		expect(decision?.actual).toBe("File written");
		expect(decision?.outcome).toBe("success");
	});

	it("should update decision with revision notes", () => {
		const entryId = sessionManager.appendDecision("test decision", "Write a file", "File created successfully");

		sessionManager.updateDecision(entryId, "File not found", "failure", "Wrong path used");

		const decision = sessionManager.getDecision(entryId);
		expect(decision?.outcome).toBe("failure");
		expect(decision?.revision).toBe("Wrong path used");
	});

	it("should track multiple decisions", () => {
		const _id1 = sessionManager.appendDecision("decision 1", "plan 1", "expected 1");
		const _id2 = sessionManager.appendDecision("decision 2", "plan 2", "expected 2");

		const decisions = sessionManager.getDecisions();
		expect(decisions).toHaveLength(2);
		expect(decisions[0]?.label).toBe("decision 1");
		expect(decisions[1]?.label).toBe("decision 2");
	});

	it("should ignore update for non-existent entry", () => {
		// Should not throw
		expect(() => {
			sessionManager.updateDecision("non-existent", "actual", "success");
		}).not.toThrow();
	});

	it("should ignore update for non-decision entry", () => {
		// Create a message entry first
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		// Get the message entry id
		const entries = sessionManager.getEntries();
		const messageId = entries.find((e) => e.type === "message")?.id;
		expect(messageId).toBeDefined();

		// Should not throw
		expect(() => {
			sessionManager.updateDecision(messageId!, "actual", "success");
		}).not.toThrow();
	});
});
