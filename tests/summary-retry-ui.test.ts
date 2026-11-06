import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const dashboardUrl = new URL("../src/dashboard.ts", import.meta.url).href;
const workerUrl = new URL("../src/worker.ts", import.meta.url).href;
const coreUrl = import.meta.resolve("@opentui/core");
const testingUrl = import.meta.resolve("@opentui/core/testing");

test.each([
  ["failed", "key", true],
  ["interrupted", "mouse", true],
  ["moved-interrupted", "key", true],
  ["completed", "key", false],
  ["analyzing", "key", false],
  ["missing-raw", "key", false],
] as const)("過去の%s記録の詳細で再要約の可否と%s操作を確認する", async (phase, action, retryable) => {
  const root = await mkdtemp("/private/tmp/voice-note-retry-ui-");
  try {
    const outputRoot = join(root, "sessions");
    const older = join(outputRoot, "20261001-120000-12345678");
    const latest = join(outputRoot, "20261021-120000-12345678");
    await mkdir(older, { recursive: true, mode: 0o700 });
    await mkdir(latest, { recursive: true, mode: 0o700 });
    if (phase !== "missing-raw") await writeFile(join(older, "raw.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Mic>架空の原文\n");
    await writeFile(join(older, "title.txt"), "過去の架空の記録");
    await writeFile(join(latest, "raw.vtt"), "WEBVTT\n");
    if (phase === "moved-interrupted") {
      const original = join(root, "移動前の記録");
      await writeFile(join(older, ".voice-note-state.json"), JSON.stringify({
        phase: "analyzing", session_dir: original, raw_path: join(original, "raw.vtt"),
      }));
    }
    const runner = join(root, "runner.ts");
    const resultPath = join(root, "result.json");
    await writeFile(runner, `import { mock } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
const core = await import(${JSON.stringify(coreUrl)});
const { createTestRenderer } = await import(${JSON.stringify(testingUrl)});
const setup = await createTestRenderer({ width: 160, height: 45 });
mock.module(${JSON.stringify(coreUrl)}, () => ({ ...core, createCliRenderer: async () => setup.renderer }));
const older = ${JSON.stringify(older)};
const latest = ${JSON.stringify(latest)};
const calls: string[] = [];
let selectedPhase = ${JSON.stringify(phase === "missing-raw" ? "failed" : phase)};
const retryable = ${retryable};
const { getPublicStatus: getActualPublicStatus } = await import(${JSON.stringify(workerUrl)});
mock.module(${JSON.stringify(workerUrl)}, () => ({
  getPublicStatus: async (session?: string) => session === older && selectedPhase === "moved-interrupted"
    ? getActualPublicStatus(older)
    : session === older ? {
    phase: selectedPhase, session_dir: older, session_id: "20261001-120000-12345678",
    raw_path: ${phase === "missing-raw" ? "undefined" : "join(older, 'raw.vtt')"},
    error: selectedPhase === "failed" ? "架空の要約エラー" : undefined,
  } : { phase: "completed", session_dir: latest, session_id: "20261021-120000-12345678" },
  retryCapture: async (session?: string) => {
    calls.push(session ?? "latest");
    selectedPhase = "analyzing";
    return "原文から要約を再実行します";
  },
  startCapture: async () => "", stopCapture: async () => "", deleteFolder: async () => "", deleteRecording: async () => "",
}));
const { runDashboard } = await import(${JSON.stringify(dashboardUrl)});
const dashboard = runDashboard(${JSON.stringify(outputRoot)});
async function frameContaining(text: string): Promise<string> {
  const deadline = Date.now() + 3500;
  let frame = "";
  while (Date.now() < deadline) {
    await setup.renderOnce();
    frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("画面に見つかりません: " + text + "\\n" + frame);
}
try {
  await frameContaining("ホーム");
  setup.mockInput.pressKey("h");
  await frameContaining("全記録");
  setup.mockInput.pressArrow("down");
  setup.mockInput.pressEnter();
  const initial = await frameContaining("状態:");
  if (retryable) {
    await frameContaining("要約を再実行 [r]");
    if (${JSON.stringify(action)} === "mouse") {
      function findRetryButton(node) {
        if (node instanceof core.TextRenderable && node.chunks.map(chunk => chunk.text).join("") === "要約を再実行 [r]") return node.parent;
        for (const child of node.getChildren()) {
          const found = findRetryButton(child);
          if (found) return found;
        }
      }
      const button = findRetryButton(setup.renderer.root);
      if (!button) throw new Error("再実行ボタンがありません");
      await setup.mockMouse.click(button.x + 1, button.y + 1);
    } else setup.mockInput.pressKey("r");
    const analyzing = await frameContaining("要約中");
    setup.mockInput.pressKey("r");
    await new Promise(resolve => setTimeout(resolve, 50));
    selectedPhase = "completed";
    await writeFile(join(older, "summary.md"), "選択した過去の記録の要約");
    const completed = await frameContaining("完了");
    setup.mockInput.pressTab();
    const summary = await frameContaining("選択した過去の記録の要約");
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ calls, initial, analyzing, completed, summary }));
  } else {
    setup.mockInput.pressKey("r");
    await new Promise(resolve => setTimeout(resolve, 50));
    await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ calls, initial }));
  }
} finally {
  setup.renderer.destroy();
  await dashboard;
}
`);
    await executeFile(process.execPath, [runner], { timeout: 12_000 });
    const result: { calls: string[]; initial: string; analyzing?: string; completed?: string; summary?: string } = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.initial.includes("要約を再実行 [r]")).toBe(retryable);
    expect(result.calls).toEqual(retryable ? [older] : []);
    if (retryable) {
      expect(result.analyzing).not.toContain("要約を再実行 [r]");
      expect(result.completed).not.toContain("要約を再実行 [r]");
      expect(result.summary).toContain("選択した過去の記録の要約");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
