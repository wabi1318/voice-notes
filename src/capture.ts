import { createInterface } from "node:readline";
import { access, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CAPTURE_START_POLL_MS, PROJECT_DIR, RECORD_LOCK, START_LOCK, STOP_TIMEOUT_MS } from "./config.ts";
import { sendControl } from "./control.ts";
import { acquireProcessLock, tryAcquireProcessLock } from "./locks.ts";
import type { ProcessLock } from "./locks.ts";
import { sendChildSignal, sendProcessSignal, startCommand, waitForChild } from "./processes.ts";
import type { ChildSignalTarget } from "./processes.ts";
import { createPrivateSession } from "./storage.ts";
import { ensureRunDirectory, readState, writeState } from "./state.ts";
import type { ChildProcess } from "node:child_process";
import { prepareNativeCapture } from "./native-capture.ts";

const CAPTURE_PREPARATION_TIMEOUT_MS = 180_000;
const CAPTURE_ERROR_MAX_LENGTH = 4_096;

type CaptureOptions = Readonly<{
  sessionDirectory: string;
  stopSignal?: AbortSignal;
  durationSeconds?: number;
  showTranscript: boolean;
  waitForFirstOutput: boolean;
  recordLockPath?: string;
  onCaptureReady?: () => Promise<void>;
  locale?: "ja-JP" | "en-US";
  onTranscriptChunk?: (chunk: Buffer) => void;
}>;

type CaptureResult = Readonly<{ raw_path: string }>;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProcessRunning(childProcess: ChildProcess): boolean {
  return childProcess.exitCode === null && childProcess.signalCode === null;
}

type StopWait = Readonly<{ promise: Promise<void>; cancel: () => void }>;

function waitForStopSignal(stopSignal: AbortSignal): StopWait {
  let abortHandler: (() => void) | undefined;
  const promise = new Promise<void>((resolveWait) => {
    if (stopSignal.aborted) resolveWait();
    else {
      abortHandler = () => resolveWait();
      stopSignal.addEventListener("abort", abortHandler, { once: true });
    }
  });
  return {
    promise,
    cancel: () => {
      if (abortHandler !== undefined) stopSignal.removeEventListener("abort", abortHandler);
    },
  };
}

function waitForEnterOrSignal(): StopWait {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let resolvePromise: (() => void) | undefined;
  let finished = false;
  const promise = new Promise<void>((resolveWait) => {
    resolvePromise = resolveWait;
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    process.off("SIGINT", finish);
    input.close();
    resolvePromise?.();
  };
  input.once("line", finish);
  input.once("SIGINT", finish);
  process.once("SIGINT", finish);
  return { promise, cancel: finish };
}

function waitForDuration(durationSeconds: number): StopWait {
  const timeout = Math.max(1, Math.ceil(durationSeconds * 1_000));
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolveWait) => {
    timer = setTimeout(resolveWait, timeout);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForCaptureReady(
  readyPath: string,
  childProcess: ChildProcess,
  childExit: ReturnType<typeof waitForChild>,
): Promise<number> {
  const deadline = Date.now() + CAPTURE_PREPARATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let readyFileExists = false;
    try {
      await access(readyPath);
      readyFileExists = true;
    } catch {
      readyFileExists = false;
    }
    if (readyFileExists) {
      const processIdText = (await readFile(readyPath, "utf8")).trim();
      const processId = Number(processIdText);
      if (!Number.isInteger(processId) || processId < 1) {
        throw new Error("録音の起動状態を読み取れませんでした");
      }
      return processId;
    }
    if (!isProcessRunning(childProcess)) {
      const exit = await childExit;
      if (exit.code === 75) throw new Error("前景録音がすでに実行中です");
      throw new Error(`録音を開始できませんでした。終了コード: ${String(exit.code)}`);
    }
    await delay(CAPTURE_START_POLL_MS);
  }
  throw new Error("録音準備が時間内に完了しませんでした");
}

async function captureAudio(options: CaptureOptions): Promise<CaptureResult> {
  const rawPath = join(options.sessionDirectory, "raw.vtt");
  const capturePath = await prepareNativeCapture();
  const outputFile = await open(rawPath, "wx", 0o600);
  const readyPath = options.recordLockPath === undefined
    ? undefined
    : join(options.sessionDirectory, `.capture-ready-${randomUUID()}`);
  const commandPath = options.recordLockPath === undefined ? capturePath : "/usr/bin/lockf";
  const captureArguments = ["--locale", options.locale ?? "ja-JP"];
  const commandArguments = options.recordLockPath === undefined
    ? captureArguments
    : [
        "-k",
        "-n",
        "-t",
        "0",
        options.recordLockPath,
        process.execPath,
        "run",
        join(PROJECT_DIR, "src", "locked-capture.ts"),
        readyPath ?? "",
        capturePath,
        ...captureArguments,
      ];
  let childProcess: ChildProcess;
  try {
    childProcess = startCommand(commandPath, commandArguments, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    await outputFile.close();
    throw error;
  }
  if (childProcess.stdout === null) {
    childProcess.kill("SIGINT");
    await outputFile.close();
    throw new Error("文字起こしを受け取れませんでした");
  }

  let errorOutput = "";
  if (childProcess.stderr !== null) {
    childProcess.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    const errorLines = createInterface({ input: childProcess.stderr, crlfDelay: Infinity });
    errorLines.on("line", (line: string) => {
      if (line.startsWith("[capture-diagnostic] ")) return;
      errorOutput = `${errorOutput}${line}\n`.slice(-CAPTURE_ERROR_MAX_LENGTH);
    });
  }

  let outputWrite = Promise.resolve();
  let outputFailure: unknown;
  let canDisplayTranscript = options.showTranscript;
  const handleDisplayError = (error: Error) => {
    if (isNodeError(error) && error.code === "EPIPE") {
      canDisplayTranscript = false;
      return;
    }
    outputFailure = error;
  };
  if (options.showTranscript) process.stdout.on("error", handleDisplayError);
  let receivedOutput = false;
  let resolveFirstOutput: (() => void) | undefined;
  const firstOutput = new Promise<void>((resolvePromise) => {
    resolveFirstOutput = resolvePromise;
  });
  childProcess.stdout.on("data", (chunk: Buffer) => {
    receivedOutput = true;
    resolveFirstOutput?.();
    outputWrite = outputWrite.then(async () => {
      await outputFile.write(chunk);
      options.onTranscriptChunk?.(chunk);
    }).catch((error: unknown) => {
      outputFailure = error;
      childProcess.kill("SIGINT");
    });
    if (canDisplayTranscript) {
      try {
        process.stdout.write(chunk);
      } catch (error) {
        if (isNodeError(error) && error.code === "EPIPE") canDisplayTranscript = false;
        else outputFailure = new Error(`文字起こしの表示に失敗しました: ${rawPath}`, { cause: error });
      }
    }
  });

  const childExit = waitForChild(childProcess);
  void childExit.catch(() => undefined);
  let lockedCaptureProcessId: number | undefined;
  try {
    let shouldStop = false;
    if (readyPath !== undefined) {
      lockedCaptureProcessId = await waitForCaptureReady(readyPath, childProcess, childExit);
      await writeState("recording", options.sessionDirectory, { raw_path: rawPath });
      await options.onCaptureReady?.();
    } else if (options.waitForFirstOutput) {
      type InitialEvent = "output" | "exit" | "stop" | "timeout";
      let preparationTimer: NodeJS.Timeout | undefined;
      const initialEvents: Promise<InitialEvent>[] = [
        firstOutput.then(() => "output"),
        childExit.then(() => "exit"),
        new Promise((resolveWait) => {
          preparationTimer = setTimeout(() => resolveWait("timeout"), CAPTURE_PREPARATION_TIMEOUT_MS);
        }),
      ];
      const initialStopWait = options.stopSignal === undefined ? undefined : waitForStopSignal(options.stopSignal);
      if (initialStopWait !== undefined) initialEvents.push(initialStopWait.promise.then(() => "stop"));
      let initialResult: InitialEvent;
      try {
        initialResult = await Promise.race(initialEvents);
      } finally {
        if (preparationTimer !== undefined) clearTimeout(preparationTimer);
        initialStopWait?.cancel();
      }
      if (initialResult === "timeout") throw new Error("録音準備が時間内に完了しませんでした。権限と音声認識データを確認してください");
      if (initialResult === "output" && !options.stopSignal?.aborted) {
        await writeState("recording", options.sessionDirectory, { raw_path: rawPath });
      }
      shouldStop = initialResult === "stop" || options.stopSignal?.aborted === true;
    } else {
      await writeState("recording", options.sessionDirectory, { raw_path: rawPath });
    }

    if (isProcessRunning(childProcess) && !shouldStop) {
      const stopWait = options.stopSignal !== undefined
        ? waitForStopSignal(options.stopSignal)
        : options.durationSeconds === undefined
          ? waitForEnterOrSignal()
          : waitForDuration(options.durationSeconds);
      type NextEvent = Readonly<{ kind: "exit" }> | Readonly<{ kind: "stop" }>;
      const nextEvents: Promise<NextEvent>[] = [
        childExit.then(() => ({ kind: "exit" })),
        stopWait.promise.then(() => ({ kind: "stop" })),
      ];
      const nextEvent = await Promise.race(nextEvents);
      stopWait.cancel();
      shouldStop = nextEvent.kind === "stop";
    }

    let exitCode: number | null = childProcess.exitCode;
    if (isProcessRunning(childProcess) && shouldStop) {
      await writeState("stopping", options.sessionDirectory, { raw_path: rawPath });
      const signalTarget: ChildSignalTarget | undefined = lockedCaptureProcessId === undefined
        ? undefined
        : { processId: lockedCaptureProcessId };
      if (signalTarget === undefined) sendChildSignal(childProcess, "SIGINT");
      else sendProcessSignal(signalTarget.processId, "SIGINT");
      const stopped = await waitForChild(childProcess, STOP_TIMEOUT_MS, signalTarget);
      exitCode = stopped.code;
    } else if (isProcessRunning(childProcess)) {
      const exit = await childExit;
      exitCode = exit.code;
    }

    await outputWrite;
    if (outputFailure !== undefined) {
      throw new Error(`文字起こしの保存に失敗しました: ${rawPath}`, { cause: outputFailure });
    }
    if (exitCode !== 0) {
      const signal = childProcess.signalCode;
      const detail = signal === null ? String(exitCode) : `signal ${signal}`;
      throw new Error(errorOutput.trim() || `録音が終了コード${detail}で停止しました。`);
    }
    if (!receivedOutput) {
      const state = await readState(options.sessionDirectory);
      if (state.phase !== "stopping") throw new Error(`文字起こしを受け取れませんでした: ${rawPath}`);
    }
    return { raw_path: rawPath };
  } catch (error) {
    if (childProcess.pid !== undefined && isProcessRunning(childProcess)) {
      const signalTarget: ChildSignalTarget | undefined = lockedCaptureProcessId === undefined
        ? undefined
        : { processId: lockedCaptureProcessId };
      if (signalTarget === undefined) sendChildSignal(childProcess, "SIGINT");
      else sendProcessSignal(signalTarget.processId, "SIGINT");
      await waitForChild(childProcess, STOP_TIMEOUT_MS, signalTarget).catch(() => {
        if (signalTarget === undefined) sendChildSignal(childProcess, "SIGKILL");
        else sendProcessSignal(signalTarget.processId, "SIGKILL");
      });
    }
    throw error;
  } finally {
    await outputWrite;
    await outputFile.close();
    if (options.showTranscript) process.stdout.off("error", handleDisplayError);
    if (readyPath !== undefined) await unlink(readyPath).catch(() => undefined);
  }
}

export async function validateTranscript(rawPath: string): Promise<void> {
  const rawText = await readFile(rawPath, "utf8");
  if (!rawText.startsWith("WEBVTT") || !rawText.includes("-->")) {
    throw new Error(`文字起こしが空、または不完全です: ${rawPath}`);
  }
  const hasMicrophone = rawText.includes("<v Mic>");
  const hasSystemAudio = rawText.includes("<v System>");
  if (!hasMicrophone && !hasSystemAudio) {
    throw new Error(`発言を確認できませんでした。原文を確認してください: ${rawPath}`);
  }
}

export async function recordTranscript(durationSeconds: number | undefined, outputRoot: string): Promise<string> {
  if (durationSeconds === undefined && !process.stdin.isTTY) {
    throw new Error("対話型ターミナルで実行するか、--duration 秒数を指定してください。");
  }
  await prepareNativeCapture();
  await ensureRunDirectory();
  const startLock = await acquireProcessLock(START_LOCK);
  let startLockReleased = false;
  let recordLockProbe: ProcessLock | undefined;
  let sessionDirectory: string | undefined;
  try {
    const recordLockAttempt = await tryAcquireProcessLock(RECORD_LOCK);
    if (recordLockAttempt.kind === "held") throw new Error("前景録音がすでに実行中です");
    recordLockProbe = recordLockAttempt.lock;
    if (await sendControl("status")) throw new Error("バックグラウンド処理が実行中です");

    sessionDirectory = await createPrivateSession(outputRoot);
    const rawPath = join(sessionDirectory, "raw.vtt");
    await writeState("starting", sessionDirectory, {
      capture_mode: "foreground",
      output_root: outputRoot,
      raw_path: rawPath,
    });
    const stopMessage = durationSeconds === undefined
      ? "文字起こし中です。確定した文から表示します。終了するにはEnterまたはCtrl+Cを押してください。"
      : `文字起こし中です。確定した文から表示し、${durationSeconds}秒後に停止します。`;
    process.stderr.write(`${stopMessage}\n`);
    process.stderr.write(`保存先: ${rawPath}\n`);
    await recordLockProbe.release();
    recordLockProbe = undefined;
    await captureAudio({
      sessionDirectory,
      durationSeconds,
      showTranscript: true,
      waitForFirstOutput: false,
      recordLockPath: RECORD_LOCK,
      onCaptureReady: async () => {
        await startLock.release();
        startLockReleased = true;
      },
    });
    await validateTranscript(rawPath);
    await writeState("recorded", sessionDirectory, { raw_path: rawPath });
    return rawPath;
  } catch (error) {
    if (sessionDirectory !== undefined) {
      const state = await readState(sessionDirectory);
      if (state.session_dir === sessionDirectory && state.phase !== "failed") {
        await writeState("failed", sessionDirectory, {
          raw_path: join(sessionDirectory, "raw.vtt"),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw error;
  } finally {
    if (recordLockProbe !== undefined) await recordLockProbe.release();
    if (!startLockReleased) await startLock.release();
  }
}

export async function recordInWorker(
  sessionDirectory: string,
  stopSignal: AbortSignal,
  options: Pick<CaptureOptions, "locale" | "onTranscriptChunk"> = {},
): Promise<string> {
  const rawPath = join(sessionDirectory, "raw.vtt");
  await captureAudio({
    sessionDirectory,
    stopSignal,
    showTranscript: false,
    waitForFirstOutput: true,
    ...options,
  });
  await validateTranscript(rawPath);
  return rawPath;
}
