# Approval And Execution Architecture

## Intent

This document defines the target execution model for `pm-loop`.

The design goal is not "fully automatic product mutation".
The design goal is:

- automatic discovery
- structured human confirmation
- controlled execution
- measurable evaluation

The intended operator experience is low-interaction:

- register the target product once
- review a proposed requirement or change when asked
- confirm, reject, or revise it
- let the system handle bounded execution and follow-up evaluation

In steady state, the human should not need to manually drive every iteration step after approval.

## Why The Current Dispatch Model Is Transitional

The current runtime can dispatch MelodySync child-session work through a host adapter.

That was useful to prove the loop:

- data in
- signals out
- one spec drafted
- one experiment dispatched
- one decision recorded

But it leaves the wrong default boundary:

- analysis and execution are too close
- the observed host can become the executor
- repeated signals can too easily become repeated host mutations

That is acceptable for bootstrapping and wrong as the long-term contract.

## Target Principle

`pm-loop` must be able to observe MelodySync without depending on MelodySync to execute code changes.

MelodySync can remain:

- a telemetry source
- a review surface
- one possible target product

But execution should happen through repo-scoped runners under explicit approval.

## Minimal Product Flow

The first usable flow should stay this small:

1. Know the project path.
2. Analyze the project and produce a proposed requirement.
3. Let the human decide whether to include it.
4. If approved, hand off execution automatically inside the target policy.

In system terms that becomes:

```text
ProjectTarget
  -> Opportunity / SpecDraft
  -> ChangeProposal
  -> Human Approval
  -> ExecutionRunner
```

## Required Objects

### `ProjectTarget`

The execution destination:

- repo path
- base branch
- writable paths
- test policy
- merge policy
- default execution mode

### `ChangeProposal`

The thing a human approves:

- linked opportunity and spec
- requested actions
- rationale
- risk level
- target repo

### `ApprovalRecord`

The explicit review decision:

- approved
- rejected
- revised

This should be a first-class durable object, not just a button click that vanishes.

## Human Involvement Boundary

The approval boundary is the main interaction contract.

Humans should be responsible for:

- selecting or registering the repo
- confirming or rejecting proposed requirements
- escalating policy or risk exceptions

The system should be responsible for:

- recurring discovery
- proposal drafting and ranking
- approved execution handoff
- outcome evaluation and follow-up recommendations

## Required Ports

### `ApprovalGate`

Responsible for:

- queueing proposals
- listing pending proposals
- recording human decisions
- exposing latest approval state

### `TargetRegistry`

Responsible for:

- declaring which repos can be touched
- defining execution policy per repo
- separating telemetry sources from write targets

### `ExecutionRunner`

Responsible for:

- creating a safe branch/worktree
- invoking Codex or another approved executor
- running checks/tests
- returning experiment metadata

This is where Codex belongs.
Not in the analysis layer.

## Human Review Model

The operator should be able to review proposals in a point-and-click queue.

Each proposal card should answer:

1. What problem was detected?
2. Why does `pm-loop` think it matters now?
3. Which repo will be touched?
4. What exact change is requested?
5. How risky is it?
6. What checks will run?

Then the operator should be able to:

- approve
- reject
- request revision
- park

## Safety Model

Default rules:

1. No direct writes to default branch.
2. No automatic merge.
3. No execution outside target registry.
4. No writes outside allowed paths.
5. Tests are required when the target policy says so.

This keeps the system autonomous in discovery but bounded in execution.

## Recommended Migration

1. Keep current telemetry ingestion.
2. Keep current state store and reporting.
3. Add proposal objects and approval queue.
4. Add target registry.
5. Add Codex-backed execution runner.
6. Demote MelodySync child-session dispatch to a legacy path.

At that point `pm-loop` becomes a true independent PM control plane rather than a MelodySync-driven automation extension.

Until that migration is complete, any remaining operator step beyond proposal confirmation should be treated as temporary implementation debt, not as the intended product UX.
