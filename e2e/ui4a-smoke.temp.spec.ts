import "./env";

import { expect, test } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

// The ui4a/tsx GenUI block: an echarts chart imported by bare specifier so
// partial-react's esm.sh fallback resolves it (no local dependency added). It
// visualizes the fixture "How People Use Macaron" scene distribution. The
// data-testid marks the mounted widget; the ui4a leaf carries class `.ui4a-block`.
const CHART_FENCE = [
  "```ui4a/tsx",
  'import { useEffect, useRef } from "react";',
  'import * as echarts from "echarts";',
  "",
  "export default function SceneDistribution() {",
  "  const ref = useRef<HTMLDivElement>(null);",
  "  useEffect(() => {",
  "    if (!ref.current) return;",
  "    const chart = echarts.init(ref.current);",
  "    chart.setOption({",
  '      title: { text: "How People Use Macaron", subtext: "Scene share of 12,694 sampled turns (fixture)" },',
  '      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },',
  '      grid: { left: 140, right: 32, top: 64, bottom: 32 },',
  '      xAxis: { type: "value", max: 40, axisLabel: { formatter: "{value}%" } },',
  "      yAxis: {",
  '        type: "category",',
  '        data: ["Data & analytics", "Coding help", "Writing", "Learning", "Planning", "Other / low-signal"],',
  "      },",
  "      series: [",
  "        {",
  '          name: "Share of turns",',
  '          type: "bar",',
  "          data: [34.2, 27.8, 14.1, 9.6, 7.7, 6.6],",
  '          label: { show: true, position: "right", formatter: "{c}%" },',
  "          itemStyle: {",
  "            borderRadius: [0, 6, 6, 0],",
  "            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [",
  '              { offset: 0, color: "#6366f1" },',
  '              { offset: 1, color: "#a5b4fc" },',
  "            ]),",
  "          },",
  "        },",
  "      ],",
  "    });",
  "    const onResize = () => chart.resize();",
  '    window.addEventListener("resize", onResize);',
  "    return () => {",
  '      window.removeEventListener("resize", onResize);',
  "      chart.dispose();",
  "    };",
  "  }, []);",
  '  return <div data-testid="ui4a-e2e-marker" ref={ref} style={{ width: "100%", height: 360 }} />;',
  "}",
  "```",
].join("\n");

// A realistic data-analysis exchange: the user asks for a usage breakdown, and
// the assistant answers with natural-language analysis interleaving Markdown, a
// LaTeX formula (block math — RichContent sets singleDollarTextMath:false, so
// only `$$...$$` renders), a table, and the ui4a/tsx echarts chart. Numbers are
// adapted from the internal "How People Use Macaron" report and are explicitly
// labelled as fixture data, not a live query.
const USER_QUESTION =
  "帮我看下上周 Macaron 的使用情况：用户主要在用它做什么？取数分析一下各场景占比。";

const ASSISTANT_REPLY = [
  "下面是上周 **How People Use Macaron** 使用画像的分析。",
  "",
  "> ⚠️ **Fixture 数据**：以下数字来自固定的示例快照（改编自内部 codesign 用量报告），**不是实时数仓查询**，仅用于演示 GenUI 渲染。",
  "",
  "## 采样口径",
  "",
  "本期从 16,052 名活跃 chat 用户中抽样 2,000 人，展开为 12,694 个 turn 做场景分类。抽样比例：",
  "",
  "$$",
  "r_{\\text{sample}} = \\frac{2{,}000}{16{,}052} \\approx 12.46\\%",
  "$$",
  "",
  "因为是抽样，下面的占比是**样本分布**，不能直接当作全量精确值。",
  "",
  "## 各场景占比",
  "",
  "| 场景 | 样本 turn 占比 | 环比 |",
  "| --- | ---: | ---: |",
  "| Data & analytics | 34.2% | ▲ 2.1pp |",
  "| Coding help | 27.8% | ▼ 0.6pp |",
  "| Writing | 14.1% | ▲ 0.4pp |",
  "| Learning | 9.6% | ▲ 0.9pp |",
  "| Planning | 7.7% | ▼ 0.3pp |",
  "| Other / low-signal | 6.6% | — |",
  "",
  "取数与分析类需求继续领先，占样本 turn 的三分之一以上。可视化如下：",
  "",
  CHART_FENCE,
  "",
  "## 留存",
  "",
  "抽样用户的次日留存率 D1：",
  "",
  "$$",
  "\\text{Retention}_{D_1} = \\frac{5{,}891}{8{,}903} \\approx 66.2\\%",
  "$$",
  "",
  "**结论**：数据分析是第一大使用场景，建议优先打磨取数 → 图表这条链路；Coding help 环比略降，需要结合失败归因再看。",
].join("\n");

test("ui4a/tsx data-analysis reply renders in chat, issue comment, and agent transcript", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const api: TestApiClient = await createTestApi();
  const db = new pg.Client(DATABASE_URL);
  await db.connect();

  let issueId: string | null = null;
  let agentId: string | null = null;
  let runtimeId: string | null = null;
  let sessionId: string | null = null;
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  try {
    const workspace = (await api.getWorkspaces())[0];
    if (!workspace) throw new Error("E2E workspace missing");
    api.setWorkspaceId(workspace.id);
    api.setWorkspaceSlug(workspace.slug);

    const userResult = await db.query<{ id: string }>(
      `SELECT id::text FROM "user" WHERE email = $1 LIMIT 1`,
      [api.getEmail()],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) throw new Error("E2E user missing");

    // --- Agent runtime + agent (shared by transcript + chat surfaces) ---
    const runtimeResult = await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (
         workspace_id, daemon_id, name, runtime_mode, provider, status,
         device_info, metadata, owner_id, last_seen_at
       )
       VALUES ($1, NULL, $2, 'cloud', 'e2e_ui4a_smoke', 'online', 'UI4A smoke E2E', '{}'::jsonb, $3, now())
       RETURNING id::text`,
      [workspace.id, `UI4A Smoke Runtime ${Date.now()}`, userId],
    );
    runtimeId = runtimeResult.rows[0]!.id;

    const agentResult = await db.query<{ id: string }>(
      `INSERT INTO agent (
         workspace_id, name, description, instructions, runtime_mode,
         runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id
       )
       VALUES ($1, $2, 'Analyzes product usage data', '', 'cloud',
               '{}'::jsonb, $3, 'workspace', 'private', 1, $4)
       RETURNING id::text`,
      [workspace.id, `Usage Analyst ${Date.now()}`, runtimeId, userId],
    );
    agentId = agentResult.rows[0]!.id;

    // --- Issue + comment carrying the full assistant reply (ReadonlyContent) ---
    const issue = await api.createIssue(`Weekly Macaron usage breakdown ${Date.now()}`, {
      description: "Fixture coverage for a mixed Markdown + LaTeX + ui4a/tsx reply.",
    });
    issueId = issue.id as string;

    await db.query(
      `INSERT INTO comment (workspace_id, issue_id, author_type, author_id, content)
       VALUES ($1, $2, 'agent', $3, $4)`,
      [workspace.id, issueId, agentId, ASSISTANT_REPLY],
    );

    // --- Completed agent task + transcript prose row carrying the reply ---
    const taskResult = await db.query<{ id: string }>(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, started_at, completed_at)
       VALUES ($1, $2, $3, 'completed', now() - interval '1 minute', now())
       RETURNING id::text`,
      [agentId, runtimeId, issueId],
    );
    const taskId = taskResult.rows[0]!.id;

    await db.query(
      `INSERT INTO task_message (task_id, seq, type, content)
       VALUES ($1, 1, 'text', $2)`,
      [taskId, ASSISTANT_REPLY],
    );

    // --- Chat session + user question and assistant reply ---
    const sessionResult = await db.query<{ id: string }>(
      `INSERT INTO chat_session (workspace_id, agent_id, creator_id, title, status)
       VALUES ($1, $2, $3, 'Weekly Macaron usage breakdown', 'active')
       RETURNING id::text`,
      [workspace.id, agentId, userId],
    );
    sessionId = sessionResult.rows[0]!.id;

    await db.query(
      `INSERT INTO chat_message (chat_session_id, role, content, created_at)
       VALUES
         ($1, 'user', $2, now() - interval '1 second'),
         ($1, 'assistant', $3, now())`,
      [sessionId, USER_QUESTION, ASSISTANT_REPLY],
    );

    const token = api.getToken();
    if (!token) throw new Error("E2E token missing");
    await page.addInitScript(
      ({ authToken, activeSessionId }) => {
        localStorage.setItem("multica_token", authToken);
        localStorage.setItem("multica:chat:activeSessionId", activeSessionId);
        localStorage.setItem("multica:chat:isOpen", "false");
      },
      { authToken: token, activeSessionId: sessionId },
    );
    await page.setViewportSize({ width: 1440, height: 1600 });

    // Assert the mixed reply renders: the chart canvas, a KaTeX formula, and the
    // Markdown table are all present in the same message.
    const expectReplyRendered = async (scope = page.locator("body")) => {
      const block = scope.locator(".ui4a-block").first();
      await expect(block).toBeVisible({ timeout: 60_000 });
      await expect(
        block.getByTestId("ui4a-e2e-marker").locator("canvas"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(scope.locator(".katex").first()).toBeVisible({ timeout: 15_000 });
      await expect(scope.locator("table").first()).toBeVisible({ timeout: 15_000 });
    };

    // === Chat surface ===
    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, {
      waitUntil: "domcontentloaded",
    });
    await expectReplyRendered();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: testInfo.outputPath("ui4a-chat.png"),
      fullPage: true,
    });

    // === Issue comment surface (ReadonlyContent) ===
    await page.goto(`/${workspace.slug}/issues/${issueId}`, {
      waitUntil: "domcontentloaded",
    });
    await expectReplyRendered();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: testInfo.outputPath("ui4a-issue.png"),
      fullPage: true,
    });

    // === Agent transcript surface (ProseRow) ===
    // The completed run collapses under "Show past runs (N)" in the execution
    // log; expand it, then open its transcript dialog.
    const showPast = page
      .getByRole("button", { name: /show past runs/i })
      .first();
    await expect(showPast).toBeVisible({ timeout: 30_000 });
    await showPast.scrollIntoViewIfNeeded();
    await showPast.click();
    // The row's actions (incl. the transcript button) are hover-gated, so hover
    // the past-run row before clicking; the freshly rendered button can detach
    // on pointer movement, so force the click past the stability re-check.
    const pastRow = page.locator(".group\\/execution-log-row").last();
    await expect(pastRow).toBeVisible({ timeout: 15_000 });
    await pastRow.scrollIntoViewIfNeeded();
    await pastRow.hover();
    const transcriptButton = page
      .getByRole("button", { name: /view transcript/i })
      .first();
    await expect(transcriptButton).toBeVisible({ timeout: 15_000 });
    await transcriptButton.hover();
    await transcriptButton.click({ force: true });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expectReplyRendered(dialog);
    await page.waitForTimeout(600);
    await page.screenshot({
      path: testInfo.outputPath("ui4a-agent-transcript.png"),
      fullPage: true,
    });

    expect(browserErrors, `browser page errors: ${browserErrors.join("; ")}`).toEqual([]);
  } finally {
    if (sessionId) {
      await db.query(`DELETE FROM chat_message WHERE chat_session_id = $1`, [sessionId]);
      await db.query(`DELETE FROM chat_session WHERE id = $1`, [sessionId]);
    }
    await api.cleanup();
    if (agentId) await db.query(`DELETE FROM agent WHERE id = $1`, [agentId]);
    if (runtimeId) await db.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    await db.end();
  }
});
