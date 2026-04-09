import {
  SystemClock,
  detectUseCase,
  evaluateUseCase,
  planUseCase,
  proposeUseCase,
  scanUseCase,
} from "@pm-loop/core";
import {
  MelodySyncRuntimeEventSource,
  MelodySyncRuntimeOutcomeReader,
  ShadowOutcomeReader
} from "@pm-loop/adapter-melodysync";
import { JsonFileApprovalGate } from "@pm-loop/approval-local";
import { HeuristicLLMClient } from "@pm-loop/llm-openai";
import { LocalPatternSource } from "@pm-loop/patterns-local";
import { JsonFileStateStore } from "@pm-loop/storage-sqlite";
import { LocalTargetRegistry } from "@pm-loop/targets-local";
import { homedir } from "node:os";
import { join } from "node:path";

const clock = new SystemClock();
const stateStore = new JsonFileStateStore({
  filePath: join(homedir(), "code", "pm-loop", "data", "state.json")
});
const approvalGate = new JsonFileApprovalGate({
  filePath: join(homedir(), "code", "pm-loop", "data", "approval-state.json")
});
const patternSource = new LocalPatternSource({
  filePath: join(homedir(), "code", "pm-loop", "catalog", "patterns.json")
});
const targetRegistry = new LocalTargetRegistry({
  filePath: join(homedir(), "code", "pm-loop", "catalog", "targets.json")
});
const eventSource = new MelodySyncRuntimeEventSource();
const mode = process.env.PM_LOOP_MODE === "assist" ? "assist" : "shadow";
const outcomeReader = mode === "assist" ? new MelodySyncRuntimeOutcomeReader() : new ShadowOutcomeReader();
const llm = new HeuristicLLMClient();

const intervalMs = Number(process.env.PM_LOOP_INTERVAL_MS ?? "0");
const maxActiveExperiments = Number(process.env.PM_LOOP_MAX_ACTIVE_EXPERIMENTS ?? "1");

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isProposalBlocking = (status: string): boolean => !["expired", "superseded"].includes(status);

const runCycle = async (): Promise<void> => {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const scan = await scanUseCase({ clock, eventSource, stateStore }, { since });
  const detect = await detectUseCase(stateStore, { since, source: "melodysync" });
  const evaluate = await evaluateUseCase({ clock, llm, outcomeReader, stateStore });
  const plan = await planUseCase({ clock, llm, patternSource, stateStore }, { source: "melodysync" });
  const existingProposals = await approvalGate.listProposals();
  const targets = await targetRegistry.listTargets();
  const defaultTarget = targets.find((target) => target.telemetrySources.includes("melodysync"));
  const blockedOpportunityIds = new Set(
    existingProposals
      .filter((proposal) => isProposalBlocking(proposal.status))
      .map((proposal) => proposal.opportunityId)
  );
  const proposalTarget = plan.opportunities.find((opportunity) => !blockedOpportunityIds.has(opportunity.id)) ?? null;
  let proposalId: string | null = null;

  if (proposalTarget && defaultTarget) {
    if (!plan.spec || plan.spec.opportunityId !== proposalTarget.id) {
      await planUseCase({ clock, llm, patternSource, stateStore }, {
        source: "melodysync",
        preferredOpportunityId: proposalTarget.id
      });
    }
    const proposed = await proposeUseCase(
      { approvalGate, clock, stateStore, targetRegistry },
      {
        opportunityId: proposalTarget.id,
        targetId: defaultTarget.id
      }
    );
    proposalId = proposed.proposal.id;
  }

  const topOpportunity = plan.opportunities[0];
  console.log(
    JSON.stringify(
      {
        mode: `worker-${mode}`,
        since,
        scanned: scan.scanned,
        signals: detect.signals.length,
        opportunities: plan.opportunities.length,
        proposalTargetId: proposalTarget?.id || null,
        proposalId,
        topOpportunityId: topOpportunity?.id,
        topOpportunityStatus: topOpportunity?.status,
        maxActiveExperiments,
        decisions: evaluate.decisions.length,
        intervalMs
      },
      null,
      2
    )
  );
};

if (intervalMs > 0) {
  while (true) {
    try {
      await runCycle();
    } catch (error) {
      console.error(error);
    }
    await sleep(intervalMs);
  }
} else {
  await runCycle();
}
