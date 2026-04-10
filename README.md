# PM Loop

`PM Loop` is a decoupled control-plane sidecar for product self-iteration.

It does not own host product features. It observes host behavior, turns behavior into product signals, prioritizes opportunities, drafts specs, submits candidate changes for human approval, and executes approved work through a repo-scoped runner while storing its own review history.
It can also pull from a local pattern catalog so demand generation is not limited to telemetry alone.

## Positioning

- `host product`: owns real features, user traffic, execution surface
- `pm-loop`: owns signal detection, opportunity scoring, spec planning, approval flow, execution orchestration, review state

That split is the main architectural rule. The sidecar must stay reusable across products.

Important boundary:

- host products may feed `pm-loop`
- host products may display `pm-loop`
- host products must not be the default execution engine for `pm-loop`

## User Interaction Model

Target steady-state UX:

1. Register the product repo as a `ProjectTarget`.
2. Let `pm-loop` mine telemetry and patterns on a schedule.
3. Review the ranked proposal it recommends.
4. Approve or reject the proposal.
5. After approval, let the system execute and evaluate the iteration within target policy.

Human interaction should collapse to proposal confirmation, plus occasional policy or revision decisions. The loop should not require the operator to manually drive each execution step.

Current implementation status:

- scheduled discovery and proposal generation exist
- durable proposal and approval state exist
- repo-scoped execution runner exists
- dashboard approval actions exist
- the worker can auto-start approved proposals without a separate execution command

## Repository Layout

```text
packages/
  approval-local/       # file-backed approval queue
  core/                 # product-agnostic domain and use cases
  adapter-melodysync/   # MelodySync host adapter
  storage-sqlite/       # sidecar-owned persistence boundary
  llm-openai/           # LLM boundary implementation
  targets-local/        # file-backed target registry
apps/
  cli/                  # manual control and demo mode
  worker/               # scheduled loop runner
  dashboard/            # local read-only access surface
docs/
  architecture.md
```

## Core Loop

```text
scan -> detect -> plan -> approval -> execute -> evaluate
```

Pattern-assisted planning path:

```text
signals + pattern catalog -> spec draft -> change proposal
```

Underlying state flow:

```text
event -> signal -> opportunity -> spec -> proposal -> experiment -> decision
```

## Non-Negotiable Boundaries

1. `packages/core` must not import host product code.
2. Host-specific concepts live only in adapters.
3. The sidecar stores its own state and history.
4. Host interaction happens only through explicit contracts.
5. Code execution happens only after explicit approval or a stricter target policy.

## Run Modes

- `shadow`: observe and plan only, no host actions
- `assist`: create proposals and execute only approved bounded actions
- `guarded`: allow broader automation behind stronger thresholds

The current runtime still has a transitional MelodySync-dispatch path for bootstrapping. The target runtime replaces that path with:

```text
ApprovalGate -> TargetRegistry -> ExecutionRunner
```

## Quick Start

Set an explicit root when needed (optional):

```bash
export PM_LOOP_ROOT="${PM_LOOP_ROOT:-$(pwd)}"
```

```bash
cd "$PM_LOOP_ROOT"
npm install
npm run cli -- demo
npm run cli -- melodysync-shadow
```

The demo path uses in-memory store and demo host stubs so the architecture can be exercised without a real adapter.
The `melodysync-shadow` path reads the real MelodySync runtime in shadow mode and persists PM Loop state locally.

## Real Usage

Run one real shadow cycle:

```bash
npm run cli -- melodysync-shadow
```

Run one real assist cycle that reads MelodySync telemetry and writes proposals into the local approval queue:

```bash
npm run cli -- melodysync-assist
```

Run one real guarded cycle:

```bash
npm run cli -- melodysync-guarded
```

When the worker is running, approved proposals are picked up automatically and executed within the target policy.

Use the manual execution command only as a fallback when you need to trigger an approved proposal without waiting for the worker:

After a proposal is approved, start a bounded Codex execution against the target repository:

```bash
npm run run-approved
```

Run a specific approved proposal by id:

```bash
npm run cli -- run-approved "proposal:..."
```

Render the latest stage report from persisted state:

```bash
npm run cli -- report
```

Start a long-running loop:

```bash
npm run start:shadow
npm run start:assist
npm run start:guarded
```

Override the polling interval when needed:

```bash
PM_LOOP_MODE=assist PM_LOOP_INTERVAL_MS=300000 npm run worker
```

Override the concurrent experiment cap when needed:

```bash
PM_LOOP_MODE=assist PM_LOOP_MAX_ACTIVE_EXPERIMENTS=2 npm run worker
```

Local sidecar state is written to (`$PM_LOOP_ROOT` or repository root inferred):

- `<root>/data/state.json`
- `<root>/data/latest-report.md`
- `<root>/data/approval-state.json`

Pattern seeds are stored in:

- `<root>/catalog/patterns.json`

Target registry seeds are stored in:

- `<root>/catalog/targets.json`

If you run the worker as a detached process, store the PID and stop it with:

```bash
ROOT="${PM_LOOP_ROOT:-$(pwd)}"
kill "$(cat "$ROOT/data/worker.pid")"
```

## Dashboard Access

The current MVP is hosted inside MelodySync so it can reuse authentication while keeping `pm-loop` itself decoupled from execution.

Default entry:

```text
http://127.0.0.1:7760/pm-loop.html
```

It renders from:

- `<root>/data/state.json`
- `<root>/data/approval-state.json`
- `<root>/data/latest-report.md`
- `<root>/data/worker.log`

The current UI is an approval and review surface:

- approve / reject / defer queued proposals
- proposal, opportunity, and experiment visibility
- report and worker log inspection

Approved work is still bounded by target policy. `pm-loop` does not auto-merge and does not auto-push target repositories. The current execution handoff writes a detached Codex run plus execution receipts under:

- `<root>/data/executions/`

## Target Architecture

The target system is:

```text
telemetry + pattern sources
  -> opportunity/spec generation
  -> project target selection
  -> approval queue
  -> codex-backed repo runner
  -> experiment evaluation
```

That means MelodySync can remain a data source or a UI surface, but should no longer be the default executor for product changes.
