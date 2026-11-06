import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

test.skipIf(process.platform !== "darwin").each([
  ["en-ja", "en-US"], ["off", "en-US"], ["off", "ja-JP"], ["en-ja", "ja-JP"],
  ["en-ja", ""], ["off", ""],
] as const)("翻訳%s・認識言語%sで逐次保存と要約を完了する", async (mode, language) => {
  const expectedLanguage = language || (mode === "en-ja" ? "en-US" : "ja-JP");
  const translating = mode === "en-ja" && expectedLanguage === "en-US";
  const root = await mkdtemp(join("/private/tmp", "voice-note-translation-worker-"));
  try {
    const fakeBin = join(root, "bin");
    const session = join(root, "20261012-100000-12345678");
    await mkdir(fakeBin);
    await mkdir(session, { mode: 0o700 });
    await writeFile(join(fakeBin, "capture"), `#!/usr/bin/env bun
await Bun.write(process.env.FIXTURE_CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));
const speaker = "System";
process.stdout.write("WEBVTT\\n\\n00:00.000 --> 00:01.000\\n<v " + speaker + ">Hello.\\n\\n");
process.stdout.write("00:01.000 --> 00:02.000\\n<v System>Welcome.\\n\\n");
process.on("SIGINT", () => process.stdout.write("00:02.000 --> 00:03.000\\n<v System>Goodbye.", () => process.exit(0)));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    await writeFile(join(fakeBin, "codex"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const output = args[args.indexOf("--output-last-message") + 1];
await Bun.write(output, input.startsWith("# 要約") ? "テスト会議" : "# 修正した文字起こし\\nHello.\\n\\n# 要約\\nテスト要約\\n");
`, { mode: 0o700 });
    const runner = join(root, "run.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
let translationCalls = 0;
let translatorClosed = false;
let launchedWorker;
let work;
const processesPath = ${JSON.stringify(join(project, "src/processes.ts"))};
const processes = await import(processesPath);
const spawnCommand = processes.startCommand;
mock.module(processesPath, () => ({ ...processes, startCommand: (command, args, options) => {
  if (args.includes(${JSON.stringify(join(project, "src/worker.ts"))})) {
    work = launchedWorker(args[2], args[3]);
    return spawnCommand("/usr/bin/true", [], options);
  }
  return spawnCommand(command, args, options);
} }));
mock.module(${JSON.stringify(join(project, "src/native-capture.ts"))}, () => ({
  prepareNativeCapture: async () => ${JSON.stringify(join(fakeBin, "capture"))},
}));
mock.module(${JSON.stringify(join(project, "src/native-translation.ts"))}, () => ({
  startNativeTranslator: async () => ({
    translate: async (text: string) => { translationCalls += 1; return "日本語訳: " + text; },
    close: async () => { translatorClosed = true; },
  }),
}));
const { writeState, readState } = await import(${JSON.stringify(join(project, "src/state.ts"))});
const { runWorker, getPublicStatus, startCapture } = await import(${JSON.stringify(join(project, "src/worker.ts"))});
const { sendControl } = await import(${JSON.stringify(join(project, "src/control.ts"))});
let session = process.argv[2]!;
launchedWorker = runWorker;
if (process.env.FIXTURE_LANGUAGE) {
  await startCapture(session, "", process.env.FIXTURE_MODE, process.env.FIXTURE_LANGUAGE);
  session = (await readState()).session_dir;
} else {
  await writeState("starting", session, { raw_path: join(session, "raw.vtt"), translation_mode: process.env.FIXTURE_MODE! });
  work = runWorker(session);
}
let translatedWhileRecording = false;
try {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const phase = (await readState(session)).phase;
    const raw = await readFile(join(session, "raw.vtt"), "utf8").catch(() => "");
    const translated = await readFile(join(session, "translation.vtt"), "utf8").catch(() => "");
    if (phase === "recording" && raw.includes("Welcome.") && (process.env.FIXTURE_TRANSLATING !== "1" || translated.includes("Welcome."))) {
      translatedWhileRecording = translated.includes("Welcome.");
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
} finally {
  await sendControl("stop", session);
  await work;
}
const state = await readState(session);
process.stdout.write(JSON.stringify({savedLanguage: state.recognition_language, language: (await getPublicStatus(session)).recognition_language, phase: state.phase, translationCalls, translatorClosed, translatedWhileRecording,
  translationExists: await access(join(session, "translation.vtt")).then(() => true).catch(() => false),
  args: JSON.parse(await readFile(process.env.FIXTURE_CAPTURE_ARGS!, "utf8")),
  lastCaptionSaved: (await readFile(join(session, "raw.vtt"), "utf8")).includes("Goodbye."),
  lastTranslationSaved: (await readFile(join(session, "translation.vtt"), "utf8").catch(() => "")).includes("Goodbye."),
}));
`);
    const { stdout } = await executeFile(process.execPath, [runner, session], {
      env: {
        ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        VOICE_NOTE_RUN_DIR: join(root, "run"), VOICE_NOTE_DISABLE_NOTIFICATIONS: "1",
        FIXTURE_MODE: mode, FIXTURE_LANGUAGE: language, FIXTURE_TRANSLATING: translating ? "1" : "0", FIXTURE_CAPTURE_ARGS: join(root, "capture-args.json"),
      },
      timeout: 10_000,
    });
    const result: { savedLanguage?: string; language: string; phase: string; translationCalls: number; translatedWhileRecording: boolean; translatorClosed: boolean; translationExists: boolean; args: string[]; lastCaptionSaved: boolean; lastTranslationSaved: boolean } = JSON.parse(stdout);
    expect(result.phase).toBe("completed");
    expect(result.args).toEqual(["--locale", expectedLanguage]);
    expect(result.language).toBe(expectedLanguage);
    expect(result.savedLanguage).toBe(language || undefined);
    expect(result.translationCalls).toBe(translating ? 3 : 0);
    expect(result.translatedWhileRecording).toBe(translating);
    expect(result.translatorClosed).toBe(translating);
    expect(result.translationExists).toBe(translating);
    expect(result.lastCaptionSaved).toBe(true);
    expect(result.lastTranslationSaved).toBe(translating);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
