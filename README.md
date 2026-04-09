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

```bash
cd ~/code/pm-loop
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
```

Override the polling interval when needed:

```bash
PM_LOOP_MODE=assist PM_LOOP_INTERVAL_MS=300000 npm run worker
```

Override the concurrent experiment cap when needed:

```bash
PM_LOOP_MODE=assist PM_LOOP_MAX_ACTIVE_EXPERIMENTS=2 npm run worker
```

Local sidecar state is written to:

- `~/code/pm-loop/data/state.json`
- `~/code/pm-loop/data/latest-report.md`
- `~/code/pm-loop/data/approval-state.json`

Pattern seeds are stored in:

- `~/code/pm-loop/catalog/patterns.json`

Target registry seeds are stored in:

- `~/code/pm-loop/catalog/targets.json`

If you run the worker as a detached process, store the PID and stop it with:

```bash
kill "$(cat ~/code/pm-loop/data/worker.pid)"
```

## Dashboard Access

The current MVP is hosted inside MelodySync so it can reuse authentication while keeping `pm-loop` itself decoupled from execution.

Default entry:

```text
http://127.0.0.1:7760/pm-loop.html
```

It renders from:

- `~/code/pm-loop/data/state.json`
- `~/code/pm-loop/data/approval-state.json`
- `~/code/pm-loop/data/latest-report.md`
- `~/code/pm-loop/data/worker.log`

The current UI is an approval console:

- `Proposal Queue`: approve / reject / defer candidate changes
- `Top Opportunities`: context only, no direct dispatch
- `Running Loop`: active experiments and signals

Approved work is still a separate step. `pm-loop` does not auto-merge and does not auto-push target repositories. The current execution handoff writes a detached Codex run plus execution receipts under:

- `~/code/pm-loop/data/executions/`

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
