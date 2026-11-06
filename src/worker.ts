import { chmod, open, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { POLL_INTERVAL_MS, PROJECT_DIR, RECORD_LOCK, RUN_DIR, START_LOCK, WORKER_START_TIMEOUT_MS, sessionWorkLockPath } from "./config.ts";
import { startControlServer, sendControl } from "./control.ts";
import { recordInWorker, validateTranscript } from "./capture.ts";
import { prepareNativeCapture } from "./native-capture.ts";
import { acquireProcessLock, isProcessLockActive, tryAcquireProcessLock, type ProcessLock } from "./locks.ts";
import { requireCommand, startCommand, waitForChild } from "./processes.ts";
import { createPrivateSession, deleteCategoryFolder, deleteSessionDirectory, listRecords } from "./storage.ts";
import { analyzeTranscript } from "./summary.ts";
import {
  clearActiveSessionMarker,
  ensureRunDirectory,
  hasSessionStateFile,
  listActiveSessionDirectories,
  localIsoSeconds,
  readState,
  writeState,
} from "./state.ts";
import { getRecognitionLanguage, type AnalysisResult, type PublicStatus, type RecognitionLanguage, type RunPhase, type TranslationMode } from "./domain.ts";
import { startNativeTranslator } from "./native-translation.ts";
import { startLiveTranslation, TRANSLATION_ERROR_FILENAME, TRANSLATION_FILENAME } from "./live-translation.ts";

const RECORDING_START_LOCK_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_SESSION_KEY_LENGTH = 16;

function writeAnalysisDiagnostic(event: string, sessionDirectory: string): void {
  const sessionKey = createHash("sha256").update(sessionDirectory).digest("hex").slice(0, DIAGNOSTIC_SESSION_KEY_LENGTH);
  try {
    process.stderr.write(`[worker-diagnostic] ${JSON.stringify({
      event, timestamp: new Date().toISOString(), pid: process.pid, session_key: sessionKey,
    })}\n`);
  } catch {
    // 診断の書込み失敗で、排他制御の解除や要約処理を止めない。
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForSessionWorker(sessionDirectory: string): Promise<boolean> {
  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  const workLockPath = sessionWorkLockPath(sessionDirectory);
  while (Date.now() < deadline) {
    if (await isProcessLockActive(workLockPath)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return isProcessLockActive(workLockPath);
}

function isCaptureInProgress(phase: string | undefined): boolean {
  return phase === "starting" || phase === "recording" || phase === "stopping";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function notifyCompletion(message: string): Promise<void> {
  if (process.env.VOICE_NOTE_DISABLE_NOTIFICATIONS === "1") return;
  try {
    const processHandle = startCommand(
      "/usr/bin/osascript",
      ["-e", `display notification "${message}" with title "Voice Notes"`],
      { stdio: "ignore" },
    );
    await waitForChild(processHandle, 5_000);
  } catch {
    return;
  }
}

type SessionAnalysisOptions = Readonly<{
  captureFinished?: boolean;
  categoryFolder?: string;
  closeControlServer?: () => Promise<void>;
  sessionWorkLock?: ProcessLock;
}>;

export async function analyzeSessionTranscript(
  sessionDirectory: string,
  rawPath: string,
  options: SessionAnalysisOptions = {},
): Promise<AnalysisResult> {
  await ensureRunDirectory();
  let sessionWorkLock = options.sessionWorkLock;
  const ownsSessionWorkLock = sessionWorkLock === undefined;
  const startLock = await acquireProcessLock(START_LOCK);
  try {
    writeAnalysisDiagnostic("analysis_lock_acquired", sessionDirectory);
    const currentState = await readState(sessionDirectory);
    if (!options.captureFinished && isCaptureInProgress(currentState.phase)) {
      throw new Error("録音が終了するまで要約を開始できません");
    }
    if (sessionWorkLock === undefined) {
      const lockAttempt = await tryAcquireProcessLock(sessionWorkLockPath(sessionDirectory));
      if (lockAttempt.kind === "held") throw new Error("この記録はすでに要約中です");
      sessionWorkLock = lockAttempt.lock;
    }

    const details: Record<string, string> = { raw_path: rawPath };
    if (options.categoryFolder !== undefined) details.category_folder = options.categoryFolder;
    writeAnalysisDiagnostic("analysis_state_write_started", sessionDirectory);
    await writeState("analyzing", sessionDirectory, details);
    writeAnalysisDiagnostic("analysis_state_written", sessionDirectory);
  } catch (error) {
    if (sessionWorkLock !== undefined) {
      const currentState = await readState(sessionDirectory);
      if (currentState.phase === "analyzing") {
        await writeState("failed", sessionDirectory, { error: errorMessage(error) });
      }
      if (ownsSessionWorkLock) {
        await sessionWorkLock.release();
        sessionWorkLock = undefined;
      }
    }
    throw error;
  } finally {
    writeAnalysisDiagnostic("analysis_lock_release_started", sessionDirectory);
    await startLock.release();
    writeAnalysisDiagnostic("analysis_lock_released", sessionDirectory);
  }

  try {
    // 次の録音を妨げないよう、排他制御を解除してから通信の終了を待つ。
    writeAnalysisDiagnostic("control_close_started", sessionDirectory);
    await options.closeControlServer?.();
    writeAnalysisDiagnostic("control_close_completed", sessionDirectory);
    writeAnalysisDiagnostic("summary_started", sessionDirectory);
    const analysis = await analyzeTranscript(rawPath);
    writeAnalysisDiagnostic("summary_completed", sessionDirectory);
    const completionLock = await acquireProcessLock(START_LOCK);
    try {
      writeAnalysisDiagnostic("completion_lock_acquired", sessionDirectory);
      await writeState("completed", sessionDirectory, {
        raw_path: rawPath,
        result_path: analysis.result_path,
        summary_path: analysis.summary_path,
      });
    } finally {
      writeAnalysisDiagnostic("completion_lock_release_started", sessionDirectory);
      await completionLock.release();
      writeAnalysisDiagnostic("completion_lock_released", sessionDirectory);
    }
    return analysis;
  } catch (error) {
    const failureLock = await acquireProcessLock(START_LOCK);
    try {
      const currentState = await readState(sessionDirectory);
      if (currentState.phase === "analyzing") {
        await writeState("failed", sessionDirectory, { error: errorMessage(error) });
      }
    } finally {
      await failureLock.release();
    }
    throw error;
  } finally {
    if (ownsSessionWorkLock) await sessionWorkLock?.release();
  }
}

export async function runWorker(sessionDirectory: string, categoryFolder = "", retry = false): Promise<void> {
  await ensureRunDirectory();
  const sessionWorkLockAttempt = await tryAcquireProcessLock(sessionWorkLockPath(sessionDirectory));
  if (sessionWorkLockAttempt.kind === "held") return;
  let sessionWorkLock: ProcessLock | undefined = sessionWorkLockAttempt.lock;
  const stopController = new AbortController();
  let controlServer: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    const rawPath = join(sessionDirectory, "raw.vtt");
    if (retry) {
      const sessionState = await readState(sessionDirectory);
      if (sessionState.phase !== "failed" && sessionState.phase !== "interrupted") return;
      await validateTranscript(rawPath);
    } else {
      const sessionState = await readState(sessionDirectory);
      if (sessionState.phase !== "starting") return;
      controlServer = await startControlServer(sessionDirectory, () => stopController.abort());
      let translation: Awaited<ReturnType<typeof startLiveTranslation>> | undefined;
      const recognitionLanguage = getRecognitionLanguage({
        recognition_language: sessionState.recognition_language,
        translation_mode: sessionState.translation_mode,
      });
      const translateToJapanese = recognitionLanguage === "en-US" && sessionState.translation_mode === "en-ja";
      if (translateToJapanese) {
        let translator: Awaited<ReturnType<typeof startNativeTranslator>> | undefined;
        try {
          translator = await startNativeTranslator();
          translation = await startLiveTranslation(sessionDirectory, translator);
        } catch (error) {
          await translator?.close();
          await writeFile(join(sessionDirectory, TRANSLATION_ERROR_FILENAME), errorMessage(error), { mode: 0o600 });
        }
      }
      try {
        await recordInWorker(sessionDirectory, stopController.signal, {
          locale: recognitionLanguage,
          onTranscriptChunk: translation?.appendTranscriptChunk,
        });
      } finally {
        await translation?.finish();
      }
    }

    await analyzeSessionTranscript(sessionDirectory, rawPath, {
      captureFinished: !retry,
      categoryFolder,
      sessionWorkLock,
      closeControlServer: async () => {
        if (controlServer === undefined) return;
        const activeControlServer = controlServer;
        await activeControlServer.close();
        controlServer = undefined;
      },
    });
    await sessionWorkLock.release();
    sessionWorkLock = undefined;
    await notifyCompletion("要約が完了しました");
  } catch (error) {
    const currentState = await readState(sessionDirectory);
    const analysisStillRunning = currentState.phase === "analyzing"
      && await isProcessLockActive(sessionWorkLockPath(sessionDirectory));
    if (analysisStillRunning) return;
    if (currentState.phase !== "failed") {
      const failureLock = await acquireProcessLock(START_LOCK);
      try {
        await writeState("failed", sessionDirectory, { error: errorMessage(error) });
      } finally {
        await failureLock.release();
      }
    }
    if (sessionWorkLock !== undefined) {
      await sessionWorkLock.release();
      sessionWorkLock = undefined;
    }
    process.stderr.write(`${errorMessage(error)}\n`);
    await notifyCompletion("文字起こしまたは要約が失敗しました");
  } finally {
    await controlServer?.close();
    await sessionWorkLock?.release();
  }
}

async function launchWorker(sessionDirectory: string, categoryFolder: string, retry: boolean): Promise<void> {
  const logPath = join(RUN_DIR, "worker.log");
  const logFile = await open(logPath, "a", 0o600);
  try {
    await chmod(logPath, 0o600);
    const workerScript = join(PROJECT_DIR, "src", "worker.ts");
    const childArguments = ["run", workerScript, sessionDirectory, categoryFolder];
    if (retry) childArguments.push("--retry");
    const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
    for (const toolDirectory of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      if (!pathEntries.includes(toolDirectory)) pathEntries.push(toolDirectory);
    }
    const childProcess = startCommand(process.execPath, childArguments, {
      cwd: PROJECT_DIR,
      detached: true,
      env: { ...process.env, PATH: pathEntries.join(delimiter) },
      stdio: ["ignore", "ignore", logFile.fd],
    });
    childProcess.once("error", (error) => {
      process.stderr.write(`録音ワーカーを開始できませんでした: ${error.message}\n`);
    });
    childProcess.unref();
  } finally {
    await logFile.close();
  }
}

export async function startCapture(
  outputRoot: string,
  categoryFolder = "",
  translationMode: TranslationMode = "off",
  recognitionLanguage: RecognitionLanguage = getRecognitionLanguage({ translation_mode: translationMode }),
): Promise<string> {
  const effectiveTranslationMode = recognitionLanguage === "en-US" ? translationMode : "off";
  await prepareNativeCapture();
  await requireCommand("codex");
  if (effectiveTranslationMode === "en-ja") {
    const translator = await startNativeTranslator();
    await translator.close();
  }
  await ensureRunDirectory();
  const startLock = await acquireProcessLock(START_LOCK, RECORDING_START_LOCK_TIMEOUT_MS);
  try {
    const active = await sendControl("status");
    if (isCaptureInProgress(active?.phase)) return `処理中です: ${active?.phase ?? "unknown"}`;
    if (
      active?.phase === "analyzing"
      && active.session_dir !== undefined
      && !(await hasSessionStateFile(active.session_dir))
    ) {
      throw new Error("以前の録音の要約処理中です。完了後に録音できます");
    }

    const recordingLockAttempt = await tryAcquireProcessLock(RECORD_LOCK);
    if (recordingLockAttempt.kind === "held") return "処理中です: recording";
    await recordingLockAttempt.lock.release();

    const sessionDirectory = await createPrivateSession(outputRoot);
    const rawPath = join(sessionDirectory, "raw.vtt");
    await writeState("starting", sessionDirectory, {
      category_folder: categoryFolder,
      output_root: dirname(sessionDirectory),
      raw_path: rawPath,
      recognition_language: recognitionLanguage,
      translation_mode: effectiveTranslationMode,
      ...(effectiveTranslationMode === "en-ja" ? { translation_path: join(sessionDirectory, TRANSLATION_FILENAME) } : {}),
    });
    try {
      await launchWorker(sessionDirectory, categoryFolder, false);
    } catch (error) {
      await writeState("failed", sessionDirectory, { error: errorMessage(error) });
      throw error;
    }

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await sendControl("status", sessionDirectory);
      if (state?.session_dir === sessionDirectory) {
        if (state.phase === "recording") return `録音を開始しました: ${sessionDirectory}`;
        if (state.phase === "failed") {
          throw new Error(`録音を開始できませんでした: ${state.error ?? "unknown error"}`);
        }
      }
      await delay(100);
    }

    const activeAfterWait = await sendControl("status", sessionDirectory);
    if (activeAfterWait?.session_dir === sessionDirectory) {
      return `録音を準備中です。状態を確認してください: ${sessionDirectory}`;
    }
    const savedState = await readState(sessionDirectory);
    if (savedState.session_dir === sessionDirectory && savedState.phase === "failed") {
      throw new Error(`録音を開始できませんでした: ${savedState.error ?? "unknown error"}`);
    }
    if (isCaptureInProgress(savedState.phase) && await isProcessLockActive(RECORD_LOCK)) {
      return `録音を準備中です。状態を確認してください: ${sessionDirectory}`;
    }
    await writeState("failed", sessionDirectory, { error: "録音プロセスが準備時間内に開始しませんでした" });
    throw new Error(`録音プロセスを開始できませんでした。ログ: ${join(RUN_DIR, "worker.log")}`);
  } finally {
    await startLock.release();
  }
}

async function waitForSessionCompletion(sessionDirectory: string): Promise<PublicStatus> {
  const terminalPhases = new Set<RunPhase>(["completed", "failed", "interrupted"]);
  while (true) {
    const status = await getPublicStatus(sessionDirectory);
    if (terminalPhases.has(status.phase)) return status;
    await delay(POLL_INTERVAL_MS);
  }
}

export async function stopCapture(wait = false): Promise<string> {
  const currentStatus = await getPublicStatus();
  if (currentStatus.phase === "analyzing") {
    if (!wait) return "録音は停止済みで、要約中です。";
    if (currentStatus.session_dir === undefined) throw new Error("待機中のセッション状態を確認できません");
    const completedStatus = await waitForSessionCompletion(currentStatus.session_dir);
    if (completedStatus.phase === "completed") return `完了: ${completedStatus.summary_path ?? currentStatus.session_dir}`;
    if (completedStatus.phase === "failed") throw new Error(`停止後の処理に失敗しました: ${completedStatus.error ?? "原因不明"}`);
    throw new Error("停止後の処理が中断しました。画面の詳細状態を確認してください");
  }

  const response = currentStatus.session_dir === undefined
    ? undefined
    : await sendControl("stop", currentStatus.session_dir);
  if (response === undefined) throw new Error("録音中のセッションがありません");
  const phase = response.phase;
  if (phase !== "stopping" && phase !== "starting" && phase !== "recording") {
    throw new Error("録音中のセッションがありません");
  }
  if (!wait) {
    return "停止処理を開始しました。要約の結果は画面で確認できます。";
  }

  const sessionDirectory = response.session_dir;
  if (sessionDirectory === undefined) throw new Error("待機中のセッション状態を確認できません");
  const status = await waitForSessionCompletion(sessionDirectory);
  if (status.phase === "completed") return `完了: ${status.summary_path ?? sessionDirectory}`;
  if (status.phase === "failed") throw new Error(`停止後の処理に失敗しました: ${status.error ?? "原因不明"}`);
  throw new Error("停止後の処理が中断しました。画面の詳細状態を確認してください");
}

export async function retryCapture(targetSessionDirectory?: string): Promise<string> {
  await ensureRunDirectory();
  await getPublicStatus();
  const startLock = await acquireProcessLock(START_LOCK);
  try {
    const activeCapture = await sendControl("status");
    if (isCaptureInProgress(activeCapture?.phase) || await isProcessLockActive(RECORD_LOCK)) {
      throw new Error("録音中のセッションがあります");
    }
    const retrySessionDirectory = targetSessionDirectory ?? (await readState()).session_dir;
    if (retrySessionDirectory === undefined) throw new Error("再要約できる原文がありません");
    const savedCaptureState = await readState(retrySessionDirectory);
    if (isCaptureInProgress(savedCaptureState.phase)) {
      if (await isProcessLockActive(sessionWorkLockPath(retrySessionDirectory))) {
        throw new Error("録音中のセッションがあります");
      }
      // 開始ロックはこの処理自身が保持しているため、録音と作業用のロックで停止を確認する。
      await writeState("interrupted", retrySessionDirectory, { error: "録音ワーカーが停止しました" });
    }
    const state = await getPublicStatus(retrySessionDirectory);
    if ((state.phase !== "failed" && state.phase !== "interrupted") || state.raw_path === undefined) {
      throw new Error("再要約できる原文がありません");
    }
    const sessionDirectory = state.session_dir;
    if (sessionDirectory === undefined) throw new Error("再要約できるセッションがありません");
    if (await isProcessLockActive(sessionWorkLockPath(sessionDirectory))) {
      throw new Error("この記録はすでに要約中です");
    }
    const storedSessionState = await readState(sessionDirectory);
    if (storedSessionState.phase === "analyzing") {
      await writeState("interrupted", sessionDirectory, { error: "要約ワーカーが停止しました" });
    }
    const retryableState = await readState(sessionDirectory);
    if (retryableState.phase !== "failed" && retryableState.phase !== "interrupted") {
      throw new Error("再要約できる状態ではありません");
    }
    await launchWorker(sessionDirectory, state.category_folder ?? "", true);
    if (!await waitForSessionWorker(sessionDirectory)) {
      throw new Error(`要約ワーカーが開始しませんでした。ログを確認してください: ${join(RUN_DIR, "worker.log")}`);
    }
    return `原文から要約を再実行します: ${sessionDirectory}`;
  } finally {
    await startLock.release();
  }
}

function isActivePhase(phase: RunPhase): boolean {
  return phase === "starting" || phase === "recording" || phase === "stopping" || phase === "analyzing";
}

function isPathInside(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(parentPath, targetPath);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

export async function deleteRecording(outputRoot: string, sessionDirectory: string): Promise<string> {
  await ensureRunDirectory();
  const startLock = await acquireProcessLock(START_LOCK);
  try {
    const status = await getPublicStatus(sessionDirectory);
    if (isActivePhase(status.phase) || await isProcessLockActive(sessionWorkLockPath(sessionDirectory))) {
      throw new Error("録音中または要約中の記録は削除できません。先に処理を停止してください");
    }
    await deleteSessionDirectory(outputRoot, sessionDirectory);
    await clearActiveSessionMarker(sessionDirectory);
    return "録音と関連ファイルを完全削除しました";
  } finally {
    await startLock.release();
  }
}

export async function deleteFolder(outputRoot: string, relativeFolderPath: string): Promise<string> {
  await ensureRunDirectory();
  const folderPath = resolve(outputRoot, ...relativeFolderPath.replaceAll("\\", "/").split("/"));
  const startLock = await acquireProcessLock(START_LOCK);
  try {
    const records = await listRecords(outputRoot, { recursive: true });
    const nestedRecords = records.filter((record) => isPathInside(folderPath, resolve(record.session_dir)));
    for (const record of nestedRecords) {
      const status = await getPublicStatus(record.session_dir);
      if (isActivePhase(status.phase) || await isProcessLockActive(sessionWorkLockPath(record.session_dir))) {
        throw new Error("録音中または要約中の記録を含むフォルダは削除できません。先に処理を停止してください");
      }
    }
    await deleteCategoryFolder(outputRoot, relativeFolderPath);
    await Promise.all(nestedRecords.map((record) => clearActiveSessionMarker(record.session_dir)));
    return `フォルダと配下のすべてのファイルを完全削除しました: ${relativeFolderPath}`;
  } finally {
    await startLock.release();
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function getActiveAnalysisSessions(): Promise<string[]> {
  const sessionDirectories = await listActiveSessionDirectories();
  const analysisChecks = await Promise.all(sessionDirectories.map(async (sessionDirectory) => ({
    sessionDirectory,
    sessionState: await readState(sessionDirectory),
    workerIsActive: await isProcessLockActive(sessionWorkLockPath(sessionDirectory)),
  })));
  const inactiveAnalysisChecks = analysisChecks.filter((check) => check.sessionState.phase === "analyzing" && !check.workerIsActive);
  const obsoleteMarkers = analysisChecks.filter((check) => !isActivePhase(check.sessionState.phase));
  if (inactiveAnalysisChecks.length > 0 || obsoleteMarkers.length > 0) {
    const startLock = await acquireProcessLock(START_LOCK);
    try {
      for (const check of analysisChecks) {
        const currentState = await readState(check.sessionDirectory);
        if (currentState.phase === "analyzing" && !await isProcessLockActive(sessionWorkLockPath(check.sessionDirectory))) {
          await writeState("interrupted", check.sessionDirectory, { error: "要約ワーカーが停止しました" });
        } else if (!isActivePhase(currentState.phase)) {
          await clearActiveSessionMarker(check.sessionDirectory);
        }
      }
    } finally {
      await startLock.release();
    }
  }
  return analysisChecks
    .filter((check) => check.sessionState.phase === "analyzing" && check.workerIsActive)
    .map((check) => check.sessionDirectory);
}

export async function getPublicStatus(sessionDirectory?: string): Promise<PublicStatus> {
  const stored = await readState(sessionDirectory);
  const targetSessionDirectory = sessionDirectory ?? stored.session_dir;
  const active = targetSessionDirectory === undefined
    ? undefined
    : await sendControl("status", targetSessionDirectory);
  const saved = active ?? stored;
  let phase: RunPhase = saved.phase === "idle" || saved.phase === "starting" || saved.phase === "recording" || saved.phase === "recorded" || saved.phase === "stopping" || saved.phase === "analyzing" || saved.phase === "completed" || saved.phase === "failed" || saved.phase === "interrupted" || saved.phase === "unknown"
    ? saved.phase
    : "unknown";

  if (active === undefined && isCaptureInProgress(phase)) {
    const currentSessionDirectory = (await readState()).session_dir;
    const isLatestSession = currentSessionDirectory === targetSessionDirectory;
    const recordingLockIsActive = isLatestSession && await isProcessLockActive(RECORD_LOCK);
    const startupLockIsActive = isLatestSession && phase === "starting" && await isProcessLockActive(START_LOCK);
    if (!recordingLockIsActive && !startupLockIsActive) {
      phase = "interrupted";
    }
  } else if (
    active === undefined
    && phase === "analyzing"
    && targetSessionDirectory !== undefined
    && !await isProcessLockActive(sessionWorkLockPath(targetSessionDirectory))
  ) {
    phase = "interrupted";
  }

  const status: {
    phase: RunPhase;
    active_analysis_count?: number;
    active_analysis_sessions?: readonly string[];
    session_dir?: string;
    session_id?: string;
    started_at?: string;
    stopped_at?: string;
    category_folder?: string;
    output_root?: string;
    error?: string;
    raw_path?: string;
    result_path?: string;
    summary_path?: string;
    translation_mode?: TranslationMode;
    recognition_language?: RecognitionLanguage;
    translation_path?: string;
  } = { phase };
  status.recognition_language = getRecognitionLanguage(saved);
  if (status.recognition_language === "en-US" && saved.translation_mode === "en-ja") {
    status.translation_mode = "en-ja";
    if (targetSessionDirectory !== undefined) status.translation_path = join(targetSessionDirectory, TRANSLATION_FILENAME);
  }
  if (sessionDirectory === undefined) {
    const activeAnalysisSessions = new Set(await getActiveAnalysisSessions());
    const legacyAnalysisIsActive = active?.phase === "analyzing"
      && targetSessionDirectory !== undefined
      && !(await hasSessionStateFile(targetSessionDirectory));
    if (legacyAnalysisIsActive && targetSessionDirectory !== undefined) activeAnalysisSessions.add(targetSessionDirectory);
    status.active_analysis_sessions = [...activeAnalysisSessions];
    status.active_analysis_count = activeAnalysisSessions.size;
  }
  const statusFieldKeys: readonly ("session_dir" | "started_at" | "stopped_at" | "category_folder" | "output_root" | "error")[] = [
    "session_dir",
    "started_at",
    "stopped_at",
    "category_folder",
    "output_root",
    "error",
  ];
  for (const key of statusFieldKeys) {
    if (saved[key]) status[key] = saved[key];
  }
  if (saved.session_dir) status.session_id = basename(saved.session_dir);
  const pathFieldKeys: readonly ("raw_path" | "result_path" | "summary_path")[] = ["raw_path", "result_path", "summary_path"];
  for (const key of pathFieldKeys) {
    const path = saved[key];
    if (path && await isFile(path)) status[key] = path;
  }
  if (saved.session_dir && status.raw_path === undefined) {
    const rawPath = join(saved.session_dir, "raw.vtt");
    if (await isFile(rawPath)) status.raw_path = rawPath;
  }
  if (status.stopped_at === undefined && (phase === "completed" || phase === "failed") && status.raw_path !== undefined) {
    const rawStat = await stat(status.raw_path);
    status.stopped_at = localIsoSeconds(rawStat.mtime);
  }
  return status;
}

export async function showStatus(): Promise<string> {
  const status = await getPublicStatus();
  const phaseLabels: Readonly<Record<RunPhase, string>> = {
    idle: "待機中",
    starting: "録音準備中",
    recording: "録音中",
    recorded: "文字起こし完了",
    stopping: "録音停止中",
    analyzing: "要約中",
    completed: "完了",
    failed: "失敗",
    interrupted: "中断",
    unknown: "状態不明",
  };
  const detail = status.summary_path ?? status.error ?? status.session_dir ?? "";
  const label = phaseLabels[status.phase];
  const activeAnalysisCount = status.active_analysis_count ?? 0;
  const analysisLabel = activeAnalysisCount === 0
    ? ""
    : status.phase === "analyzing"
      ? `: ${activeAnalysisCount}件`
      : `（要約中の記録: ${activeAnalysisCount}件）`;
  return detail ? `${label}${analysisLabel}: ${detail}` : `${label}${analysisLabel}`;
}

export async function startWorkerEntry(argumentsList: readonly string[]): Promise<number> {
  process.umask(0o077);
  const [sessionDirectory, categoryFolder = "", retryFlag] = argumentsList;
  if (sessionDirectory === undefined) {
    process.stderr.write("session directory is required\n");
    return 2;
  }
  await runWorker(sessionDirectory, categoryFolder, retryFlag === "--retry");
  return 0;
}

export function isWorkerEntry(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isWorkerEntry()) {
  void startWorkerEntry(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
