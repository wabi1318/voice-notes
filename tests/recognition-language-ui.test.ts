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

test.each(["key", "mouse"] as const)("認識言語と翻訳を%sで別々に選択して録音へ渡す", async (action) => {
  const root = await mkdtemp("/private/tmp/voice-note-language-ui-");
  try {
    const sessions = join(root, "sessions");
    await mkdir(sessions, { mode: 0o700 });
    const runner = join(root, "runner.ts");
    const resultPath = join(root, "result.json");
    await writeFile(runner, `import { mock } from "bun:test";
import { writeFile } from "node:fs/promises";
const core = await import(${JSON.stringify(coreUrl)});
const { createTestRenderer } = await import(${JSON.stringify(testingUrl)});
const setup = await createTestRenderer({ width: 160, height: 45 });
mock.module(${JSON.stringify(coreUrl)}, () => ({ ...core, createCliRenderer: async () => setup.renderer }));
let status = { phase: "idle" };
const calls = [];
let finishStart;
mock.module(${JSON.stringify(workerUrl)}, () => ({
  getPublicStatus: async () => status,
  startCapture: async (...args) => {
    calls.push(args);
    status = { phase: "starting", recognition_language: args[3], translation_mode: args[2] };
    await new Promise(resolve => { finishStart = resolve; });
    status = { ...status, phase: "recording" };
    return "録音開始";
  },
  retryCapture: async () => "", stopCapture: async () => "", deleteFolder: async () => "", deleteRecording: async () => "",
}));
const { runDashboard } = await import(${JSON.stringify(dashboardUrl)});
const dashboard = runDashboard(${JSON.stringify(sessions)});
async function frameContaining(text) {
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
async function operate(label, key) {
  if (${JSON.stringify(action)} === "key") { setup.mockInput.pressKey(key); return; }
  function findButton(node) {
    if (node instanceof core.TextRenderable && node.chunks.map(chunk => chunk.text).join("") === label) return node.parent;
    for (const child of node.getChildren()) {
      const found = findButton(child);
      if (found) return found;
    }
  }
  const button = findButton(setup.renderer.root);
  if (!button) throw new Error("ボタンがありません: " + label);
  await setup.mockMouse.click(button.x + 1, button.y + 1);
}
try {
  await frameContaining("認識言語: 日本語 [l]");
  await operate("同時翻訳: オフ [t]", "t");
  const japanese = await frameContaining("先に認識言語を英語にしてください");
  await operate("認識言語: 日本語 [l]", "l");
  await frameContaining("認識言語: 英語 [l]");
  await operate("同時翻訳: オフ [t]", "t");
  const translated = await frameContaining("同時翻訳: 英語→日本語 [t]");
  await operate("認識言語: 英語 [l]", "l");
  const reset = await frameContaining("認識言語: 日本語 [l]");
  await operate("認識言語: 日本語 [l]", "l");
  await frameContaining("認識言語: 英語 [l]");
  await operate("同時翻訳: オフ [t]", "t");
  await frameContaining("同時翻訳: 英語→日本語 [t]");
  await operate("同時翻訳: 英語→日本語 [t]", "t");
  const untranslated = await frameContaining("同時翻訳: オフ [t]");
  setup.mockInput.pressKey("r");
  const live = await frameContaining("英語の文字起こし");
  setup.mockInput.pressEscape();
  await frameContaining("Voice Notes / ホーム");
  await operate("認識言語: 英語 [l]", "l");
  const preparing = await frameContaining("認識言語は録音を停止してから変更してください");
  finishStart();
  await frameContaining("録音中");
  await operate("同時翻訳: オフ [t]", "t");
  const recording = await frameContaining("翻訳の設定は録音を停止してから変更してください");
  await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ calls, japanese, translated, reset, untranslated, live, preparing, recording }));
} finally {
  finishStart?.();
  setup.renderer.destroy();
  await dashboard;
}
`);
    await executeFile(process.execPath, [runner], {
      timeout: 12_000,
      env: { ...process.env, VOICE_NOTE_RUN_DIR: join(root, "run"), VOICE_NOTE_SESSIONS_DIR: sessions,
        VOICE_NOTE_SETTINGS_PATH: join(root, "settings.json"), VOICE_NOTE_DISABLE_NOTIFICATIONS: "1" },
    });
    const result: { calls: string[][]; japanese: string; translated: string; reset: string; untranslated: string; live: string; preparing: string; recording: string } = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.calls).toEqual([[sessions, "", "off", "en-US"]]);
    expect(result.japanese).toContain("同時翻訳: オフ [t]");
    expect(result.translated).toContain("認識言語: 英語 [l]");
    expect(result.reset).toContain("同時翻訳: オフ [t]");
    expect(result.untranslated).toContain("認識言語: 英語 [l]");
    expect(result.live).toContain("認識言語: 英語 / 同時翻訳: オフ");
    expect(result.preparing).toContain("認識言語: 英語 [l]");
    expect(result.recording).toContain("同時翻訳: オフ [t]");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
