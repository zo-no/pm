import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

interface EventRecord {
  id: string;
  ts: string;
  source: string;
  subject?: string;
}

interface SignalRecord {
  id: string;
  source: string;
  signalType: string;
  status: string;
  subject?: string;
  impactedUsers?: number;
}

interface OpportunityRecord {
  id: string;
  source: string;
  title: string;
  problem: string;
  primarySessionId?: string;
  impactedUsers?: number;
  priorityScore?: number;
  status: string;
}

interface SpecRecord {
  id: string;
  opportunityId: string;
  title: string;
  desiredBehavior: string;
  trigger: string;
  references?: string[];
}

interface ExperimentRecord {
  id: string;
  opportunityId: string;
  specId: string;
  mode: string;
  owner: string;
  hostRefs?: string[];
  status: string;
  summary?: string;
}

interface DecisionRecord {
  id: string;
  experimentId: string;
  opportunityId: string;
  outcome: string;
  reason: string;
  ts: string;
}

interface StateFile {
  events: EventRecord[];
  signals: SignalRecord[];
  opportunities: OpportunityRecord[];
  specs: SpecRecord[];
  experiments: ExperimentRecord[];
  decisions: DecisionRecord[];
}

const rootDir = join(homedir(), "code", "pm-loop");
const dataDir = join(rootDir, "data");
const statePath = join(dataDir, "state.json");
const reportPath = join(dataDir, "latest-report.md");
const workerLogPath = join(dataDir, "worker.log");
const workerPidPath = join(dataDir, "worker.pid");
const dashboardHost = process.env.PM_LOOP_DASHBOARD_HOST ?? "127.0.0.1";
const dashboardPort = Number(process.env.PM_LOOP_DASHBOARD_PORT ?? "4311");

const json = (value: unknown): string => JSON.stringify(value);

const readText = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
};

const readState = async (): Promise<StateFile> => {
  const raw = await readText(statePath);
  if (!raw) {
    return {
      events: [],
      signals: [],
      opportunities: [],
      specs: [],
      experiments: [],
      decisions: []
    };
  }
  return JSON.parse(raw) as StateFile;
};

const readFileMtime = async (filePath: string): Promise<string | null> => {
  try {
    const fileStat = await stat(filePath);
    return fileStat.mtime.toISOString();
  } catch {
    return null;
  }
};

const readWorkerPid = async (): Promise<number | null> => {
  const raw = (await readText(workerPidPath)).trim();
  if (!raw) return null;
  const pid = Number(raw);
  return Number.isFinite(pid) ? pid : null;
};

const isProcessAlive = (pid: number | null): boolean => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tailLines = (content: string, count: number): string =>
  content
    .trim()
    .split("\n")
    .slice(-count)
    .join("\n");

const countByStatus = <T extends { status: string }>(items: T[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return counts;
};

const buildOverview = async (): Promise<Record<string, unknown>> => {
  const [state, report, workerLog, workerPid, stateUpdatedAt, reportUpdatedAt, workerLogUpdatedAt] =
    await Promise.all([
      readState(),
      readText(reportPath),
      readText(workerLogPath),
      readWorkerPid(),
      readFileMtime(statePath),
      readFileMtime(reportPath),
      readFileMtime(workerLogPath)
    ]);

  const specByOpportunityId = new Map(state.specs.map((spec) => [spec.opportunityId, spec]));
  const experimentsByOpportunityId = new Map<string, ExperimentRecord[]>();
  for (const experiment of state.experiments) {
    const existing = experimentsByOpportunityId.get(experiment.opportunityId) ?? [];
    existing.push(experiment);
    experimentsByOpportunityId.set(experiment.opportunityId, existing);
  }

  const decisionsByExperimentId = new Map(state.decisions.map((decision) => [decision.experimentId, decision]));
  const opportunities = [...state.opportunities]
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .map((opportunity) => {
      const spec = specByOpportunityId.get(opportunity.id);
      const experiments = (experimentsByOpportunityId.get(opportunity.id) ?? []).map((experiment) => ({
        id: experiment.id,
        status: experiment.status,
        mode: experiment.mode,
        owner: experiment.owner,
        summary: experiment.summary,
        decision: decisionsByExperimentId.get(experiment.id)?.outcome ?? null
      }));
      return {
        ...opportunity,
        spec: spec
          ? {
              title: spec.title,
              trigger: spec.trigger,
              desiredBehavior: spec.desiredBehavior,
              references: spec.references ?? []
            }
          : null,
        experiments
      };
    });

  const activeExperiments = [...state.experiments]
    .filter((experiment) => experiment.status === "running" || experiment.status === "draft")
    .map((experiment) => ({
      ...experiment,
      decision: decisionsByExperimentId.get(experiment.id) ?? null
    }));

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    files: {
      state: statePath,
      report: reportPath,
      workerLog: workerLogPath,
      workerPid: workerPidPath
    },
    worker: {
      pid: workerPid,
      alive: isProcessAlive(workerPid),
      logUpdatedAt: workerLogUpdatedAt
    },
    freshness: {
      stateUpdatedAt,
      reportUpdatedAt
    },
    counts: {
      events: state.events.length,
      signals: state.signals.length,
      opportunities: state.opportunities.length,
      experiments: state.experiments.length,
      decisions: state.decisions.length
    },
    stages: {
      opportunities: countByStatus(state.opportunities),
      experiments: countByStatus(state.experiments)
    },
    recentSignals: [...state.signals]
      .sort((a, b) => (b.impactedUsers ?? 0) - (a.impactedUsers ?? 0))
      .slice(0, 6),
    opportunities: opportunities.slice(0, 8),
    activeExperiments,
    report,
    workerLog: tailLines(workerLog, 120)
  };
};

const dashboardHtml = `
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PM Loop Dashboard</title>
    <style>
      :root {
        --bg: #f4f1ea;
        --panel: rgba(255, 252, 245, 0.88);
        --panel-strong: rgba(255, 252, 245, 0.96);
        --ink: #1d1f1a;
        --muted: #6a6e63;
        --line: rgba(33, 36, 28, 0.12);
        --accent: #0b8b68;
        --accent-soft: rgba(11, 139, 104, 0.12);
        --danger: #a2412f;
        --shadow: 0 20px 48px rgba(29, 31, 26, 0.08);
      }

      * { box-sizing: border-box; }

      html, body {
        margin: 0;
        min-height: 100%;
        background:
          radial-gradient(circle at top left, rgba(11, 139, 104, 0.10), transparent 34%),
          radial-gradient(circle at bottom right, rgba(162, 65, 47, 0.08), transparent 26%),
          var(--bg);
        color: var(--ink);
        font-family: "SF Pro Display", "Avenir Next", "Segoe UI", sans-serif;
      }

      body {
        padding: 24px;
      }

      .shell {
        max-width: 1440px;
        margin: 0 auto;
        display: grid;
        gap: 18px;
      }

      .topbar {
        display: grid;
        grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.9fr);
        gap: 18px;
      }

      .hero,
      .side,
      .rail,
      .panel,
      .opportunity,
      .report {
        background: var(--panel);
        backdrop-filter: blur(14px);
        border: 1px solid var(--line);
        box-shadow: var(--shadow);
      }

      .hero {
        padding: 28px;
        border-radius: 26px;
        display: grid;
        gap: 18px;
      }

      .hero-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
      }

      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .pulse {
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 0 rgba(11, 139, 104, 0.45);
        animation: pulse 1.8s infinite;
      }

      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(11, 139, 104, 0.45); }
        70% { box-shadow: 0 0 0 12px rgba(11, 139, 104, 0); }
        100% { box-shadow: 0 0 0 0 rgba(11, 139, 104, 0); }
      }

      h1 {
        margin: 0;
        font-size: clamp(34px, 6vw, 64px);
        line-height: 0.96;
        letter-spacing: -0.05em;
      }

      .subhead {
        max-width: 720px;
        margin: 0;
        color: var(--muted);
        font-size: 15px;
        line-height: 1.65;
      }

      .status-strip {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.55);
        border: 1px solid var(--line);
        font-size: 13px;
        color: var(--ink);
      }

      .chip strong { font-weight: 650; }

      .side {
        padding: 24px;
        border-radius: 24px;
        display: grid;
        gap: 14px;
      }

      .section-label {
        margin: 0;
        font-size: 12px;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .link-list {
        display: grid;
        gap: 10px;
      }

      .link-list a {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        text-decoration: none;
        color: var(--ink);
        padding: 12px 0;
        border-top: 1px solid var(--line);
      }

      .link-list a:first-child { border-top: none; padding-top: 4px; }

      .metrics {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 14px;
      }

      .metric {
        padding: 18px 18px 20px;
        border-radius: 22px;
        position: relative;
        overflow: hidden;
      }

      .metric::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(135deg, rgba(255,255,255,0.38), transparent 65%);
        pointer-events: none;
      }

      .metric-value {
        font-size: clamp(28px, 4vw, 44px);
        line-height: 1;
        letter-spacing: -0.05em;
        margin: 12px 0 8px;
      }

      .metric-note {
        color: var(--muted);
        font-size: 13px;
      }

      .content {
        display: grid;
        grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.9fr);
        gap: 18px;
      }

      .rail,
      .panel,
      .report {
        border-radius: 24px;
      }

      .rail {
        padding: 22px;
        display: grid;
        gap: 18px;
      }

      .panel {
        padding: 22px;
        display: grid;
        gap: 16px;
      }

      .opportunity-list,
      .signal-list,
      .experiment-list {
        display: grid;
        gap: 12px;
      }

      .opportunity {
        padding: 18px 18px 16px;
        border-radius: 20px;
        transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
      }

      .opportunity:hover {
        transform: translateY(-2px);
        border-color: rgba(11, 139, 104, 0.28);
        background: var(--panel-strong);
      }

      .row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
      }

      .title {
        margin: 0;
        font-size: 18px;
        line-height: 1.25;
        letter-spacing: -0.02em;
      }

      .meta,
      .body,
      .mono,
      .empty {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.65;
      }

      .body {
        margin: 10px 0 0;
      }

      .tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .tag {
        border-radius: 999px;
        padding: 6px 10px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.5);
        font-size: 12px;
      }

      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 11px;
        border-radius: 999px;
        background: rgba(255,255,255,0.55);
        border: 1px solid var(--line);
        font-size: 12px;
        text-transform: capitalize;
      }

      .status.is-live,
      .status.is-accepted {
        background: var(--accent-soft);
        border-color: rgba(11, 139, 104, 0.2);
      }

      .status.is-running,
      .status.is-evaluating {
        background: rgba(173, 118, 12, 0.10);
        border-color: rgba(173, 118, 12, 0.16);
      }

      .status.is-stopped,
      .status.is-rejected {
        background: rgba(162, 65, 47, 0.10);
        border-color: rgba(162, 65, 47, 0.18);
      }

      .report {
        padding: 22px;
        display: grid;
        gap: 16px;
      }

      pre {
        margin: 0;
        padding: 18px;
        border-radius: 18px;
        background: rgba(25, 28, 22, 0.95);
        color: #f5f2ea;
        overflow: auto;
        font-size: 12px;
        line-height: 1.55;
        font-family: "SF Mono", "JetBrains Mono", monospace;
      }

      .footer-note {
        font-size: 12px;
        color: var(--muted);
      }

      @media (max-width: 1180px) {
        .topbar,
        .content {
          grid-template-columns: 1fr;
        }

        .metrics {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 720px) {
        body { padding: 14px; }
        .hero, .side, .rail, .panel, .report { border-radius: 20px; }
        .metrics { grid-template-columns: 1fr 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <section class="topbar">
        <div class="hero">
          <div class="hero-head">
            <div>
              <div class="eyebrow"><span class="pulse"></span> PM LOOP / LIVE CONTROL PLANE</div>
              <h1>自动 PM 功能面板</h1>
            </div>
            <div id="worker-status"></div>
          </div>
          <p class="subhead">
            这个面板直接读取 pm-loop 的本地状态、阶段报告和 worker 日志。它不承载宿主功能，
            只负责看清当前闭环跑到了哪里，哪些机会已接受，哪些实验还在执行，下一轮会怎么推进。
          </p>
          <div class="status-strip" id="status-strip"></div>
        </div>
        <aside class="side">
          <p class="section-label">Quick Access</p>
          <div class="link-list">
            <a href="/raw/report" target="_blank" rel="noreferrer"><span>打开最新报告</span><span class="mono">latest-report.md</span></a>
            <a href="/raw/state" target="_blank" rel="noreferrer"><span>查看原始状态</span><span class="mono">state.json</span></a>
            <a href="/raw/log" target="_blank" rel="noreferrer"><span>查看 worker 日志</span><span class="mono">worker.log</span></a>
          </div>
          <div class="footer-note" id="runtime-note"></div>
        </aside>
      </section>

      <section class="metrics" id="metrics"></section>

      <section class="content">
        <div class="rail">
          <div>
            <p class="section-label">Top Opportunities</p>
          </div>
          <div class="opportunity-list" id="opportunities"></div>
        </div>

        <div class="panel">
          <div>
            <p class="section-label">Running Loop</p>
          </div>
          <div class="experiment-list" id="experiments"></div>

          <div>
            <p class="section-label">Top Signals</p>
          </div>
          <div class="signal-list" id="signals"></div>
        </div>
      </section>

      <section class="report">
        <div class="row">
          <p class="section-label">Latest Report</p>
          <div class="meta" id="report-meta"></div>
        </div>
        <pre id="report"></pre>
      </section>

      <section class="report">
        <div class="row">
          <p class="section-label">Worker Log Tail</p>
          <div class="meta">auto refresh / 15s</div>
        </div>
        <pre id="worker-log"></pre>
      </section>
    </div>

    <script>
      const escapeHtml = (value) =>
        String(value ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");

      const formatTime = (value) => {
        if (!value) return "unknown";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return new Intl.DateTimeFormat("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit"
        }).format(date);
      };

      const stageSummary = (stages) =>
        Object.entries(stages || {})
          .map(([key, value]) => \`\${escapeHtml(key)}=\${escapeHtml(value)}\`)
          .join(" / ");

      const statusClass = (status) => {
        if (status === "accepted" || status === "live") return "status is-accepted";
        if (status === "running" || status === "evaluating") return "status is-running";
        if (status === "stopped" || status === "rejected") return "status is-stopped";
        return "status";
      };

      const renderMetrics = (overview) => {
        const metrics = [
          ["Signals", overview.counts.signals, stageSummary(overview.stages.opportunities)],
          ["Opportunities", overview.counts.opportunities, "机会池总量"],
          ["Experiments", overview.counts.experiments, stageSummary(overview.stages.experiments)],
          ["Decisions", overview.counts.decisions, "已形成结果判断"],
          ["Events", overview.counts.events, "最近累计事件"]
        ];

        document.getElementById("metrics").innerHTML = metrics
          .map(([label, value, note]) => \`
            <article class="panel metric">
              <p class="section-label">\${escapeHtml(label)}</p>
              <div class="metric-value">\${escapeHtml(value)}</div>
              <div class="metric-note">\${escapeHtml(note)}</div>
            </article>
          \`)
          .join("");
      };

      const renderOpportunities = (overview) => {
        const html = (overview.opportunities || [])
          .map((opportunity) => {
            const refs = opportunity.spec?.references || [];
            const experiments = opportunity.experiments || [];
            return \`
              <article class="opportunity">
                <div class="row">
                  <h3 class="title">\${escapeHtml(opportunity.title)}</h3>
                  <span class="\${statusClass(opportunity.status)}">\${escapeHtml(opportunity.status)}</span>
                </div>
                <div class="meta">priority \${escapeHtml((opportunity.priorityScore || 0).toFixed(2))} / impacted \${escapeHtml(opportunity.impactedUsers || 0)} / session \${escapeHtml(opportunity.primarySessionId || "-")}</div>
                <p class="body">\${escapeHtml(opportunity.problem)}</p>
                \${opportunity.spec ? \`<p class="body"><strong>Desired:</strong> \${escapeHtml(opportunity.spec.desiredBehavior)}</p>\` : ""}
                <div class="tag-row">
                  \${refs.map((ref) => \`<span class="tag">\${escapeHtml(ref)}</span>\`).join("")}
                  \${experiments.map((experiment) => \`<span class="tag">\${escapeHtml(experiment.mode)} · \${escapeHtml(experiment.status)}</span>\`).join("")}
                </div>
              </article>
            \`;
          })
          .join("");

        document.getElementById("opportunities").innerHTML = html || '<div class="empty">当前还没有机会对象。</div>';
      };

      const renderExperiments = (overview) => {
        const active = overview.activeExperiments || [];
        document.getElementById("experiments").innerHTML = active.length
          ? active
              .map(
                (experiment) => \`
                  <article class="opportunity">
                    <div class="row">
                      <h3 class="title">\${escapeHtml(experiment.id)}</h3>
                      <span class="\${statusClass(experiment.status)}">\${escapeHtml(experiment.status)}</span>
                    </div>
                    <div class="meta">\${escapeHtml(experiment.mode)} / \${escapeHtml(experiment.owner)}</div>
                    <p class="body">\${escapeHtml(experiment.summary || "experiment in progress")}</p>
                  </article>
                \`
              )
              .join("")
          : '<div class="empty">当前没有运行中的实验。</div>';
      };

      const renderSignals = (overview) => {
        const signals = overview.recentSignals || [];
        document.getElementById("signals").innerHTML = signals.length
          ? signals
              .map(
                (signal) => \`
                  <article class="opportunity">
                    <div class="row">
                      <h3 class="title">\${escapeHtml(signal.signalType)}</h3>
                      <span class="status">\${escapeHtml(signal.status)}</span>
                    </div>
                    <div class="meta">\${escapeHtml(signal.subject || "-")} / impacted \${escapeHtml(signal.impactedUsers || 0)}</div>
                  </article>
                \`
              )
              .join("")
          : '<div class="empty">当前没有信号。</div>';
      };

      const renderHeader = (overview) => {
        const alive = overview.worker.alive;
        document.getElementById("worker-status").innerHTML = \`
          <span class="\${alive ? "status is-live" : "status is-stopped"}">
            \${alive ? "worker live" : "worker stopped"} / pid \${escapeHtml(overview.worker.pid || "-")}
          </span>
        \`;

        document.getElementById("status-strip").innerHTML = [
          \`<span class="chip"><strong>state</strong> \${escapeHtml(formatTime(overview.freshness.stateUpdatedAt))}</span>\`,
          \`<span class="chip"><strong>report</strong> \${escapeHtml(formatTime(overview.freshness.reportUpdatedAt))}</span>\`,
          \`<span class="chip"><strong>host</strong> MelodySync runtime</span>\`,
          \`<span class="chip"><strong>mode</strong> dual-source planning</span>\`
        ].join("");

        document.getElementById("runtime-note").textContent =
          \`root: \${overview.rootDir} | updated: \${formatTime(overview.generatedAt)}\`;

        document.getElementById("report-meta").textContent =
          \`state: \${formatTime(overview.freshness.stateUpdatedAt)} / report: \${formatTime(overview.freshness.reportUpdatedAt)}\`;
      };

      const renderArtifacts = (overview) => {
        document.getElementById("report").textContent = overview.report || "No report yet.";
        document.getElementById("worker-log").textContent = overview.workerLog || "No worker log yet.";
      };

      const refresh = async () => {
        const response = await fetch("/api/overview", { cache: "no-store" });
        const overview = await response.json();
        renderHeader(overview);
        renderMetrics(overview);
        renderOpportunities(overview);
        renderExperiments(overview);
        renderSignals(overview);
        renderArtifacts(overview);
      };

      refresh();
      setInterval(refresh, 15000);
    </script>
  </body>
</html>
`;

const sendJson = (body: unknown) => ({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: json(body)
});

const sendText = (body: string, contentType = "text/plain; charset=utf-8") => ({
  status: 200,
  headers: { "content-type": contentType },
  body
});

const sendNotFound = () => ({
  status: 404,
  headers: { "content-type": "text/plain; charset=utf-8" },
  body: "Not found"
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${dashboardHost}:${dashboardPort}`);

  try {
    if (url.pathname === "/") {
      const response = sendText(dashboardHtml, "text/html; charset=utf-8");
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/api/overview") {
      const response = sendJson(await buildOverview());
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/raw/report") {
      const response = sendText(await readText(reportPath), "text/markdown; charset=utf-8");
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/raw/state") {
      const response = sendText(await readText(statePath), "application/json; charset=utf-8");
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    if (url.pathname === "/raw/log") {
      const response = sendText(await readText(workerLogPath));
      res.writeHead(response.status, response.headers);
      res.end(response.body);
      return;
    }

    const response = sendNotFound();
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(json({ error: message }));
  }
});

server.listen(dashboardPort, dashboardHost, () => {
  console.log(
    JSON.stringify(
      {
        app: "pm-loop-dashboard",
        host: dashboardHost,
        port: dashboardPort,
        url: `http://${dashboardHost}:${dashboardPort}`
      },
      null,
      2
    )
  );
});
