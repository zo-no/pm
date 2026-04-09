# Architecture

## Goal

Run `pm-loop` as an independent automatic PM control plane:

- ingest product behavior from one or more hosts
- detect high-signal product issues
- pull in reusable product patterns
- score opportunities
- draft specs
- submit candidate changes for explicit human approval
- execute approved work through a repo-scoped runner
- evaluate outcomes and keep durable review state

The most important architectural rule is this:

`pm-loop` may observe MelodySync, but it must not depend on MelodySync as its default executor.

## Runtime Split

There are two runtimes to understand.

### Current runtime

The current implementation is a transitional runtime:

- `EventSource`: reads MelodySync runtime history
- `ActionRunner`: can dispatch bounded MelodySync child-session work
- `OutcomeReader`: reads experiment outcomes back

This runtime is useful for bootstrapping the loop, but it is not the target boundary because it couples execution to MelodySync.

### Target runtime

The target runtime moves execution out of MelodySync:

```text
scan -> detect -> plan -> approval queue -> execution runner -> evaluate
```

That means:

- MelodySync can remain a data source
- MelodySync can remain a dashboard host
- MelodySync must stop being the default place where product changes are executed

## Layering

### `packages/core`

Pure domain logic:

- domain objects
- ports
- policies
- use cases

It knows nothing about MelodySync, Codex CLI internals, repo-specific scripts, or host storage layouts.

### `packages/adapter-*`

Adapters map external systems into core ports.

Examples:

- `adapter-melodysync`: telemetry/data-source adapter
- future `adapter-codex`: execution adapter
- future `adapter-github`: PR/result adapter

Adapters are allowed to know product-specific and tool-specific details. Core is not.

### `packages/storage-*`

Own the sidecar persistence boundary.

The sidecar never writes host runtime state as its source of truth.

### `apps/*`

Application surfaces only:

- `apps/worker`: background orchestration
- `apps/cli`: manual operator controls
- `apps/dashboard`: review and visibility

These are shells around core behavior, not places where domain rules should live.

## Core Objects

The current loop already uses:

- `Event`
- `Signal`
- `Opportunity`
- `SpecDraft`
- `Experiment`
- `Decision`

The target runtime adds:

- `ProjectTarget`
- `ChangeProposal`
- `ApprovalRecord`

These new objects formalize the missing control point between "good idea" and "write code".

## Target Execution Boundary

The target execution path is:

```text
Opportunity
  -> SpecDraft
  -> ChangeProposal
  -> Human Approval
  -> ExecutionRunner
  -> Experiment
  -> Decision
```

### `ProjectTarget`

Defines where work is allowed to land:

- repo path
- base branch
- writable paths
- test requirements
- whether direct apply is allowed
- whether auto-merge is allowed

### `ChangeProposal`

Defines what the human is being asked to approve:

- target repo
- spec linkage
- requested actions
- rationale
- risk level

This is what should appear in the dashboard as a point-and-click review item.

### `ApprovalGate`

Owns explicit human confirmation:

- queue proposal
- list pending proposals
- record approve/reject/revise

This is the architectural barrier that prevents uncontrolled host mutations.

### `ExecutionRunner`

Owns repo execution after approval:

- open branch/worktree
- invoke Codex or another approved executor
- run tests/checks
- return experiment metadata

Core should depend on this as a port, not on MelodySync child sessions.

## Why This Protects MelodySync

Without an approval gate, an automatic PM loop tends to turn repeated signals into automatic host edits.

That is useful for demos and dangerous for real product work.

With the target design:

1. MelodySync can be observed safely.
2. `pm-loop` can suggest work independently.
3. Humans approve specific change proposals.
4. Approved work executes in repo-scoped runners with branch-level isolation.
5. Merge remains a separate policy decision.

So the system can be autonomous in analysis, but only bounded in execution.

## Host Contracts

The target system has two different contract families.

### Data-source contracts

1. Fetch normalized events over a window.
2. Fetch outcome data for completed experiments.

### Execution contracts

1. Resolve a `ProjectTarget`.
2. Submit a `ChangeProposal` to the approval queue.
3. Execute approved work through an `ExecutionRunner`.

This split is intentional. Data ingestion and code execution must not be the same boundary.

## Pattern Source

The sidecar can optionally use a pattern source during planning.

- telemetry answers "what hurts"
- patterns answer "what good looks like"

That keeps the system open to both data-driven and pattern-driven demand discovery.

## Migration Path

The current runtime should evolve in this order:

1. Keep `EventSource` and `OutcomeReader` as-is.
2. Stop treating `ActionRunner` as the target abstraction.
3. Introduce `ProjectTarget`, `ChangeProposal`, `ApprovalGate`, and `ExecutionRunner`.
4. Move MelodySync execution into a legacy compatibility path.
5. Make repo-scoped Codex execution the default path for approved work.

Until step 5 is complete, the running system is still transitional.
