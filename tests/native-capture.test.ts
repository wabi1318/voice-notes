import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { validateTranscript } from "../src/capture.ts";

const executeFile = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test.each(["Mic", "System"])("%sだけに発言がある録音も正常な記録として扱う", async (speaker) => {
  const root = await mkdtemp("/private/tmp/voice-note-single-source-");
  try {
    const path = join(root, "raw.vtt");
    await writeFile(path, `WEBVTT\n\n00:00.000 --> 00:01.000\n<v ${speaker}>テスト\n\n`);
    await expect(validateTranscript(path)).resolves.toBeUndefined();
    await writeFile(path, "WEBVTT\n\n");
    await expect(validateTranscript(path)).rejects.toThrow("空");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "darwin").each(["startup", "recording", "cancel-start"])("録音補助プロセスの%sで停止・原文保持・理由の通知を行う", async (scenario) => {
  const root = await mkdtemp("/private/tmp/voice-note-capture-test-");
  try {
    const session = join(root, "session");
    await mkdir(session);
    const helper = join(root, "capture");
    await writeFile(helper, `#!/usr/bin/env bun
process.on("SIGINT", () => { Bun.write(${JSON.stringify(join(root, "stopped"))}, "yes").then(() => process.exit(0)); });
await Bun.write(${JSON.stringify(join(root, "signal-ready"))}, "yes");
if (${JSON.stringify(scenario)} === "startup") {
  process.stderr.write("マイクの権限がありません\\n"); process.exit(1);
}
if (${JSON.stringify(scenario)} === "recording") {
  process.stdout.write("WEBVTT\\n\\n00:00.000 --> 00:01.000\\n<v Mic>保存する発言\\n\\n");
  process.stderr.write("[capture-dia");
  setTimeout(() => {
    process.stderr.write('gnostic] {"event":"audio_configuration_changed"}\\n');
    process.stderr.write("音声機器が変更されました\\n"); process.exit(1);
  }, 150);
}
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const runner = join(root, "run.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import { access } from "node:fs/promises";
mock.module(${JSON.stringify(join(project, "src/native-capture.ts"))}, () => ({prepareNativeCapture: async () => ${JSON.stringify(helper)}}));
const { recordInWorker } = await import(${JSON.stringify(join(project, "src/capture.ts"))});
const { writeState } = await import(${JSON.stringify(join(project, "src/state.ts"))});
await writeState("starting", ${JSON.stringify(session)});
const stop = new AbortController();
const timer = setTimeout(() => stop.abort(), 3000);
const recording = recordInWorker(${JSON.stringify(session)}, stop.signal);
void recording.catch(() => {});
try {
  if (${JSON.stringify(scenario)} === "cancel-start") {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !(await access(${JSON.stringify(join(root, "signal-ready"))}).then(() => true).catch(() => false))) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    stop.abort();
  }
  await recording;
}
catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }
finally { clearTimeout(timer); }
`);
    const { stdout, stderr } = await executeFile(process.execPath, [runner], {
      env: { ...process.env, VOICE_NOTE_RUN_DIR: join(root, "run") }, timeout: 5000,
    });
    if (scenario === "startup") expect(stdout).toContain("マイクの権限がありません");
    if (scenario === "recording") {
      expect(stdout.trim()).toBe("音声機器が変更されました");
      expect(stderr).toContain('[capture-diagnostic] {"event":"audio_configuration_changed"}');
      expect(await readFile(join(session, "raw.vtt"), "utf8")).toContain("保存する発言");
    }
    if (scenario === "cancel-start") expect(await readFile(join(root, "stopped"), "utf8")).toBe("yes");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);
