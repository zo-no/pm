import {
  SystemClock,
  proposeUseCase,
  detectUseCase,
  dispatchUseCase,
  evaluateUseCase,
  hasRunningExperimentForOpportunity,
  planUseCase,
  scanUseCase,
  selectDispatchableOpportunity,
  type ActionRunner,
  type Decision,
  type Event,
  type EventSource,
  type Experiment,
  type ExperimentOutcome,
  type Opportunity,
  type OutcomeReader,
  type ProjectTarget,
  type Signal,
  type SpecDraft,
  type StateStore
} from "@pm-loop/core";
import {
  MelodySyncCliActionRunner,
  MelodySyncRuntimeEventSource,
  MelodySyncRuntimeOutcomeReader,
  MelodySyncShadowActionRunner,
  ShadowOutcomeReader
} from "@pm-loop/adapter-melodysync";
import { JsonFileApprovalGate } from "@pm-loop/approval-local";
import { CodexCliExecutionRunner } from "@pm-loop/execution-codex-local";
import { HeuristicLLMClient } from "@pm-loop/llm-openai";
import { LocalPatternSource } from "@pm-loop/patterns-local";
import { JsonFileStateStore } from "@pm-loop/storage-sqlite";
import { LocalTargetRegistry } from "@pm-loop/targets-local";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

class MemoryStateStore implements StateStore {
  private readonly events: Event[] = [];
  private readonly signals = new Map<string, Signal>();
  private readonly opportunities = new Map<string, Opportunity>();
  private readonly specs = new Map<string, SpecDraft>();
  private readonly experiments = new Map<string, Experiment>();
  private readonly decisions: Decision[] = [];

  async appendEvents(events: Event[]): Promise<void> {
    this.events.push(...events);
  }

  async listEvents(input: { since?: string; until?: string; source?: string } = {}): Promise<Event[]> {
    return this.events.filter((event) => {
      if (input.source && event.source !== input.source) return false;
      if (input.since && event.ts < input.since) return false;
      if (input.until && event.ts > input.until) return false;
      return true;
    });
  }

  async upsertSignals(signals: Signal[]): Promise<void> {
    for (const signal of signals) this.signals.set(signal.id, signal);
  }

  async listSignals(input: { statuses?: Signal["status"][]; source?: string } = {}): Promise<Signal[]> {
    return [...this.signals.values()].filter((signal) => {
      if (input.source && signal.source !== input.source) return false;
      if (input.statuses && !input.statuses.includes(signal.status)) return false;
      return true;
    });
  }

  async upsertOpportunities(opportunities: Opportunity[]): Promise<void> {
    for (const opportunity of opportunities) this.opportunities.set(opportunity.id, opportunity);
  }

  async listOpportunities(input: { statuses?: Opportunity["status"][]; source?: string } = {}): Promise<Opportunity[]> {
    return [...this.opportunities.values()].filter((opportunity) => {
      if (input.source && opportunity.source !== input.source) return false;
      if (input.statuses && !input.statuses.includes(opportunity.status)) return false;
      return true;
    });
  }

  async saveSpec(spec: SpecDraft): Promise<void> {
    this.specs.set(spec.opportunityId, spec);
  }

  async getSpecByOpportunityId(opportunityId: string): Promise<SpecDraft | undefined> {
    return this.specs.get(opportunityId);
  }

  async saveExperiment(experiment: Experiment): Promise<void> {
    this.experiments.set(experiment.id, experiment);
  }

  async listExperiments(): Promise<Experiment[]> {
    return [...this.experiments.values()];
  }

  async appendDecision(decision: Decision): Promise<void> {
    this.decisions.push(decision);
  }
}

class DemoEventSource implements EventSource {
  async fetchEvents(): Promise<{ events: Event[] }> {
    return {
      events: [
        {
          id: "evt-1",
          ts: "2026-04-09T09:00:00.000Z",
          source: "demo-host",
          actor: "user",
          type: "user_intent",
          subject: "batch-edit",
          outcome: "unknown",
          tags: ["demo"],
          payload: { note: "Repeated request for batch edit" }
        },
        {
          id: "evt-2",
          ts: "2026-04-09T09:05:00.000Z",
          source: "demo-host",
          actor: "user",
          type: "user_intent",
          subject: "batch-edit",
          outcome: "unknown",
          tags: ["demo"],
          payload: { note: "Another request for batch edit" }
        },
        {
          id: "evt-3",
          ts: "2026-04-09T09:10:00.000Z",
          source: "demo-host",
          actor: "user",
          type: "user_intent",
          subject: "batch-edit",
          outcome: "unknown",
          tags: ["demo"],
          payload: { note: "Third request for batch edit" }
        },
        {
          id: "evt-4",
          ts: "2026-04-09T09:12:00.000Z",
          source: "demo-host",
          actor: "system",
          type: "tool_error",
          subject: "branch-dispatch",
          outcome: "failure",
          tags: ["demo"],
          payload: { error: "Dispatch stalled" }
        },
        {
          id: "evt-5",
          ts: "2026-04-09T09:13:00.000Z",
          source: "demo-host",
          actor: "system",
          type: "tool_error",
          subject: "branch-dispatch",
          outcome: "failure",
          tags: ["demo"],
          payload: { error: "Dispatch stalled again" }
        }
      ]
    };
  }
}

class DemoActionRunner implements ActionRunner {
  async dispatchPlan(input: {
    opportunityId: string;
    spec: SpecDraft;
    mode: Experiment["mode"];
    sourceSessionId?: string;
  }): Promise<{ experiment: Experiment }> {
    return {
      experiment: {
        id: `exp:${input.opportunityId}`,
        opportunityId: input.opportunityId,
        specId: input.spec.id,
        mode: input.mode,
        owner: "demo-runner",
        hostRefs: ["demo-branch-1"],
        status: "draft",
        summary: "Demo experiment dispatched"
      }
    };
  }
}

class DemoOutcomeReader implements OutcomeReader {
  async fetchOutcome(input: { experimentId: string }): Promise<ExperimentOutcome> {
    return {
      experimentId: input.experimentId,
      status: "finished",
      metrics: { signal_drop_ratio: 0.4 },
      summary: "Demo experiment reduced the signal count in the test window."
    };
  }
}

const runDemo = async (): Promise<void> => {
  const clock = new SystemClock();
  const stateStore = new MemoryStateStore();
  const eventSource = new DemoEventSource();
  const actionRunner = new DemoActionRunner();
  const outcomeReader = new DemoOutcomeReader();
  const llm = new HeuristicLLMClient();

  const scan = await scanUseCase(
    { clock, eventSource, stateStore },
    { since: "2026-04-09T00:00:00.000Z" }
  );
  const detect = await detectUseCase(stateStore, {
    since: "2026-04-09T00:00:00.000Z"
  });
  const plan = await planUseCase({ clock, llm, stateStore }, { source: "demo-host" });
  const topOpportunity = plan.opportunities[0];
  if (!topOpportunity) {
    console.log("No opportunity found.");
    return;
  }
  const dispatch = await dispatchUseCase(
    { actionRunner, clock, stateStore },
    { opportunityId: topOpportunity.id, mode: "assist", owner: "demo-runner" }
  );
  const evaluate = await evaluateUseCase({
    clock,
    llm,
    outcomeReader,
    stateStore
  });

  console.log(
    JSON.stringify(
      {
        scan,
        detect,
        plan: {
          opportunities: plan.opportunities,
          spec: plan.spec
        },
        dispatch,
        evaluate
      },
      null,
      2
    )
  );
};

const stateFile = join(homedir(), "code", "pm-loop", "data", "state.json");
const approvalStateFile = join(homedir(), "code", "pm-loop", "data", "approval-state.json");
const reportFile = join(homedir(), "code", "pm-loop", "data", "latest-report.md");
const patternFile = join(homedir(), "code", "pm-loop", "catalog", "patterns.json");
const targetsFile = join(homedir(), "code", "pm-loop", "catalog", "targets.json");
const maxActiveExperiments = Number(process.env.PM_LOOP_MAX_ACTIVE_EXPERIMENTS ?? "1");
const defaultSince = (): string => {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString();
};

interface LoopSummary {
  mode: string;
  stateFile: string;
  reportFile: string;
  since: string;
  scan: { scanned: number; at: string; nextCursor?: string };
  detect: { signalCount: number; signals: Signal[] };
  plan: { opportunityCount: number; topOpportunities: Opportunity[]; spec?: SpecDraft };
  dispatch: { experiment?: Experiment; targetOpportunityId?: string; skippedReason?: string };
  evaluate: { decisions: Decision[] };
}

const renderMarkdownReport = async (
  summary: LoopSummary,
  stateStore: StateStore
): Promise<string> => {
  const opportunities = (await stateStore.listOpportunities({ source: "melodysync" })).sort(
    (a, b) => b.priorityScore - a.priorityScore
  );
  const experiments = await stateStore.listExperiments();
  const top = opportunities.slice(0, 5);
  const opportunityStatusCounts = opportunities.reduce<Record<string, number>>((acc, opportunity) => {
    acc[opportunity.status] = (acc[opportunity.status] ?? 0) + 1;
    return acc;
  }, {});
  const experimentStatusCounts = experiments.reduce<Record<string, number>>((acc, experiment) => {
    acc[experiment.status] = (acc[experiment.status] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    "# PM Loop Report",
    "",
    `- mode: ${summary.mode}`,
    `- since: ${summary.since}`,
    `- scanned events: ${summary.scan.scanned}`,
    `- signal count: ${summary.detect.signalCount}`,
    `- opportunity count: ${summary.plan.opportunityCount}`,
    `- experiment count: ${experiments.length}`,
    "",
    "## Pipeline",
    "",
    `- opportunity stages: ${Object.entries(opportunityStatusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "none"}`,
    `- experiment stages: ${Object.entries(experimentStatusCounts)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "none"}`,
    "",
    "## Top Opportunities",
    ""
  ];

  for (const [index, opportunity] of top.entries()) {
    const spec = await stateStore.getSpecByOpportunityId(opportunity.id);
    lines.push(`### ${index + 1}. ${opportunity.title}`);
    lines.push(`- priority: ${opportunity.priorityScore}`);
    lines.push(`- status: ${opportunity.status}`);
    lines.push(`- source session: ${opportunity.primarySessionId || "n/a"}`);
    lines.push(`- impacted users/events: ${opportunity.impactedUsers}`);
    lines.push(`- problem: ${opportunity.problem}`);
    if (spec) {
      lines.push(`- spec id: ${spec.id}`);
      lines.push(`- trigger: ${spec.trigger}`);
      lines.push(`- desired behavior: ${spec.desiredBehavior}`);
      if (spec.references && spec.references.length > 0) {
        lines.push(`- references: ${spec.references.join(", ")}`);
      }
    }
    const relatedExperiments = experiments.filter((experiment) => experiment.opportunityId === opportunity.id);
    if (relatedExperiments.length > 0) {
      lines.push(
        `- experiments: ${relatedExperiments
          .map((experiment) => `${experiment.id}(${experiment.status})`)
          .join(", ")}`
      );
    }
    lines.push("");
  }

  if (summary.dispatch.experiment) {
    lines.push("## Latest Dispatch");
    lines.push("");
    lines.push(`- run/experiment id: ${summary.dispatch.experiment.id}`);
    lines.push(`- mode: ${summary.dispatch.experiment.mode}`);
    lines.push(`- status: ${summary.dispatch.experiment.status}`);
    lines.push(`- summary: ${summary.dispatch.experiment.summary || ""}`);
    lines.push("");
  } else if (summary.dispatch.skippedReason) {
    lines.push("## Dispatch");
    lines.push("");
    lines.push(`- skipped: ${summary.dispatch.skippedReason}`);
    if (summary.dispatch.targetOpportunityId) {
      lines.push(`- target opportunity: ${summary.dispatch.targetOpportunityId}`);
    }
    lines.push("");
  }

  if (summary.evaluate.decisions.length > 0) {
    lines.push("## Latest Decisions");
    lines.push("");
    for (const decision of summary.evaluate.decisions) {
      lines.push(`- ${decision.outcome}: ${decision.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
};

const writeReport = async (content: string): Promise<void> => {
  await mkdir(join(homedir(), "code", "pm-loop", "data"), { recursive: true });
  await writeFile(reportFile, content);
};

const runRealLoop = async (
  mode: "shadow" | "assist"
): Promise<LoopSummary> => {
  const clock = new SystemClock();
  const stateStore = new JsonFileStateStore({ filePath: stateFile });
  const eventSource = new MelodySyncRuntimeEventSource();
  const actionRunner = mode === "assist" ? new MelodySyncCliActionRunner() : new MelodySyncShadowActionRunner();
  const outcomeReader = mode === "assist" ? new MelodySyncRuntimeOutcomeReader() : new ShadowOutcomeReader();
  const llm = new HeuristicLLMClient();
  const patternSource = new LocalPatternSource({ filePath: patternFile });
  const since = process.argv[3] ?? defaultSince();

  const scan = await scanUseCase({ clock, eventSource, stateStore }, { since });
  const detect = await detectUseCase(stateStore, { since, source: "melodysync" });
  const evaluate = await evaluateUseCase({ clock, llm, outcomeReader, stateStore });
  const plan = await planUseCase({ clock, llm, patternSource, stateStore }, { source: "melodysync" });
  const existingExperiments = await stateStore.listExperiments();
  const dispatchTarget = selectDispatchableOpportunity(plan.opportunities, existingExperiments, {
    maxActiveExperiments
  });
  const plannedForDispatch =
    dispatchTarget && (!plan.spec || plan.spec.opportunityId !== dispatchTarget.id)
      ? await planUseCase({
          clock,
          llm,
          patternSource,
          stateStore
        }, {
          source: "melodysync",
          preferredOpportunityId: dispatchTarget.id
        })
      : plan;

  let dispatch: { experiment?: Experiment; targetOpportunityId?: string; skippedReason?: string } = {};
  if (dispatchTarget) {
    dispatch = await dispatchUseCase(
      { actionRunner, clock, stateStore },
      {
        opportunityId: dispatchTarget.id,
        mode,
        owner: mode === "assist" ? "melodysync-cli-runner" : "melodysync-shadow-runner"
      }
    );
  } else {
    const topOpportunity = plan.opportunities[0];
    dispatch = {
      targetOpportunityId: topOpportunity?.id,
      skippedReason: topOpportunity
        ? hasRunningExperimentForOpportunity(topOpportunity.id, existingExperiments)
          ? "top opportunity already has a running experiment"
          : existingExperiments.filter((experiment) => experiment.status === "running").length >= maxActiveExperiments
            ? `active experiment limit reached (${maxActiveExperiments})`
            : `top opportunity is not dispatchable in status ${topOpportunity.status}`
        : "no opportunity available"
    };
  }

  const summary: LoopSummary = {
    mode: `melodysync-${mode}`,
    stateFile,
    reportFile,
    since,
    scan,
    detect: {
      signalCount: detect.signals.length,
      signals: detect.signals.slice(0, 10)
    },
    plan: {
      opportunityCount: plan.opportunities.length,
      topOpportunities: plan.opportunities.slice(0, 5),
      spec: plannedForDispatch.spec
    },
    dispatch,
    evaluate
  };
  const report = await renderMarkdownReport(summary, stateStore);
  await writeReport(report);
  return summary;
};

const runMelodySyncShadow = async (): Promise<void> => {
  const summary = await runRealLoop("shadow");
  console.log(JSON.stringify(summary, null, 2));
};

const runMelodySyncAssist = async (): Promise<void> => {
  const summary = await runRealLoop("assist");
  console.log(JSON.stringify(summary, null, 2));
};

const runApproved = async (): Promise<void> => {
  const proposalId = process.argv[3] ?? "";
  const stateStore = new JsonFileStateStore({ filePath: stateFile });
  const approvalGate = new JsonFileApprovalGate({ filePath: approvalStateFile });
  const targetRegistry = new LocalTargetRegistry({ filePath: targetsFile });
  const executionRunner = new CodexCliExecutionRunner();
  const proposals = await approvalGate.listProposals({ status: ["approved"] });
  const proposal = proposalId
    ? proposals.find((item) => item.id === proposalId)
    : [...proposals].sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0];
  if (!proposal) {
    console.error(proposalId ? `No approved proposal found for ${proposalId}` : "No approved proposals available.");
    process.exitCode = 1;
    return;
  }
  const target: ProjectTarget | undefined = await targetRegistry.getTarget(proposal.targetId);
  if (!target) {
    throw new Error(`No target found for ${proposal.targetId}`);
  }
  const spec = await stateStore.getSpecByOpportunityId(proposal.opportunityId);
  if (!spec) {
    throw new Error(`No spec found for approved proposal ${proposal.id}`);
  }
  const { experiment } = await executionRunner.enqueueExecution({
    target,
    proposal,
    spec,
    owner: "codex-cli-runner",
    mode: target.defaultExecutionMode,
  });
  await stateStore.saveExperiment(experiment);
  console.log(JSON.stringify({ proposal, target, experiment }, null, 2));
};

const runReport = async (): Promise<void> => {
  const stateStore = new JsonFileStateStore({ filePath: stateFile });
  const opportunities = await stateStore.listOpportunities({ source: "melodysync" });
  const signals = await stateStore.listSignals({ source: "melodysync" });
  const summary: LoopSummary = {
    mode: "report-only",
    stateFile,
    reportFile,
    since: "existing-state",
    scan: { scanned: 0, at: new Date().toISOString() },
    detect: { signalCount: signals.length, signals: signals.slice(0, 10) },
    plan: {
      opportunityCount: opportunities.length,
      topOpportunities: opportunities.slice(0, 5)
    },
    dispatch: {},
    evaluate: { decisions: [] }
  };
  const report = await renderMarkdownReport(summary, stateStore);
  await writeReport(report);
  console.log(report);
};

const command = process.argv[2] ?? "demo";
if (command === "demo") {
  await runDemo();
} else if (command === "melodysync-shadow") {
  await runMelodySyncShadow();
} else if (command === "melodysync-assist") {
  await runMelodySyncAssist();
} else if (command === "report") {
  await runReport();
} else if (command === "run-approved") {
  await runApproved();
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
