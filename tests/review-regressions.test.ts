import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// macOSのソケット名の長さ制限に収まる場所を使う。
const fixtureRoot = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "voice-notes-test-"));
const originalRunDirectory = process.env.VOICE_NOTE_RUN_DIR;
const originalNotifications = process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS;
process.env.VOICE_NOTE_RUN_DIR = join(fixtureRoot, "run");
process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS = "1";
const { writeState, readState } = await import("../src/state.ts");
const { retryCapture, getPublicStatus } = await import("../src/worker.ts");
const { createPrivateSession, listRecords, showRecord } = await import("../src/storage.ts");
const { acquireProcessLock, isProcessLockActive } = await import("../src/locks.ts");
const { RECORD_LOCK, sessionWorkLockPath } = await import("../src/config.ts");
const { startControlServer } = await import("../src/control.ts");
const executeFile = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const fakeBin = join(fixtureRoot, "bin");
await mkdir(fakeBin);
await writeFile(join(fakeBin, "codex"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
for await (const chunk of process.stdin) {}
await new Promise(resolve => setTimeout(resolve, 350));
const output = args[args.indexOf('--output-last-message') + 1];
await Bun.write(output, '# 修正した文字起こし\\nテスト本文\\n\\n# 要約\\nテスト要約\\n');
`, { mode: 0o700 });
const originalPath = process.env.PATH;
process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

afterAll(async () => {
  for (const [key, value] of Object.entries({
    PATH: originalPath,
    VOICE_NOTE_RUN_DIR: originalRunDirectory,
    VOICE_NOTE_DISABLE_NOTIFICATIONS: originalNotifications,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixtureRoot, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin").each(["starting", "recording", "stopping", "analyzing"] as const)("%sでプロセスが消えた記録をretryで要約できる", async (phase) => {
  const session = await createPrivateSession(join(fixtureRoot, "recordings"));
  const rawPath = join(session, "raw.vtt");
  const transcript = "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Mic>テスト\n\n00:01.000 --> 00:02.000\n<v System>確認\n";
  await writeFile(rawPath, transcript);
  await writeState("starting", session, { raw_path: rawPath });
  await writeState(phase, session);
  expect((await getPublicStatus()).phase).toBe("interrupted");
  await retryCapture();
  const deadline = Date.now() + 5_000;
  while (((await readState(session)).phase !== "completed" || await isProcessLockActive(sessionWorkLockPath(session))) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect((await readState(session)).phase).toBe("completed");
  expect(await readFile(rawPath, "utf8")).toBe(transcript);
});

test.skipIf(process.platform !== "darwin").each(["record", "worker", "socket"] as const)("%sが稼働中ならretryは録音状態を変更しない", async (activeResource) => {
  const session = await createPrivateSession(join(fixtureRoot, "active"));
  const rawPath = join(session, "raw.vtt");
  await writeFile(rawPath, "WEBVTT\n");
  await writeState("starting", session, { raw_path: rawPath });
  await writeState("recording", session);
  const lock = activeResource === "socket" ? undefined
    : await acquireProcessLock(activeResource === "record" ? RECORD_LOCK : sessionWorkLockPath(session));
  const server = activeResource === "socket" ? await startControlServer(session, () => {}) : undefined;
  try {
    await expect(retryCapture()).rejects.toThrow("録音中のセッションがあります");
    expect((await readState(session)).phase).toBe("recording");
  } finally {
    await server?.close();
    await lock?.release();
  }
});

test.skipIf(process.platform !== "darwin").each(["failed", "interrupted", "analyzing", "recording"] as const)("過去の%s記録を指定して再要約し最新の記録を保持する", async (phase) => {
  const olderSession = await createPrivateSession(join(fixtureRoot, "selected-retry"));
  const rawPath = join(olderSession, "raw.vtt");
  const transcript = "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Mic>過去の架空の記録\n";
  await writeFile(rawPath, transcript);
  await writeState("starting", olderSession, { raw_path: rawPath });
  await writeState(phase, olderSession);
  const latestSession = await createPrivateSession(join(fixtureRoot, "selected-retry"));
  await writeState("starting", latestSession);
  await writeState("completed", latestSession);
  const latestState = await readState();

  await retryCapture(olderSession);
  const deadline = Date.now() + 5_000;
  while (((await readState(olderSession)).phase !== "completed" || await isProcessLockActive(sessionWorkLockPath(olderSession))) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const completed = await readState(olderSession);
  expect(completed.phase).toBe("completed");
  expect(completed.summary_path).toBe(join(olderSession, "summary.md"));
  expect(await readFile(join(olderSession, "summary.md"), "utf8")).toContain("テスト要約");
  expect(await readFile(rawPath, "utf8")).toBe(transcript);
  expect(await readState()).toEqual(latestState);
});

test.skipIf(process.platform !== "darwin").each(["failed", "interrupted", "analyzing"] as const)("フォルダ移動後の%s記録を現在の原文から再要約する", async (phase) => {
  const parent = await mkdtemp(join(fixtureRoot, "moved-retry-"));
  const original = await createPrivateSession(parent);
  const transcript = "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Mic>移動した架空の記録\n";
  await writeFile(join(original, "raw.vtt"), transcript);
  await writeState("starting", original, { raw_path: join(original, "raw.vtt") });
  await writeState(phase, original);
  const before = await readState(original);
  const moved = join(parent, "分類", "移動した記録");
  await mkdir(join(parent, "分類"));
  await rename(original, moved);
  const latest = await createPrivateSession(parent);
  await writeState("starting", latest);
  await writeState("completed", latest);
  const latestState = await readState();

  const status = await getPublicStatus(moved);
  expect(status.phase).toBe(phase === "analyzing" ? "interrupted" : phase);
  expect(status.session_dir).toBe(moved);
  expect(status.raw_path).toBe(join(moved, "raw.vtt"));
  expect(status.started_at).toBe(before.started_at);
  await retryCapture(moved);
  const deadline = Date.now() + 5_000;
  while (((await readState(moved)).phase !== "completed" || await isProcessLockActive(sessionWorkLockPath(moved))) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  expect((await readState(moved)).phase).toBe("completed");
  expect((await readState(moved)).summary_path).toBe(join(moved, "summary.md"));
  expect(await readFile(join(moved, "raw.vtt"), "utf8")).toBe(transcript);
  expect(await readState()).toEqual(latestState);
});

test.skipIf(process.platform !== "darwin")("移動後も作業用ロックが有効なら要約を重複実行しない", async () => {
  const parent = await mkdtemp(join(fixtureRoot, "moved-active-"));
  const original = await createPrivateSession(parent);
  await writeFile(join(original, "raw.vtt"), "WEBVTT\n");
  await writeState("starting", original, { raw_path: join(original, "raw.vtt") });
  await writeState("analyzing", original);
  const lock = await acquireProcessLock(sessionWorkLockPath(original));
  const moved = join(parent, "移動した記録");
  try {
    await rename(original, moved);
    expect((await getPublicStatus(moved)).phase).toBe("analyzing");
    await expect(retryCapture(moved)).rejects.toThrow();
    expect((await readState(moved)).phase).toBe("analyzing");
  } finally {
    await lock.release();
  }
});

test("移動した記録内のファイル参照だけを補正し、状態ファイルは読み替えだけにとどめる", async () => {
  const parent = await mkdtemp(join(fixtureRoot, "moved-paths-"));
  const original = await createPrivateSession(parent);
  await writeState("failed", original, {
    raw_path: join(original, "raw.vtt"), result_path: join(original, "result.md"),
    summary_path: join(original, "summary.md"), translation_path: join(original, "translation.vtt"),
    output_root: parent,
  });
  const moved = join(parent, "移動した記録");
  await rename(original, moved);
  // 同名の移動前フォルダが再作成されても、そちらの原文を選ばない。
  await mkdir(original);
  await writeFile(join(original, "raw.vtt"), "別の記録");
  const statePath = join(moved, ".voice-note-state.json");
  const before = await readFile(statePath, "utf8");
  expect(await readState(moved)).toMatchObject({
    phase: "failed", session_dir: moved, raw_path: join(moved, "raw.vtt"),
    result_path: join(moved, "result.md"), summary_path: join(moved, "summary.md"),
    translation_path: join(moved, "translation.vtt"), output_root: parent,
  });
  expect(await readFile(statePath, "utf8")).toBe(before);
});

test.skipIf(process.platform !== "darwin")("過去の記録の再要約は同じ記録の実行中に重複開始しない", async () => {
  const session = await createPrivateSession(join(fixtureRoot, "retry-active-summary"));
  await writeFile(join(session, "raw.vtt"), "WEBVTT\n");
  await writeState("starting", session);
  await writeState("analyzing", session);
  const lock = await acquireProcessLock(sessionWorkLockPath(session));
  try {
    await expect(retryCapture(session)).rejects.toThrow();
    expect((await readState(session)).phase).toBe("analyzing");
  } finally {
    await lock.release();
  }
});

test.skipIf(process.platform !== "darwin").each(["record", "socket"] as const)("別の録音が%sで稼働中なら過去の失敗記録を再要約しない", async (activeResource) => {
  const session = await createPrivateSession(join(fixtureRoot, "retry-during-recording"));
  await writeFile(join(session, "raw.vtt"), "WEBVTT\n\n00:00.000 --> 00:01.000\n<v Mic>架空の記録\n");
  await writeState("starting", session);
  await writeState("failed", session);
  const recordingSession = await createPrivateSession(join(fixtureRoot, "retry-during-recording"));
  await writeState("starting", recordingSession);
  await writeState("recording", recordingSession);
  const lock = activeResource === "record" ? await acquireProcessLock(RECORD_LOCK) : undefined;
  const server = activeResource === "socket" ? await startControlServer(recordingSession, () => {}) : undefined;
  try {
    await expect(retryCapture(session)).rejects.toThrow("録音中のセッションがあります");
    expect((await readState(session)).phase).toBe("failed");
    expect((await readState(recordingSession)).phase).toBe("recording");
  } finally {
    await server?.close();
    await lock?.release();
  }
});

test.skipIf(process.platform !== "darwin").each(["completed", "missing-raw"] as const)("%sの過去の記録は再要約しない", async (condition) => {
  const session = await createPrivateSession(join(fixtureRoot, "retry-unavailable"));
  if (condition !== "missing-raw") await writeFile(join(session, "raw.vtt"), "WEBVTT\n");
  await writeState("starting", session);
  await writeState(condition === "completed" ? "completed" : "failed", session);
  const before = await readState(session);
  const latestSession = await createPrivateSession(join(fixtureRoot, "retry-unavailable"));
  await writeState("starting", latestSession);
  await writeState("completed", latestSession);
  await expect(retryCapture(session)).rejects.toThrow("再要約できる原文がありません");
  expect(await readState(session)).toEqual(before);
  expect((await readState()).session_dir).toBe(latestSession);
});

test("入れ子フォルダの記録を一覧・ID指定・最新指定で取得できる", async () => {
  const outputRoot = join(fixtureRoot, "nested");
  const olderSession = join(outputRoot, "20261007-120000-12345678");
  const nestedId = "20261007-130000-abcdef12";
  const nestedSession = join(outputRoot, "team", "meeting", nestedId);
  await mkdir(olderSession, { recursive: true, mode: 0o700 });
  await mkdir(nestedSession, { recursive: true, mode: 0o700 });
  await writeFile(join(nestedSession, "raw.vtt"), "入れ子の原文");
  const listing = await listRecords(outputRoot, { recursive: true });
  expect(listing).toEqual(expect.arrayContaining([expect.objectContaining({ session_id: nestedId })]));
  for (const target of [nestedId, "latest"]) {
    const displayed = await showRecord(outputRoot, target);
    expect(displayed).toContain(nestedId);
    expect(displayed).toContain("入れ子の原文");
  }
});

test("引数なしで録音せず操作画面を開く", async () => {
  const preloadPath = join(fixtureRoot, "mock-dashboard.ts");
  const dashboardPath = fileURLToPath(new URL("../src/dashboard.ts", import.meta.url));
  const outputRoot = join(fixtureRoot, "ui-recordings");
  await writeFile(preloadPath, `import { mock } from "bun:test";
mock.module(${JSON.stringify(dashboardPath)}, () => ({
  runDashboard: async (outputRoot: string) => {
    process.stdout.write(JSON.stringify({ opened: outputRoot }));
  },
}));
`);
  const { stdout } = await executeFile(process.execPath, ["--preload", preloadPath, cliPath], {
    env: {
      ...process.env,
      VOICE_NOTE_SETTINGS_PATH: join(fixtureRoot, "missing-settings.json"),
      VOICE_NOTE_SESSIONS_DIR: outputRoot,
    },
    timeout: 5_000,
  });
  expect(JSON.parse(stdout)).toEqual({ opened: outputRoot });
});

test.each(["--help", "-h"])("%sはUI起動のヘルプを表示する", async (argument) => {
  const { stdout } = await executeFile(process.execPath, ["run", cliPath, argument], { timeout: 5_000 });
  expect(stdout).toContain("操作画面を開きます");
  expect(stdout).not.toContain("バックグラウンド録音を始める");
});

test.each(["record", "analyze", "start", "stop", "retry", "status", "records", "show", "config", "folder", "ui", "--duration", "--output-dir", "--folder", "--json", "--wait"])("旧操作%sは実行せずUI起動を案内する", async (argument) => {
  try {
    await executeFile(process.execPath, ["run", cliPath, argument], { timeout: 5_000 });
    throw new Error("旧操作が成功してしまいました");
  } catch (error) {
    expect(error).toMatchObject({ code: 1, stderr: expect.stringContaining("引数なしで起動") });
  }
});
