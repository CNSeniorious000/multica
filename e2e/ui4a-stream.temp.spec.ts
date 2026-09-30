import "./env";

import { expect, test } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";
import type { TestApiClient } from "./fixtures";

// Streaming demo (MAC-19026): prove that the ui4a/tsx block in Multica's live
// view renders PARTIAL FRAMES — the widget grows as the fence streams, it does
// not wait for the closing ```. Reached from RichFenceBlock for an OPEN fence
// too, the leaf feeds each frame to partial-react's `pushCode`, which compiles
// the partial body through partial-tsx's streaming completer; `finish` runs the
// final full compile once the fence closes. `preserveStateOnUpdate` keeps the
// last good frame so a transiently unparseable token never blanks the panel.
//
// The fixture below is written to be STREAMING-FRIENDLY: its JSX emits in stages
// (header → one KPI card at a time → chart), and every intermediate prefix the
// completer trims to is itself a valid renderable component. So the canvas grows
// through MULTIPLE visible intermediate states (skeleton → cards → chart) instead
// of jumping from source to finished widget in one step. The effect+echarts.init
// component (`SceneChart`) is defined BEFORE the default export and only enters
// the render tree in the final stage, so no partial frame ever mounts it against
// a null ref mid-stream (partial-tsx's returnless-effect rollback guarantees it).
//
// This is a genuine stream, not a static fixture: content grows through the
// real production path — the daemon report endpoint persists each frame AND
// broadcasts the `task:message` WebSocket event workspace-wide, which merges
// into the shared ["task-messages", taskId] cache and re-renders RichContent.
// The only substitution vs. a real agent run is who calls the report endpoint.

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://multica:multica@localhost:5432/multica?sslmode=disable";

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;

// The ui4a/tsx GenUI block: an echarts dashboard imported by bare specifier so
// partial-react's esm.sh fallback resolves it (no local dependency).
//
// STREAMING-FRIENDLY BY CONSTRUCTION. The default component's returned JSX is a
// flex column that accumulates visible top-level children — header, then four
// <Kpi/> cards emitted ONE PER SOURCE LINE, then the <SceneChart/>. partial-tsx's
// streaming completer trims each incomplete prefix back to the last complete
// child, so every source line that finishes a child yields a NEW renderable
// frame, and pushCode mounts a new visible canvas state each time (verified: 7
// distinct states — empty → header → +1 card → +2 → +3 → +4 → +chart). The two
// effect-bearing helpers (`Kpi` is pure; `SceneChart` runs echarts.init) are both
// defined in full BEFORE the default export, and `<SceneChart/>` is the LAST child
// to stream in, so no partial frame ever puts the echarts component in the render
// tree before its own definition (and ref) exist — no mid-stream init(null) crash.
// Cards are written as literal siblings, not a .map(), on purpose: a .map() would
// complete atomically and collapse the four card stages into a single frame.
const CHART_FENCE = [
  "```ui4a/tsx",
  'import { useEffect, useRef } from "react";',
  'import * as echarts from "echarts";',
  "",
  "const SCENES = [",
  '  { label: "Data & analytics", share: 34.2 },',
  '  { label: "Coding help", share: 27.8 },',
  '  { label: "Writing", share: 14.1 },',
  '  { label: "Learning", share: 9.6 },',
  '  { label: "Planning", share: 7.7 },',
  '  { label: "Other / low-signal", share: 6.6 },',
  "];",
  "",
  "function Kpi({ label, value, delta }: { label: string; value: string; delta: string }) {",
  "  return (",
  "    <div",
  "      style={{",
  '        flex: "1 1 0",',
  "        minWidth: 132,",
  '        padding: "14px 16px",',
  "        borderRadius: 12,",
  '        background: "#f5f5fb",',
  '        border: "1px solid #e6e6f2",',
  "      }}",
  "    >",
  '      <div style={{ fontSize: 12, color: "#6b7280" }}>{label}</div>',
  '      <div style={{ fontSize: 24, fontWeight: 700, color: "#1f2937" }}>{value}</div>',
  '      <div style={{ fontSize: 12, color: "#8b5cf6" }}>{delta}</div>',
  "    </div>",
  "  );",
  "}",
  "",
  "function SceneChart() {",
  "  const ref = useRef<HTMLDivElement>(null);",
  "  useEffect(() => {",
  "    if (!ref.current) return;",
  "    const chart = echarts.init(ref.current);",
  "    chart.setOption({",
  '      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },',
  "      grid: { left: 140, right: 32, top: 16, bottom: 24 },",
  '      xAxis: { type: "value", max: 40, axisLabel: { formatter: "{value}%" } },',
  '      yAxis: { type: "category", data: SCENES.map((s) => s.label) },',
  "      series: [",
  "        {",
  '          name: "Share of turns",',
  '          type: "bar",',
  "          data: SCENES.map((s) => s.share),",
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
  '  return <div data-testid="ui4a-e2e-marker" ref={ref} style={{ width: "100%", height: 320 }} />;',
  "}",
  "",
  "export default function UsageDashboard() {",
  "  return (",
  '    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 4 }}>',
  "      <div>",
  '        <div style={{ fontSize: 16, fontWeight: 700, color: "#111827" }}>',
  "          How People Use Macaron",
  "        </div>",
  '        <div style={{ fontSize: 12, color: "#6b7280" }}>',
  "          Scene share of 12,694 sampled turns (fixture)",
  "        </div>",
  "      </div>",
  '      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>',
  '        <Kpi label="Data & analytics" value="34.2%" delta="▲ 2.1pp" />',
  '        <Kpi label="Coding help" value="27.8%" delta="▼ 0.6pp" />',
  '        <Kpi label="Writing" value="14.1%" delta="▲ 0.4pp" />',
  '        <Kpi label="Learning" value="9.6%" delta="▲ 0.9pp" />',
  "      </div>",
  "      <SceneChart />",
  "    </div>",
  "  );",
  "}",
  "```",
].join("\n");

// The natural-language analysis that precedes the chart. Block LaTeX only
// (RichContent sets singleDollarTextMath:false, so inline `$...$` would not
// render); a Markdown table; a fixture-data callout so nothing is disguised as
// a live query.
const REPLY_PREFACE = [
  "下面是上周 **How People Use Macaron** 使用画像的分析。",
  "",
  "> ⚠️ **Fixture 数据**：以下数字来自固定的示例快照（改编自内部 codesign 用量报告），**不是实时数仓查询**，仅用于演示 GenUI 流式渲染。",
  "",
  "## 采样口径",
  "",
  "本期从 16,052 名活跃 chat 用户中抽样 2,000 人，展开为 12,694 个 turn 做场景分类。抽样比例：",
  "",
  "$$",
  "r_{\\text{sample}} = \\frac{2{,}000}{16{,}052} \\approx 12.46\\%",
  "$$",
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
].join("\n");

const REPLY_TAIL = [
  "",
  "## 留存",
  "",
  "抽样用户的次日留存率 D1：",
  "",
  "$$",
  "\\text{Retention}_{D_1} = \\frac{5{,}891}{8{,}903} \\approx 66.2\\%",
  "$$",
  "",
  "**结论**：数据分析是第一大使用场景，建议优先打磨取数 → 图表这条链路。",
].join("\n");

const USER_QUESTION =
  "帮我看下上周 Macaron 的使用情况：用户主要在用它做什么？取数分析一下各场景占比。";

// Split the full reply into the deltas an agent would emit while streaming.
// Adjacent `text` task messages coalesce by concatenation in buildTimeline, so
// each frame carries only the NEW text; the on-screen prose is their running
// sum. The chart fence is emitted line-by-line: as each source line completes a
// JSX child (header, then a card, then the chart), the leaf compiles that
// partial frame and the canvas grows a stage. The final frame carries the
// closing ``` that flips the fence closed and runs the full compile.
function buildStreamFrames(): string[] {
  const frames: string[] = [];

  // 1) Prose + LaTeX + table, in a few human-sized chunks.
  const prefaceLines = REPLY_PREFACE.split("\n");
  const prefaceChunks = [
    prefaceLines.slice(0, 4).join("\n") + "\n",
    prefaceLines.slice(4, 12).join("\n") + "\n",
    prefaceLines.slice(12).join("\n") + "\n",
  ];
  frames.push(...prefaceChunks);

  // 2) The ui4a/tsx fence, one source line per frame. Each frame leaves the
  //    fence OPEN; the leaf feeds the growing body to pushCode, so the canvas
  //    grows a stage every time a line completes a JSX child.
  const fenceLines = CHART_FENCE.split("\n");
  const closingFenceIndex = fenceLines.length - 1; // the final ``` line
  for (let i = 0; i < closingFenceIndex; i++) {
    frames.push(fenceLines[i] + "\n");
  }

  // 3) The closing fence as its own frame — this closes the fence and lets
  //    Ui4aFenceBlock run finish() for the final full compile.
  frames.push(fenceLines[closingFenceIndex] + "\n");

  // 4) The tail analysis after the chart.
  frames.push(REPLY_TAIL);

  return frames;
}

const STREAM_FRAMES = buildStreamFrames();
// The full reply is the concatenation of every frame — used to verify the final
// settled state matches what a non-streaming render would show.
const FULL_REPLY = STREAM_FRAMES.join("");

test("ui4a/tsx block streams in the chat live view: the canvas grows through partial frames (header → cards → chart), not a block jump", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const api: TestApiClient = await createTestApi();
  const db = new pg.Client(DATABASE_URL);
  await db.connect();

  let agentId: string | null = null;
  let runtimeId: string | null = null;
  let sessionId: string | null = null;
  let taskId: string | null = null;
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));

  // Push one streaming frame through the REAL production path: the daemon
  // report endpoint persists the row and broadcasts the `task:message` event,
  // which useRealtimeSync merges into the ["task-messages", taskId] cache. The
  // test user's JWT authenticates (DaemonAuth falls back to JWT for workspace
  // members), so no daemon token is needed.
  const reportFrame = async (seq: number, content: string) => {
    const res = await fetch(`${API_BASE}/api/daemon/tasks/${taskId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${api.getToken()}`,
      },
      body: JSON.stringify({ messages: [{ seq, type: "text", content }] }),
    });
    if (!res.ok) {
      throw new Error(`report frame seq=${seq} failed: ${res.status} ${await res.text()}`);
    }
  };

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

    // --- Agent runtime + agent ---
    const runtimeResult = await db.query<{ id: string }>(
      `INSERT INTO agent_runtime (
         workspace_id, daemon_id, name, runtime_mode, provider, status,
         device_info, metadata, owner_id, last_seen_at
       )
       VALUES ($1, NULL, $2, 'cloud', 'e2e_ui4a_stream', 'online', 'UI4A stream E2E', '{}'::jsonb, $3, now())
       RETURNING id::text`,
      [workspace.id, `UI4A Stream Runtime ${Date.now()}`, userId],
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

    // --- Chat session + the user's question ---
    const sessionResult = await db.query<{ id: string }>(
      `INSERT INTO chat_session (workspace_id, agent_id, creator_id, title, status)
       VALUES ($1, $2, $3, 'Weekly Macaron usage breakdown (stream)', 'active')
       RETURNING id::text`,
      [workspace.id, agentId, userId],
    );
    sessionId = sessionResult.rows[0]!.id;

    await db.query(
      `INSERT INTO chat_message (chat_session_id, role, content, created_at)
       VALUES ($1, 'user', $2, now())`,
      [sessionId, USER_QUESTION],
    );

    // --- A RUNNING chat task: this is what makes the chat live row appear and
    //     mount the task-messages observer, so broadcast frames pass the gate. ---
    const taskResult = await db.query<{ id: string }>(
      `INSERT INTO agent_task_queue (agent_id, runtime_id, chat_session_id, status, started_at)
       VALUES ($1, $2, $3, 'running', now())
       RETURNING id::text`,
      [agentId, runtimeId, sessionId],
    );
    taskId = taskResult.rows[0]!.id;

    // --- Authenticate the browser and open the chat session ---
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
    await page.setViewportSize({ width: 1440, height: 1400 });

    await page.goto(`/${workspace.slug}/chat?session=${sessionId}`, {
      waitUntil: "domcontentloaded",
    });

    // The user's question renders immediately; wait for it so we know the live
    // timeline (and its task-messages observer) is mounted before we stream.
    await expect(page.getByText(USER_QUESTION, { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    });
    // Let the WebSocket subscribe and the pending-task query settle so the very
    // first frame is not raced against the socket handshake.
    await page.waitForTimeout(1500);

    // === Stream the reply frame by frame through the real task:message path ===
    let seq = 1;

    // Landmark frames inside the OPEN fence. STREAM_FRAMES is [3 preface frames]
    // then one frame per fence source line, so frame `prefaceFrames + n` has just
    // emitted fenceLines[n]. We pause the stream at two landmarks and assert the
    // canvas has grown to exactly that stage — proving PARTIAL frames render (the
    // widget mounts and grows while the fence is still open), not a block jump.
    const prefaceFrames = 3;
    const fenceLines = CHART_FENCE.split("\n");
    const headerCheckpoint =
      prefaceFrames + fenceLines.findIndex((l) => l.includes("How People Use Macaron"));
    const cardsCheckpoint =
      prefaceFrames + fenceLines.findIndex((l) => l.includes('label="Learning"'));

    const block = page.locator(".ui4a-block").first();

    for (let i = 0; i < STREAM_FRAMES.length; i++) {
      await reportFrame(seq++, STREAM_FRAMES[i]!);
      // Pace the frames so the recording reads as a real stream (and so the
      // 100ms realtime batch window flushes between visible steps). The loop
      // posts NO further frame while a checkpoint block runs, so the streamed
      // body is pinned to exactly this stage while we assert on it.
      await page.waitForTimeout(220);

      if (i === headerCheckpoint) {
        // Stage 1 — header only. The fence is OPEN, yet the leaf has already
        // compiled a partial frame and mounted the component: the header text is
        // live DOM inside `.ui4a-block` (scoped so it can't match the preface's
        // bold "How People Use Macaron"). No KPI card and no chart canvas yet.
        await expect(block).toBeVisible({ timeout: 30_000 });
        await expect(
          block.getByText("How People Use Macaron"),
        ).toBeVisible({ timeout: 20_000 });
        await expect(block.locator("canvas")).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath("ui4a-stream-stage-header.png"),
          fullPage: true,
        });
      }

      if (i === cardsCheckpoint) {
        // Stage 2 — all four KPI cards have grown in, one per frame since the
        // header. Their values are live DOM inside the block (scoped so they
        // can't match the preface table). Still OPEN, still no chart canvas: the
        // chart is the last child and has not streamed yet.
        await expect(block.getByText("34.2%")).toBeVisible({ timeout: 20_000 });
        await expect(block.getByText("27.8%")).toBeVisible({ timeout: 10_000 });
        await expect(block.getByText("14.1%")).toBeVisible({ timeout: 10_000 });
        await expect(block.getByText("9.6%")).toBeVisible({ timeout: 10_000 });
        await expect(block.locator("canvas")).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath("ui4a-stream-stage-cards.png"),
          fullPage: true,
        });
      }
    }

    // === Fence is now closed: `finish` runs the final full compile ===
    // Stage 3 — the chart canvas mounts as the last child, below the header and
    // the four cards that streamed in earlier. This is the frame that was missing
    // before: the widget reaches its final state by GROWING, not by a block jump.
    await expect(block).toBeVisible({ timeout: 60_000 });
    await expect(
      block.getByTestId("ui4a-e2e-marker").locator("canvas"),
    ).toBeVisible({ timeout: 30_000 });
    // The earlier stages remain composed alongside the chart in the closed frame.
    await expect(block.getByText("How People Use Macaron")).toBeVisible({ timeout: 10_000 });
    await expect(block.getByText("34.2%")).toBeVisible({ timeout: 10_000 });
    // The rest of the mixed reply is intact alongside the chart.
    await expect(page.locator(".katex").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("table").first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({
      path: testInfo.outputPath("ui4a-stream-stage-chart.png"),
      fullPage: true,
    });

    // The streamed content equals the full reply (nothing lost across frames).
    expect(FULL_REPLY).toContain("UsageDashboard");
    expect(browserErrors, `browser page errors: ${browserErrors.join("; ")}`).toEqual([]);
  } finally {
    if (taskId) await db.query(`DELETE FROM task_message WHERE task_id = $1`, [taskId]);
    if (taskId) await db.query(`DELETE FROM agent_task_queue WHERE id = $1`, [taskId]);
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

