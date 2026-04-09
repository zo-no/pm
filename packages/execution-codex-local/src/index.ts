import type { ChangeProposal, ExecutionRunner, Experiment, ProjectTarget, SpecDraft } from "@pm-loop/core";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

export interface CodexCliExecutionRunnerOptions {
  runtimeDir?: string;
  codexCommand?: string;
  model?: string;
  reasoningEffort?: string;
}

interface ExecutionReceipt {
  experimentId: string;
  proposalId: string;
  targetId: string;
  repoPath: string;
  branchName: string;
  logPath: string;
  promptPath: string;
  pid: number;
  createdAt: string;
  mode: Experiment["mode"];
  owner: string;
}

const sanitizeBranchSegment = (value: string): string =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "proposal";

const buildBranchName = (proposal: ChangeProposal): string => {
  const segment = sanitizeBranchSegment(`${proposal.changeType}-${proposal.opportunityId}`);
  return `pm-loop/${segment}`;
};

const buildPrompt = (input: {
  target: ProjectTarget;
  proposal: ChangeProposal;
  spec: SpecDraft;
  branchName: string;
}): string => {
  const { target, proposal, spec, branchName } = input;
  return [
    `You are executing an approved PM Loop proposal in the repository at ${target.repoPath}.`,
    `Create and work on a git branch named ${branchName}.`,
    `Do not merge, do not push, and do not revert unrelated local changes.`,
    `Proposal title: ${proposal.title}`,
    `Proposal summary: ${proposal.summary}`,
    `Rationale: ${proposal.rationale}`,
    `Change type: ${proposal.changeType}`,
    `Spec trigger: ${spec.trigger}`,
    `Desired behavior: ${spec.desiredBehavior}`,
    `Non-goals: ${(spec.nonGoals || []).join("; ") || "None stated."}`,
    `Acceptance criteria:`,
    ...(spec.acceptanceCriteria || []).map((criterion, index) => `${index + 1}. ${criterion}`),
    `Requested actions:`,
    ...proposal.requestedActions.map((action, index) => `${index + 1}. ${action}`),
    target.executionPolicy.requireTests
      ? "Run the relevant tests/checks before you finish. If tests cannot run, state why."
      : "Run lightweight validation when possible.",
    "Return a concise summary of changes, touched files, tests run, and any remaining risks.",
  ].join("\n");
};

export class CodexCliExecutionRunner implements ExecutionRunner {
  private readonly runtimeDir: string;
  private readonly codexCommand: string;
  private readonly model: string;
  private readonly reasoningEffort: string;

  constructor(options: CodexCliExecutionRunnerOptions = {}) {
    this.runtimeDir = options.runtimeDir || join(homedir(), "code", "pm-loop", "data", "executions");
    this.codexCommand = options.codexCommand || "codex";
    this.model = options.model || "gpt-5.4";
    this.reasoningEffort = options.reasoningEffort || "high";
  }

  async enqueueExecution(input: {
    target: ProjectTarget;
    proposal: ChangeProposal;
    spec: SpecDraft;
    mode?: Experiment["mode"];
    owner?: string;
  }): Promise<{ experiment: Experiment }> {
    const createdAt = new Date().toISOString();
    const branchName = buildBranchName(input.proposal);
    const experimentId = `exp:${input.proposal.id}:${createdAt}`;
    const safeId = sanitizeBranchSegment(experimentId);
    await mkdir(this.runtimeDir, { recursive: true });
    const promptPath = join(this.runtimeDir, `${safeId}.prompt.txt`);
    const logPath = join(this.runtimeDir, `${safeId}.log`);
    const receiptPath = join(this.runtimeDir, `${safeId}.json`);
    const prompt = buildPrompt({
      target: input.target,
      proposal: input.proposal,
      spec: input.spec,
      branchName,
    });
    await writeFile(promptPath, prompt);
    const out = await import("node:fs").then((fs) => fs.openSync(logPath, "a"));
    const child = spawn(
      this.codexCommand,
      [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "--skip-git-repo-check",
        "-C",
        input.target.repoPath,
        "-m",
        this.model,
        "-c",
        `model_reasoning_effort=${this.reasoningEffort}`,
        prompt,
      ],
      {
        cwd: input.target.repoPath,
        detached: true,
        stdio: ["ignore", out, out],
      }
    );
    child.unref();

    const receipt: ExecutionReceipt = {
      experimentId,
      proposalId: input.proposal.id,
      targetId: input.target.id,
      repoPath: input.target.repoPath,
      branchName,
      logPath,
      promptPath,
      pid: child.pid ?? -1,
      createdAt,
      mode: input.mode || input.target.defaultExecutionMode,
      owner: input.owner || "codex-cli-runner",
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));

    return {
      experiment: {
        id: experimentId,
        opportunityId: input.proposal.opportunityId,
        specId: input.proposal.specId,
        mode: input.mode || input.target.defaultExecutionMode,
        owner: input.owner || "codex-cli-runner",
        hostRefs: [receiptPath, logPath, promptPath, branchName],
        status: "running",
        summary: `Codex execution started for ${input.proposal.id} on ${branchName}`,
      },
    };
  }
}
