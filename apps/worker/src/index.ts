import {
  SystemClock,
  detectUseCase,
  evaluateUseCase,
  hasRunningExperimentForOpportunity,
  planUseCase,
  proposeUseCase,
  scanUseCase,
  selectDispatchableOpportunity,
} from "@pm-loop/core";
import {
  MelodySyncRuntimeOutcomeReader,
  ShadowOutcomeReader,
} from "@pm-loop/adapter-melodysync";
import { JsonFileApprovalGate } from "@pm-loop/approval-local";
import { CodexCliExecutionRunner } from "@pm-loop/execution-codex-local";
import { HeuristicLLMClient } from "@pm-loop/llm-openai";
import { LocalPatternSource } from "@pm-loop/patterns-local";
import { JsonFileStateStore } from "@pm-loop/storage-sqlite";
import { LocalTargetRegistry } from "@pm-loop/targets-local";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildLoopConfig, defaultWindowStart, parseIntEnv } from "../../shared/config.js";
import { createProjectEventSource } from "../../shared/project-runtime.js";

const loopConfig = buildLoopConfig();
const mode = loopConfig.mode;
const paths = loopConfig.paths;
const projectSourceId = loopConfig.project?.sourceId ?? loopConfig.projectId;

const clock = new SystemClock();
const stateStore = new JsonFileStateStore({ filePath: paths.stateFile });
const approvalGate = new JsonFileApprovalGate({ filePath: paths.approvalStateFile });
const patternSource = new LocalPatternSource({ filePath: paths.patternFile });
const targetRegistry = new LocalTargetRegistry({ filePath: paths.targetsFile });
const eventSource = createProjectEventSource(loopConfig);
const outcomeReader = mode === "shadow" ? new ShadowOutcomeReader() : new MelodySyncRuntimeOutcomeReader();
const llm = new HeuristicLLMClient();
const executionRunner =
  mode === "shadow"
    ? null
    : new CodexCliExecutionRunner({
        runtimeDir: paths.executionDir
      });

const intervalMs = parseIntEnv("PM_LOOP_INTERVAL_MS", 0, { min: 0, allowZero: true });
const maxActiveExperiments = parseIntEnv("PM_LOOP_MAX_ACTIVE_EXPERIMENTS", 1, { min: 1 });

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isProposalBlocking = (status: string): boolean => !["expired", "superseded"].includes(status);
const isActiveExperiment = (status: string): boolean => status === "draft" || status === "running";
const hasExecutionForProposal = (
  experiments: Awaited<ReturnType<typeof stateStore.listExperiments>>,
  proposalId: string
): boolean => experiments.some((experiment) => experiment.proposalId === proposalId);

const emitLog = async (payload: unknown): Promise<void> => {
  const line = `${new Date().toISOString()} ${JSON.stringify(payload)}\n`;
  try {
    await appendFile(paths.workerLogPath, line);
  } catch {
    console.error("[pm-loop/worker] failed to append worker log", payload);
  }
};

const runCycle = async (): Promise<void> => {
  const since = defaultWindowStart();
  const scan = await scanUseCase({ clock, eventSource, stateStore }, { since });
  const detect = await detectUseCase(stateStore, { since, source: projectSourceId });
  const plan = await planUseCase({ clock, llm, patternSource, stateStore }, { source: projectSourceId });
  let existingExperiments = await stateStore.listExperiments();
  const existingProposals = await approvalGate.listProposals();
  const targets = await targetRegistry.listTargets();
  const defaultTarget = loopConfig.project?.targetId
    ? targets.find((target) => target.id === loopConfig.project?.targetId)
    : targets.find((target) => target.telemetrySources.includes(projectSourceId));
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const blockedOpportunityIds = new Set(
    existingProposals
      .filter((proposal) => isProposalBlocking(proposal.status))
      .map((proposal) => proposal.opportunityId)
  );
  const proposalOpportunities = plan.opportunities.filter((opportunity) => !blockedOpportunityIds.has(opportunity.id));
  const proposalTarget = mode === "shadow" ? null : selectDispatchableOpportunity(proposalOpportunities, existingExperiments, {
    maxActiveExperiments
  });
  const topOpportunity = proposalOpportunities[0] ?? plan.opportunities[0];
  const topOpportunityBlocked = topOpportunity ? blockedOpportunityIds.has(topOpportunity.id) : false;
  let proposalId: string | null = null;
  let skippedReason: string | null = null;
  const approvedProposals = existingProposals
    .filter((proposal) => proposal.status === "approved")
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  const activeExperimentCount = existingExperiments.filter((experiment) => isActiveExperiment(experiment.status)).length;
  const executionSlots = Math.max(0, maxActiveExperiments - activeExperimentCount);
  const executableApprovedProposals =
    mode === "shadow"
      ? []
      : approvedProposals
          .filter((proposal) => !hasExecutionForProposal(existingExperiments, proposal.id))
          .slice(0, executionSlots);
  const executedProposalIds: string[] = [];
  const executionSkips: string[] = [];

  if (mode === "shadow") {
    skippedReason = "shadow mode: proposal generation disabled";
  } else if (proposalTarget && defaultTarget) {
    if (!plan.spec || plan.spec.opportunityId !== proposalTarget.id) {
      await planUseCase(
        {
          clock,
          llm,
          patternSource,
          stateStore
        },
        {
          source: projectSourceId,
          preferredOpportunityId: proposalTarget.id
        }
      );
    }
    const proposed = await proposeUseCase(
      { approvalGate, clock, stateStore, targetRegistry },
      {
        opportunityId: proposalTarget.id,
        targetId: defaultTarget.id
      }
    );
    proposalId = proposed.proposal.id;
  } else if (!defaultTarget && (proposalTarget || topOpportunity)) {
    skippedReason = `no target registry entry for project ${projectSourceId}`;
  } else if (topOpportunity) {
    if (topOpportunityBlocked) {
      skippedReason = "top opportunity already queued for approval";
    } else if (hasRunningExperimentForOpportunity(topOpportunity.id, existingExperiments)) {
      skippedReason = "top opportunity already has a running experiment";
    } else if (existingExperiments.filter((experiment) => experiment.status === "running").length >= maxActiveExperiments) {
      skippedReason = `active experiment limit reached (${maxActiveExperiments})`;
    } else {
      skippedReason = topOpportunity
        ? hasRunningExperimentForOpportunity(topOpportunity.id, existingExperiments)
          ? "top opportunity already has a running experiment"
          : `top opportunity is not dispatchable in status ${topOpportunity.status}`
        : "no opportunity available";
    }
  } else {
    skippedReason = "no opportunities available";
  }

  if (executionRunner && executableApprovedProposals.length > 0) {
    for (const proposal of executableApprovedProposals) {
      const target = targetById.get(proposal.targetId);
      if (!target) {
        executionSkips.push(`${proposal.id}: missing target ${proposal.targetId}`);
        continue;
      }
      const spec = await stateStore.getSpecByOpportunityId(proposal.opportunityId);
      const latestApproval = await approvalGate.getLatestApproval(proposal.id);
      if (!spec) {
        executionSkips.push(`${proposal.id}: missing spec for ${proposal.opportunityId}`);
        continue;
      }
      const { experiment } = await executionRunner.enqueueExecution({
        target,
        proposal,
        spec,
        approvalNote: latestApproval?.note,
        owner: "pm-loop-worker",
        mode: target.defaultExecutionMode,
      });
      await stateStore.saveExperiment(experiment);
      existingExperiments = [...existingExperiments, experiment];
      executedProposalIds.push(proposal.id);
    }
  }

  const evaluate = await evaluateUseCase({ clock, llm, outcomeReader, stateStore });

  const snapshot = {
    mode: `${loopConfig.projectId}-worker-${mode}`,
    since,
    scanned: scan.scanned,
    signals: detect.signals.length,
    opportunities: plan.opportunities.length,
    proposalTargetId: proposalTarget?.id ?? null,
    proposalId,
    approvedProposalCount: approvedProposals.length,
    approvedExecutionReadyCount: approvedProposals.filter((proposal) => !hasExecutionForProposal(existingExperiments, proposal.id)).length,
    executedProposalIds,
    executionSkips,
    topOpportunityId: topOpportunity?.id ?? null,
    topOpportunityStatus: topOpportunity?.status ?? null,
    proposalBlockingCount: blockedOpportunityIds.size,
    skippedReason,
    maxActiveExperiments,
    decisions: evaluate.decisions.length,
    intervalMs
  };
  await emitLog(snapshot);
  console.log(JSON.stringify(snapshot, null, 2));
};

await mkdir(dirname(paths.workerLogPath), { recursive: true });
await writeFile(paths.workerPidPath, String(process.pid), "utf8");

if (intervalMs > 0) {
  while (true) {
    try {
      await runCycle();
    } catch (error) {
      const errorPayload = {
        mode: `${loopConfig.projectId}-worker-${mode}`,
        severity: "cycle-error",
        error: error instanceof Error ? error.message : String(error),
      };
      await emitLog(errorPayload);
      console.error(error);
    }
    await sleep(intervalMs);
  }
} else {
  await runCycle();
}
