import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const locksUrl = new URL("../src/locks.ts", import.meta.url).href;
const project = new URL("../", import.meta.url).pathname;

test.skipIf(process.platform !== "darwin").each(["timeout", "released"] as const)("開始用ロックの%sで待ち続けず安全に終了する", async (scenario) => {
  const root = await mkdtemp("/private/tmp/voice-note-start-wait-");
  try {
    const runner = join(root, "runner.ts");
    await writeFile(runner, `const { acquireProcessLock } = await import(${JSON.stringify(locksUrl)});
const path = ${JSON.stringify(join(root, "start.lock"))};
const held = await acquireProcessLock(path);
const waiting = acquireProcessLock(path, ${scenario === "timeout" ? 100 : 1000}).then(
  lock => ({kind: "acquired", lock}),
  error => ({kind: "failed", message: error instanceof Error ? error.message : String(error)}),
);
try {
  if (${JSON.stringify(scenario)} === "released") {
    await new Promise(resolve => setTimeout(resolve,50));
    await held.release();
  }
  const result = await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve({kind: "pending"}), 500))]);
  await held.release();
  const cleanup = await waiting;
  if (cleanup.kind === "acquired") await cleanup.lock.release();
  process.stdout.write(JSON.stringify({kind:result.kind,message:result.message}));
} finally { await held.release(); }
`);
    const { stdout } = await executeFile(process.execPath, [runner], { timeout: 4000 });
    const result: { kind: string; message?: string } = JSON.parse(stdout);
    expect(result.kind).toBe(scenario === "timeout" ? "failed" : "acquired");
    if (scenario === "timeout") expect(result.message).toContain("待ち時間");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("開始用ロックが塞がっていても新規録音を作らず理由を返す", async () => {
  const root = await mkdtemp("/private/tmp/voice-note-start-timeout-");
  try {
    const runner = join(root, "runner.ts");
    await writeFile(runner, `import { mock } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
const project = ${JSON.stringify(project)};
process.env.VOICE_NOTE_RUN_DIR = join(root,"run");
process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS = "1";
await mkdir(join(root,"bin"));
await writeFile(join(root,"bin/codex"),"#!/bin/sh\\nexit 0\\n",{mode:0o700});
process.env.PATH = join(root,"bin") + ":" + (process.env.PATH ?? "");
const processesPath = join(project,"src/processes.ts");
const processes = await import(processesPath);
const spawnCommand = processes.startCommand;
let launched = false;
mock.module(processesPath, () => ({ ...processes,
  startCommand: (command, args, options) => {
    if (args.includes(join(project,"src/worker.ts"))) {
      launched = true;
      throw new Error("probe stopped before recording");
    }
    return spawnCommand(command,args,options);
  },
}));
mock.module(join(project,"src/native-capture.ts"), () => ({prepareNativeCapture: async () => "not-started"}));
const { writeState, readState } = await import(join(project,"src/state.ts"));
const { acquireProcessLock } = await import(join(project,"src/locks.ts"));
const { START_LOCK } = await import(join(project,"src/config.ts"));
const { startCapture } = await import(join(project,"src/worker.ts"));
const session = join(root,"existing-session");
await mkdir(session);
await writeState("starting",session);
await writeState("analyzing",session);
const before = await readState();
const held = await acquireProcessLock(START_LOCK);
const start = startCapture(join(root,"sessions"),"","off").then(
  value => value, error => error instanceof Error ? error.message : String(error),
);
try {
  const result = await Promise.race([start,new Promise(resolve => setTimeout(() => resolve("still waiting"),6500))]);
  const after = await readState();
  process.stdout.write(JSON.stringify({result,launched,unchanged:JSON.stringify(before)===JSON.stringify(after)}));
} finally {
  await held.release();
  await start;
}
`);
    const { stdout } = await executeFile(process.execPath, [runner], { timeout: 9000 });
    const result: { result: string; launched: boolean; unchanged: boolean } = JSON.parse(stdout);
    expect(result.result).toContain("待ち時間");
    expect(result.launched).toBe(false);
    expect(result.unchanged).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
