# Schema-Inspired Harness Improvements

Inspired by [Schema](https://schema-harness.github.io/) — a research paper showing that frontier models achieve ~99% on ARC-AGI-3 **without changing model weights**, purely through harness design.

## Core Insight

> *"How you use the model matters a lot."* — The same Claude Opus 4.8 + Fable 5 pairing went from 42.83% to 98.98% RHAE purely through harness constraints.

## What Schema Does Right

1. **Executable world model** — Beliefs encoded as runnable `step(state, action)` programs, not implicit context
2. **Backtest before planning** — `run_backtest` replays every recorded transition against the model
3. **Free planning** — BFS/search inside the verified simulator at zero environment cost
4. **Append-only Timeline** — Immutable observation history; model can be revised, observations cannot
5. **Model revision on failure** — When predictions fail, revise the **representation**, not just the rule

## What We Implemented

### 1. Decision Entry Type (`DecisionEntry`)

**Files:** `packages/agent/src/harness/types.ts`, `packages/coding-agent/src/core/session-manager.ts`

A new `SessionTreeEntry` variant that records:
- `label` — Human-readable decision label
- `plan` — What the agent planned to do
- `expected` — What the agent expected to happen
- `actual` — What actually happened (filled in after execution)
- `outcome` — `"success" | "failure" | "partial"`
- `revision` — Structured revision notes

This is the **append-only Timeline** — decisions are never overwritten, only updated with outcomes.

### 2. Three New AgentLoopConfig Hooks

**Files:** `packages/agent/src/types.ts`, `packages/agent/src/agent.ts`, `packages/agent/src/agent-loop.ts`

#### `beforeToolBatch`
Called before each batch of tool calls executes. Captures the agent's declared plan and expectations.

```typescript
beforeToolBatch?: (
  context: BeforeToolBatchContext,
  signal?: AbortSignal,
) => Promise<BeforeToolBatchResult | undefined>;
```

#### `afterToolBatch`
Called after each batch of tool calls finishes. Records outcomes and detects mismatches.

```typescript
afterToolBatch?: (
  context: AfterToolBatchContext,
  signal?: AbortSignal,
) => Promise<AfterToolBatchResult | undefined>;
```

#### `onModelRevision`
Called when a decision batch fails. Forces the agent to explicitly state what it got wrong before retrying.

```typescript
onModelRevision?: (
  context: ModelRevisionContext,
  signal?: AbortSignal,
) => Promise<string | undefined>;
```

### 3. Decision Tracking in Agent Loop

**File:** `packages/agent/src/agent-loop.ts`

The main loop now:
1. Calls `beforeToolBatch` before executing tool calls
2. Calls `afterToolBatch` after tool results are collected
3. If `revisionRequired` is true, injects a revision message and forces another turn
4. The agent **cannot continue** until it articulates what it got wrong

### 4. SessionManager Decision Methods

**File:** `packages/coding-agent/src/core/session-manager.ts`

- `appendDecision(label, plan, expected)` — Record a decision before execution
- `updateDecision(entryId, actual, outcome, revision?)` — Record outcome after execution
- `getDecisions()` — Retrieve all decisions for post-mortem analysis
- `getDecision(id)` — Get a specific decision

### 5. Schema Helper Factory Functions

**File:** `packages/coding-agent/src/core/schema-decisions.ts`

Reusable factory functions for custom hook implementations:
- `createBeforeToolBatchHook(session, options?)`
- `createAfterToolBatchHook(session, options?)`
- `createOnModelRevisionHook()`

### 6. Built-in Hooks in Coding Agent

**File:** `packages/coding-agent/src/core/agent-session.ts`

The coding agent now automatically:
- Captures plans from assistant message content
- Extracts expected outcomes (looks for "expected:" patterns)
- Classifies outcomes as success/failure based on tool errors
- Injects revision prompts on failure asking the agent to answer:
  1. What was your mental model that led to this plan?
  2. What specific assumption turned out to be wrong?
  3. How does actual behavior contradict your expectation?
  4. What is your corrected understanding?

## How to Use

### For Our Own Development

The hooks are **automatically active** in the coding agent. Every tool batch is now tracked:

```
Before: agent writes code → runs tests → agent fixes errors
After:  agent declares plan → writes code → runs tests → 
        if failure → agent must state what it got wrong → retries
```

### For Extensions

Extensions can use the factory functions:

```typescript
import {
  createBeforeToolBatchHook,
  createAfterToolBatchHook,
  createOnModelRevisionHook,
} from "@earendil-works/pi-coding-agent";

// Custom hooks with session integration
const session = /* ... */;
agent.beforeToolBatch = createBeforeToolBatchHook(session, {
  planExtractor: (msg) => extractPlanFromThought(msg),
  expectedExtractor: (msg) => extractExpectations(msg),
});
```

### For Post-Mortem Analysis

```typescript
const decisions = sessionManager.getDecisions();
for (const d of decisions) {
  console.log(`Decision: ${d.label}`);
  console.log(`  Plan: ${d.plan}`);
  console.log(`  Expected: ${d.expected}`);
  console.log(`  Outcome: ${d.outcome}`);
  if (d.revision) console.log(`  Revision: ${d.revision}`);
}
```

## What Schema Proves That Matters for Us

| Schema Principle | Our Implementation |
|---|---|
| "Encode beliefs as runnable programs" | Decision entries encode beliefs as structured data |
| "Validate against every transition" | `afterToolBatch` certifies outcomes |
| "Plan inside a verified simulator" | `beforeToolBatch` captures plan before execution |
| "Maintain append-only Timeline" | `appendDecision` writes one immutable record per batch; no in-place edits |
| "Reality outranks the model" | `onModelRevision` forces model revision on failure |
| "Action for discovery" | Agent must probe and test, not brute-force |

## Future Improvements

1. **Structured world model** — Require the agent to maintain a `codebase_model.ts` describing architecture as executable code
2. **Free planning via static analysis** — Use `cargo check`/`tsgo --noEmit` as the "free planning" step before runtime tests
3. **Targeted probing** — When unsure about a module, require a minimal test file before broader changes
4. **Decision graph visualization** — TUI component showing decision flow, outcomes, and revision chains
5. **Auto-compaction aware** — Include decision summaries in compaction output for long-term memory
6. **Queryable world-model artifact (P2)** — A versioned `codebase_model.md` the agent edits; edits to the model are "state revision" (Einstein), edits to `expected` are "rule revision" (Lorentz); persistent failure escalates from answering the 4 questions to editing the artifact.

### Landed since the P0/P4 commit

**P1 — Structured pre-batch declarations.** Default behaviour (when schema tracking is enabled) requires every mutating tool batch (bash, edit, write) to be preceded by both `<plan>...</plan>` and `<expected>...</expected>` blocks. A mutating batch missing the declaration is recorded with `outcome: "failure"` regardless of `hasErrors`, and `onModelRevision` returns a dedicated "Declaration Required" prompt routed through a closure-bound `declarationMissingPlanIds` set (afterToolBatch already deletes the pendingPlans entry, so this is how the verdict survives the after→revision step). `isMutatingToolCall` and `requireDeclarations` are options on `createSchemaDecisionHooks` so callers can opt out or extend the mutating set. The system prompt also carries `SCHEMA_DECLARATION_CONVENTION` while schema tracking is on, so the gate is enforced and the agent is told how to satisfy it in the same turn.

**P5 — `decisions` read-only tool and `/decisions` slash command.** The `decisions` tool (`createDecisionsToolDefinition`) lets the agent explicitly query its own Timeline (plan / expected / actual / revision), filtered by outcome and capped at 100. It is only registered when schema tracking is enabled. The `/decisions` slash command renders a post-mortem view (most recent 50 decisions, newest first) in the TUI so the user can audit decisions at a glance.

**P3 — Persistence-gated revision with escalation.** `createSchemaDecisionHooks` now tracks a per-shape consecutive-failure streak in a closure-bound `consecutiveFailuresByShape` map. The shape is computed by `normalizePlanShape` (default: lowercase, strip non-alphanumerics, clip 100 chars) so near-identical plans hash together. On a declared mutating failure the streak for that shape increments; on a success the streak resets. `onModelRevision` consults this streak via `pendingRevisionShapeByPlanId` and at the `escalationThreshold` (default 2) swaps the four-question prompt for a "produce a minimal reproducer before retrying" prompt — Schema's premise that persistent failure indicts the representation, not just the rule. Setting `escalationThreshold: 0` disables escalation. The middle tier (force attendance to edit the `codebase_model.md` artifact before retrying) is gated on P2 landing.

## Active design notes (P0 + P4 follow-up)

This PR lands **P0** (LLM-visible Timeline) and **P4** (defect fixes) from the analysis above.

### P0 — Timeline becomes LLM-visible

Schema's central mechanism is that the agent can read its past observations before re-planning. Until this PR `DecisionEntry` was explicitly excluded from `buildSessionContext`, so the agent literally could not see its own past decisions — the entire backtest / revise premise of Schema was unreachable.

P0 surfaces the Timeline to the LLM via a compact digest of recent *failed* and *partial* decisions appended to the system prompt each turn (see `SessionManager.getRecentDecisionsDigest` and `AgentSession._decorateSystemPromptWithDecisions`). Successes are filtered out — they carry no revision value and would just bloat the prompt.

A follow-up (P5) will add a `decisions` read-only tool so the agent can pull older decisions on demand.

### P4 — Defect fixes

1. **Single implementation, single source of truth.** `_installSchemaDecisionHooks` now delegates to the shared `createSchemaDecisionHooks` factory. The built-in path and the extension-imported factory no longer diverge.
2. **Truly append-only updates.** `updateDecision` (which mutated an in-place entry and rewrote the whole JSONL file as `O(N)` synchronous write per batch) is gone. `appendDecision` now writes the full record once, after the outcome is known. State lives in closure-bound `pendingPlans` inside the factory between `beforeToolBatch` and `afterToolBatch`. Schema's Timeline is append-only precisely so observations stay immutable and persistence stays `O(1)` per batch.
3. **Revision messages no longer pollute context.** The agent loop now injects the revision prompt as a custom message with `customType: "schema_revision"` (`display: false`) instead of `role: "user"`. This keeps it visible to the LLM via `convertToLlm` (custom messages map to user messages in the LLM view) while separating it from real user input in transcripts and exports — exactly Schema's separation of model-revision artifacts from the Timeline.
4. **No more false `expected` matches.** The previous heuristic scanned assistant prose for the substring "expected:" and matched inside plain English ("as expected, the file ..."), capturing garbage. When no match was found it fell back to `expected = plan`, so the outcome classifier never noticed a real mismatch. The new extractor only recognizes an explicit `<expected>...</expected>` block; otherwise it records `(unverified)` so a missing declaration is visible and correctable rather than silently mirrored.
5. **Gated behind experimental flag.** The subsystem now opts in via `PI_EXPERIMENTAL=1` or `PI_SCHEMA_DECISIONS=1`. Default off avoids per-batch overhead and system-prompt bloat from the recent-decisions digest while the design stabilizes.
6. **Dead variable removed.** `_batchPlanLabel` (assigned, never read) is gone; the unused `"partial"` code paths are either implemented or actually unreachable.
7. **Failure detection trusts the loop.** `classifyOutcome` now uses the loop-provided `hasErrors` (computed from the `isError` flags on tool result messages — the canonical signal) and stops scraping output text for "error"/"failed" substrings, which misclassified bash results with non-zero exit codes that happened not to print the word "error".

## Files Changed

| File | Change |
|---|---|
| `packages/agent/src/harness/types.ts` | Added `DecisionEntry` type to `SessionTreeEntry` union |
| `packages/agent/src/types.ts` | Added `BeforeToolBatch*`, `AfterToolBatch*`, `ModelRevision*` types and hooks |
| `packages/agent/src/agent.ts` | Added hook properties to `Agent` class and `AgentOptions` |
| `packages/agent/src/agent-loop.ts` | Integrated hooks into main loop; emits revision as `schema_revision` custom message; added `SCHEMA_REVISION_CUSTOM_TYPE` |
| `packages/coding-agent/src/core/session-manager.ts` | `DecisionEntry` + `DecisionRecord`; append-only `appendDecision`; `getDecisions` / `getDecision` / `getRecentDecisionsDigest` |
| `packages/coding-agent/src/core/agent-session.ts` | `_installSchemaDecisionHooks` delegates to factory and is gated behind experimental; per-turn decision digest via `_decorateSystemPromptWithDecisions` |
| `packages/coding-agent/src/core/schema-decisions.ts` | Unified factory (`createSchemaDecisionHooks`); strict `<expected>` extractor; `hasErrors`-based `classifyOutcome`; `onDecisionAppended` callback |
| `packages/coding-agent/src/core/experimental.ts` | `isSchemaDecisionTrackingEnabled` opt-in via `PI_EXPERIMENTAL` / `PI_SCHEMA_DECISIONS` |
| `packages/coding-agent/src/core/index.ts` | Updated exports for the renamed/re-added symbols |
| `packages/coding-agent/test/schema-decisions.test.ts` | Updated for the single-append API; added digest and factory coverage |
