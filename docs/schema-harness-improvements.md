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
| "Maintain append-only Timeline" | Decisions are never overwritten, only updated |
| "Reality outranks the model" | `onModelRevision` forces model revision on failure |
| "Action for discovery" | Agent must probe and test, not brute-force |

## Future Improvements

1. **Structured world model** — Require the agent to maintain a `codebase_model.ts` describing architecture as executable code
2. **Free planning via static analysis** — Use `cargo check`/`tsgo --noEmit` as the "free planning" step before runtime tests
3. **Targeted probing** — When unsure about a module, require a minimal test file before broader changes
4. **Decision graph visualization** — TUI component showing decision flow, outcomes, and revision chains
5. **Auto-compaction aware** — Include decision summaries in compaction output for long-term memory

## Files Changed

| File | Change |
|---|---|
| `packages/agent/src/harness/types.ts` | Added `DecisionEntry` type to `SessionTreeEntry` union |
| `packages/agent/src/types.ts` | Added `BeforeToolBatch*`, `AfterToolBatch*`, `ModelRevision*` types and hooks |
| `packages/agent/src/agent.ts` | Added hook properties to `Agent` class and `AgentOptions` |
| `packages/agent/src/agent-loop.ts` | Integrated hooks into main loop with revision injection |
| `packages/coding-agent/src/core/session-manager.ts` | Added `DecisionEntry` type, `appendDecision`, `updateDecision`, `getDecisions` |
| `packages/coding-agent/src/core/agent-session.ts` | Added `_installSchemaDecisionHooks()` with built-in implementations |
| `packages/coding-agent/src/core/schema-decisions.ts` | New: factory functions for custom hook implementations |
| `packages/coding-agent/src/core/index.ts` | Exported schema-decisions module |
