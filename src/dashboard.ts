import {
  BoxRenderable,
  CliRenderEvents,
  InputRenderable,
  InputRenderableEvents,
  MouseButton,
  ScrollBoxRenderable,
  TextRenderable,
  createCliRenderer,
} from "@opentui/core";
import { open, readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { basename, join, relative } from "node:path";
import { deleteFolder, deleteRecording, getPublicStatus, retryCapture, startCapture, stopCapture } from "./worker.ts";
import {
  createChildFolder,
  listNestedFolders,
  listRecords,
} from "./storage.ts";
import { getRecognitionLanguage, type PublicStatus, type RecognitionLanguage, type TranslationMode, type VoiceNoteRecord } from "./domain.ts";
import { openDirectoryInFinder } from "./processes.ts";
import { TRANSLATION_ERROR_FILENAME } from "./live-translation.ts";

type DashboardView = "home" | "history" | "detail" | "live" | "status";
type HomePanel = "folders" | "notes";
type FolderItem = Readonly<{ name: string; path: string | null; relativePath: string }>;
type PromptAction = (value: string) => Promise<void>;
type Confirmation = Readonly<{ action: () => Promise<string>; fallbackNotice: string }>;
type DashboardRow = Readonly<{ box: BoxRenderable; text: TextRenderable }>;
type DashboardButton = Readonly<{ label: TextRenderable }>;

const COLORS: Readonly<{
  background: string;
  panel: string;
  selected: string;
  text: string;
  muted: string;
  accent: string;
  success: string;
  warning: string;
  border: string;
  error: string;
}> = {
  background: "#071421",
  panel: "#0B1C2B",
  selected: "#1D4361",
  text: "#D7E2EA",
  muted: "#8496A5",
  accent: "#68B8FF",
  success: "#71D6A2",
  warning: "#F4BE67",
  border: "#30495D",
  error: "#FF8585",
};

function formatElapsed(startedAt: string | undefined, stoppedAt: string | undefined, phase: string): string {
  if (startedAt === undefined) return "";
  const start = Date.parse(startedAt);
  const end = stoppedAt === undefined
    ? phase === "recording" || phase === "starting" || phase === "stopping"
      ? Date.now()
      : start
    : Date.parse(stoppedAt);
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function statusLabel(status: PublicStatus): string {
  const labels: Readonly<Record<PublicStatus["phase"], string>> = {
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
  return labels[status.phase];
}

function formatStatusLine(status: PublicStatus): string {
  const duration = formatElapsed(status.started_at, status.stopped_at, status.phase);
  const sessionId = status.session_id ?? "なし";
  const statusText = duration
    ? `${statusLabel(status)}  ${duration}   セッション: ${sessionId}`
    : `${statusLabel(status)}   セッション: ${sessionId}`;
  const activeAnalysisCount = status.active_analysis_count ?? 0;
  if (activeAnalysisCount === 0) return statusText;
  if (status.phase === "analyzing") return `要約中: ${activeAnalysisCount}件  ${duration}   セッション: ${sessionId}`;
  return `${statusText}   要約中の記録: ${activeAnalysisCount}件`;
}

function transcriptPreview(rawText: string | undefined): string[] {
  if (rawText === undefined) return [];
  return rawText.split(/\r?\n/u).flatMap((line) => {
    if (line.startsWith("<v Mic>")) {
      return [`マイク: ${line.slice("<v Mic>".length).replace("</v>", "").trim()}`];
    }
    if (line.startsWith("<v System>")) {
      return [`再生音: ${line.slice("<v System>".length).replace("</v>", "").trim()}`];
    }
    return [];
  });
}

function recordTime(record: VoiceNoteRecord): string {
  const date = new Date(record.started_at);
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export async function runDashboard(outputRoot: string, initialFolder?: string): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 15, useMouse: true });
  let view: DashboardView = "home";
  let returnView: Exclude<DashboardView, "detail" | "live" | "status"> = "home";
  let statusReturnView: Exclude<DashboardView, "status"> = "home";
  let dashboardRecordingStartInFlight = false;
  let translationMode: TranslationMode = "off";
  let recognitionLanguage: RecognitionLanguage = "ja-JP";
  let folders: FolderItem[] = [{ name: "すべてのノート", path: null, relativePath: "" }];
  let records: VoiceNoteRecord[] = [];
  let status: PublicStatus = { phase: "idle" };
  let selectedFolderIndex = 0;
  let selectedRecordIndex = 0;
  let activeHomePanel: HomePanel = "folders";
  let selectedRecord: VoiceNoteRecord | undefined;
  let selectedRecordStatus: PublicStatus | undefined;
  let selectedSummaryRetryInFlight = false;
  let showSummary = true;
  let lastRefreshedCompletionSession: string | undefined;
  let lastObservedActiveAnalysisSessions = new Set<string>();
  let completionRefreshInFlight = false;
  let historyCategory: string | undefined;
  let historySearch = "";
  let notice = "";
  let shell: BoxRenderable | undefined;
  let statusText: TextRenderable | undefined;
  let transcriptPathText: TextRenderable | undefined;
  let modal: BoxRenderable | undefined;
  let activeInput: InputRenderable | undefined;
  let folderScroll: ScrollBoxRenderable | undefined;
  let recordScroll: ScrollBoxRenderable | undefined;
  let homeFolderRows: DashboardRow[] = [];
  let homeNoteRows: DashboardRow[] = [];
  let homeFolderPanel: BoxRenderable | undefined;
  let homeNotePanel: BoxRenderable | undefined;
  let homeNoteTitle: TextRenderable | undefined;
  let homeNoteRowsContainer: BoxRenderable | undefined;
  let homeDeleteButton: DashboardButton | undefined;
  let homeOpenButton: DashboardButton | undefined;
  let historyScroll: ScrollBoxRenderable | undefined;
  let detailScroll: ScrollBoxRenderable | undefined;
  let liveTranscriptScroll: ScrollBoxRenderable | undefined;
  let liveTranscriptText: TextRenderable | undefined;
  let liveTranscriptContent = "";
  let liveTranscriptPath: string | undefined;
  let liveTranscriptOffset = 0;
  let liveTranscriptDecoder = new StringDecoder("utf8");
  let liveTranscriptPendingLine = "";
  let liveTranscriptLines: string[] = [];
  let liveTranscriptDecoderEnded = false;
  let liveTranscriptRefreshInFlight = false;
  let liveTranslationText: TextRenderable | undefined;
  let liveTranslationScroll: ScrollBoxRenderable | undefined;
  let liveTranslationContent = "";
  let liveTranslationRefreshInFlight = false;
  let confirmation: Confirmation | undefined;

  async function refreshData(): Promise<void> {
    const folderPaths = await listNestedFolders(outputRoot);
    folders = [
      { name: "すべてのノート", path: null, relativePath: "" },
      ...folderPaths.map((folderPath) => ({
        name: basename(folderPath),
        path: folderPath,
        relativePath: relative(outputRoot, folderPath).split(/[\\/]/u).join("/"),
      })),
    ];
    records = await listRecords(outputRoot, { recursive: true });
    if (selectedRecord !== undefined) {
      const selectedSessionDirectory = selectedRecord.session_dir;
      selectedRecord = records.find((record) => record.session_dir === selectedSessionDirectory);
      await refreshSelectedRecordStatus();
    }
    status = await getPublicStatus();
    lastObservedActiveAnalysisSessions = new Set(status.active_analysis_sessions ?? []);
    if (status.phase === "completed") lastRefreshedCompletionSession = status.session_dir;
    if (initialFolder !== undefined && selectedFolderIndex === 0) {
      const normalizedInitialFolder = initialFolder.replaceAll("\\", "/");
      const initialIndex = folders.findIndex((folder) => folder.relativePath === normalizedInitialFolder);
      if (initialIndex >= 0) selectedFolderIndex = initialIndex;
    }
    selectedRecordIndex = Math.min(selectedRecordIndex, Math.max(0, records.length - 1));
  }

  async function refreshDashboardAfterCompletion(): Promise<void> {
    await refreshData();
    if (selectedRecord === undefined && view === "detail") view = returnView;
    if (renderer.isDestroyed) return;
    render();
    if (view === "live") await refreshLiveView(status);
  }

  function addText(parent: BoxRenderable, content: string, color = COLORS.text, height: number | "auto" = 1): TextRenderable {
    const text = new TextRenderable(renderer, {
      content,
      fg: color,
      width: "100%",
      height,
      flexShrink: height === "auto" ? 0 : undefined,
      wrapMode: "word",
    });
    parent.add(text);
    return text;
  }

  function makePanel(title: string, width: number | `${number}%`, panelBorderColor = COLORS.border): BoxRenderable {
    const panel = new BoxRenderable(renderer, {
      width,
      height: "100%",
      border: true,
      borderColor: panelBorderColor,
      backgroundColor: COLORS.panel,
      padding: 1,
      flexDirection: "column",
      gap: 1,
      minHeight: 0,
    });
    addText(panel, title, COLORS.accent);
    return panel;
  }

  function makeButton(parent: BoxRenderable, label: string, action: () => void, tone = COLORS.text): DashboardButton {
    const button = new BoxRenderable(renderer, {
      height: 3,
      width: "auto",
      border: true,
      borderColor: COLORS.border,
      backgroundColor: COLORS.panel,
      paddingX: 1,
      justifyContent: "center",
      onMouseDown(event) {
        if (event.button === MouseButton.LEFT) action();
      },
    });
    const labelText = new TextRenderable(renderer, { content: label, fg: tone, height: 1 });
    button.add(labelText);
    parent.add(button);
    return { label: labelText };
  }

  function makeRow(parent: BoxRenderable, label: string, selected: boolean, action: () => void, color = COLORS.text): DashboardRow {
    const row = new BoxRenderable(renderer, {
      width: "100%",
      height: 1,
      backgroundColor: selected ? COLORS.selected : COLORS.panel,
      onMouseDown(event) {
        if (event.button === MouseButton.LEFT) action();
      },
    });
    const text = new TextRenderable(renderer, {
      content: label,
      fg: color,
      width: "100%",
      height: 1,
      truncate: true,
    });
    row.add(text);
    parent.add(row);
    return { box: row, text };
  }

  function currentFolder(): FolderItem {
    return folders[Math.min(selectedFolderIndex, folders.length - 1)] ?? folders[0]!;
  }

  function currentFolderRecords(): VoiceNoteRecord[] {
    return records.filter((record) => record.category_folder === currentFolder().relativePath);
  }

  function visibleHistoryRecords(): VoiceNoteRecord[] {
    return records.filter((record) => {
      const matchesCategory = historyCategory === undefined || record.category_folder === historyCategory;
      const searchValue = `${record.title} ${record.category_folder} ${record.session_id}`.toLocaleLowerCase("ja");
      return matchesCategory && searchValue.includes(historySearch.toLocaleLowerCase("ja"));
    });
  }

  async function openSelectedFolderInFinder(): Promise<void> {
    let folderPath: string;
    if (view === "home") {
      folderPath = activeHomePanel === "notes"
        ? currentFolderRecords()[selectedRecordIndex]?.session_dir ?? currentFolder().path ?? outputRoot
        : currentFolder().path ?? outputRoot;
    } else if (view === "history") {
      folderPath = visibleHistoryRecords()[selectedRecordIndex]?.session_dir ?? outputRoot;
    } else if (view === "detail") {
      folderPath = selectedRecord?.session_dir ?? outputRoot;
    } else {
      folderPath = status.session_dir ?? outputRoot;
    }
    try {
      await openDirectoryInFinder(folderPath);
    } catch (error) {
      if (renderer.isDestroyed) return;
      notice = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function updateHomeRowSelection(): void {
    homeFolderRows.forEach((row, index) => {
      const selected = index === selectedFolderIndex;
      row.box.backgroundColor = selected ? COLORS.selected : COLORS.panel;
      row.text.fg = selected ? COLORS.text : COLORS.muted;
    });
    homeNoteRows.forEach((row, index) => {
      row.box.backgroundColor = index === selectedRecordIndex ? COLORS.selected : COLORS.panel;
    });
  }

  function updateHomeControls(): void {
    if (homeDeleteButton === undefined || homeOpenButton === undefined) return;

    if (activeHomePanel === "folders") {
      const canDeleteFolder = currentFolder().path !== null;
      homeDeleteButton.label.content = canDeleteFolder ? "フォルダ削除 [d]" : "削除不可 [d]";
      homeDeleteButton.label.fg = canDeleteFolder ? COLORS.error : COLORS.muted;
      homeOpenButton.label.content = "ノート欄へ [Enter]";
      homeOpenButton.label.fg = COLORS.success;
      return;
    }

    const hasSelectedNote = currentFolderRecords()[selectedRecordIndex] !== undefined;
    homeDeleteButton.label.content = "ノート削除 [d]";
    homeDeleteButton.label.fg = hasSelectedNote ? COLORS.error : COLORS.muted;
    homeOpenButton.label.content = hasSelectedNote ? "ノートを開く [Enter]" : "ノートなし [Enter]";
    homeOpenButton.label.fg = hasSelectedNote ? COLORS.success : COLORS.muted;
  }

  function updateHomePanelFocus(): void {
    if (homeFolderPanel !== undefined) {
      homeFolderPanel.borderColor = activeHomePanel === "folders" ? COLORS.accent : COLORS.border;
    }
    if (homeNotePanel !== undefined) {
      homeNotePanel.borderColor = activeHomePanel === "notes" ? COLORS.accent : COLORS.border;
    }
    updateHomeControls();
    renderer.requestRender();
  }

  function scrollSelectionIntoView(scroll: ScrollBoxRenderable | undefined, selectedIndex: number): void {
    if (scroll === undefined) return;
    const viewportHeight = Math.max(1, Math.floor(scroll.viewport.height));
    if (selectedIndex < scroll.scrollTop) {
      scroll.scrollTo({ x: 0, y: selectedIndex });
    } else if (selectedIndex >= scroll.scrollTop + viewportHeight) {
      scroll.scrollTo({ x: 0, y: selectedIndex - viewportHeight + 1 });
    }
  }

  function refreshHomeNotes(): void {
    if (homeNoteRowsContainer === undefined || recordScroll === undefined) return;
    const rowsContainer = homeNoteRowsContainer;

    for (const child of rowsContainer.getChildren()) {
      rowsContainer.remove(child);
      child.destroyRecursively();
    }
    const folder = currentFolder();
    const folderRecords = currentFolderRecords();
    if (homeNoteTitle !== undefined) homeNoteTitle.content = `${folder.name} (${folderRecords.length})`;
    if (folderRecords.length === 0) {
      addText(rowsContainer, "このフォルダには記録がありません。", COLORS.muted);
      homeNoteRows = [];
    } else {
      homeNoteRows = folderRecords.map((record, index) => makeRow(
        rowsContainer,
        `${recordTime(record)}  ${record.title}`,
        index === selectedRecordIndex,
        () => {
          selectedRecordIndex = index;
          activeHomePanel = "notes";
          updateHomeRowSelection();
          updateHomePanelFocus();
        },
      ));
    }
    if (recordScroll.scrollTop !== 0) recordScroll.scrollTop = 0;
    updateHomeControls();
  }

  function setSelectedRecord(record: VoiceNoteRecord, sourceView: Exclude<DashboardView, "detail" | "live" | "status">): void {
    selectedRecord = record;
    selectedRecordStatus = undefined;
    returnView = sourceView;
    view = "detail";
    showSummary = record.summary_path !== undefined;
    render();
    void refreshSelectedRecordStatus().then(() => {
      if (!renderer.isDestroyed && view === "detail") render();
    }).catch((error: unknown) => {
      notice = error instanceof Error ? error.message : String(error);
      if (!renderer.isDestroyed) render();
    });
  }

  async function refreshSelectedRecordStatus(): Promise<boolean> {
    const record = selectedRecord;
    if (record === undefined) return false;
    const nextStatus = await getPublicStatus(record.session_dir);
    if (renderer.isDestroyed || selectedRecord?.session_dir !== record.session_dir) return false;
    const changed = JSON.stringify(selectedRecordStatus) !== JSON.stringify(nextStatus);
    selectedRecordStatus = nextStatus;
    return changed;
  }

  function openStatusView(): void {
    if (view === "status") return;
    statusReturnView = view;
    view = "status";
    render();
  }

  async function runAction(action: () => Promise<string>, fallbackNotice: string): Promise<void> {
    const actionView = view;
    const actionSessionId = status.session_id;
    notice = fallbackNotice;
    render();
    let actionNotice: string;
    try {
      actionNotice = await action();
    } catch (error) {
      actionNotice = error instanceof Error ? error.message : String(error);
    }
    if (renderer.isDestroyed) return;
    await refreshData();
    if (renderer.isDestroyed) return;
    if (view === actionView && status.session_id === actionSessionId) notice = actionNotice;
    render();
  }

  function canRetryCurrentSummary(): boolean {
    return (status.phase === "failed" || status.phase === "interrupted")
      && status.raw_path !== undefined
      && status.session_dir !== undefined;
  }

  function retryCurrentSummary(): void {
    if (!canRetryCurrentSummary()) return;
    void runAction(
      () => retryCapture(),
      "保存済みの文字起こしから要約を再実行しています...",
    );
  }

  function canRetrySelectedSummary(): boolean {
    return !selectedSummaryRetryInFlight
      && (selectedRecordStatus?.phase === "failed" || selectedRecordStatus?.phase === "interrupted")
      && selectedRecordStatus.raw_path !== undefined
      && selectedRecordStatus.session_dir === selectedRecord?.session_dir;
  }

  function retrySelectedSummary(): void {
    const record = selectedRecord;
    if (record === undefined || !canRetrySelectedSummary()) return;
    selectedSummaryRetryInFlight = true;
    void runAction(
      () => retryCapture(record.session_dir),
      "保存済みの文字起こしから要約を再実行しています...",
    ).finally(() => {
      selectedSummaryRetryInFlight = false;
      if (!renderer.isDestroyed && view === "detail") render();
    });
  }

  async function startDashboardRecording(): Promise<void> {
    if (dashboardRecordingStartInFlight) return;
    dashboardRecordingStartInFlight = true;
    const folder = currentFolder();
    view = "live";
    status = { phase: "starting", translation_mode: translationMode, recognition_language: recognitionLanguage };
    resetLiveTranscript();
    notice = translationMode === "en-ja" ? "英語→日本語の翻訳を準備しています..." : "録音を開始しています...";
    render();

    let startError: unknown;
    try {
      await startCapture(folder.path ?? outputRoot, folder.relativePath, translationMode, recognitionLanguage);
      notice = "";
    } catch (error) {
      startError = error;
    }
    try {
      await refreshData();
    } catch (error) {
      startError ??= error;
    }

    dashboardRecordingStartInFlight = false;
    if (renderer.isDestroyed) return;
    if (startError !== undefined) {
      const errorMessage = startError instanceof Error ? startError.message : String(startError);
      notice = `録音を開始できませんでした: ${errorMessage}`;
      view = "home";
    } else if (status.phase !== "starting" && status.phase !== "recording") {
      if (status.phase === "failed") notice = status.error ?? notice;
      view = "home";
    }
    render();
  }

  function beginDashboardRecording(): void {
    void startDashboardRecording();
  }

  function toggleRecognitionLanguage(): void {
    if (dashboardRecordingStartInFlight || ["starting", "recording", "stopping"].includes(status.phase)) {
      notice = "認識言語は録音を停止してから変更してください";
    } else {
      recognitionLanguage = recognitionLanguage === "ja-JP" ? "en-US" : "ja-JP";
      if (recognitionLanguage === "ja-JP") {
        translationMode = "off";
        notice = "次の録音は日本語で認識します。同時翻訳は英語→日本語のみのためオフにしました";
      } else notice = "次の録音は英語で認識します。日本語訳が必要なら同時翻訳をオンにしてください";
    }
    render();
  }

  function toggleTranslationMode(): void {
    if (dashboardRecordingStartInFlight || ["starting", "recording", "stopping"].includes(status.phase)) {
      notice = "翻訳の設定は録音を停止してから変更してください";
    } else if (recognitionLanguage !== "en-US") {
      notice = "同時翻訳は英語→日本語に対応しています。先に認識言語を英語にしてください [l]";
    } else {
      translationMode = translationMode === "off" ? "en-ja" : "off";
      notice = translationMode === "en-ja" ? "次の録音では英語の原文と日本語訳を表示します" : "次の録音では英語の原文だけを表示します";
    }
    render();
  }

  async function refreshLiveView(nextStatus: PublicStatus): Promise<void> {
    await refreshLiveTranscript(nextStatus);
    const translationText = liveTranslationText;
    const translationPath = nextStatus.translation_path;
    const sessionDirectory = nextStatus.session_dir;
    if (view !== "live" || translationText === undefined || translationPath === undefined || sessionDirectory === undefined || liveTranslationRefreshInFlight) return;
    liveTranslationRefreshInFlight = true;
    try {
      const [translated, error] = await Promise.all([
        readFile(translationPath, "utf8").catch(() => ""),
        readFile(join(sessionDirectory, TRANSLATION_ERROR_FILENAME), "utf8").catch(() => ""),
      ]);
      if (renderer.isDestroyed || view !== "live" || status.session_dir !== sessionDirectory || liveTranslationText !== translationText) return;
      const body = transcriptPreview(translated).join("\n");
      const content = error ? `${body}\n\n翻訳を停止しました: ${error}`.trim() : body || "日本語訳を待っています...";
      if (content === liveTranslationContent) return;
      liveTranslationContent = content;
      translationText.content = content;
      liveTranslationScroll?.scrollTo({ x: 0, y: liveTranslationScroll.scrollHeight });
      renderer.requestRender();
    } finally {
      liveTranslationRefreshInFlight = false;
    }
  }

  async function refreshLiveTranscript(nextStatus: PublicStatus): Promise<void> {
    if (view !== "live" || nextStatus.raw_path === undefined || liveTranscriptRefreshInFlight) return;
    const transcriptText = liveTranscriptText;
    if (transcriptText === undefined) return;

    const rawPath = nextStatus.raw_path;
    if (liveTranscriptPath !== rawPath) {
      resetLiveTranscript(rawPath);
    }

    liveTranscriptRefreshInFlight = true;
    try {
      const fileStat = await stat(rawPath).catch(() => undefined);
      if (fileStat === undefined) return;
      if (fileStat.size < liveTranscriptOffset) resetLiveTranscript(rawPath);

      const newByteCount = fileStat.size - liveTranscriptOffset;
      if (newByteCount > 0) {
        const transcriptFile = await open(rawPath, "r");
        try {
          const buffer = Buffer.alloc(newByteCount);
          const { bytesRead } = await transcriptFile.read(buffer, 0, newByteCount, liveTranscriptOffset);
          liveTranscriptOffset += bytesRead;
          const decodedText = liveTranscriptDecoder.write(buffer.subarray(0, bytesRead));
          const completedLines = `${liveTranscriptPendingLine}${decodedText}`.split(/\r?\n/u);
          liveTranscriptPendingLine = completedLines.pop() ?? "";
          liveTranscriptLines.push(...completedLines.flatMap(transcriptPreview));
        } finally {
          await transcriptFile.close();
        }
      }

      if ((nextStatus.phase === "recorded" || nextStatus.phase === "completed" || nextStatus.phase === "failed" || nextStatus.phase === "interrupted") && !liveTranscriptDecoderEnded) {
        liveTranscriptPendingLine += liveTranscriptDecoder.end();
        liveTranscriptDecoderEnded = true;
      }

      if (view !== "live" || renderer.isDestroyed || liveTranscriptText !== transcriptText || status.raw_path !== rawPath) return;
      const visibleLines = [...liveTranscriptLines, ...transcriptPreview(liveTranscriptPendingLine)];
      const nextContent = visibleLines.join("\n") || "文字起こしを待っています...";
      if (nextContent === liveTranscriptContent) return;
      liveTranscriptContent = nextContent;
      transcriptText.content = nextContent;
      liveTranscriptScroll?.scrollTo({ x: 0, y: liveTranscriptScroll.scrollHeight });
      renderer.requestRender();
    } finally {
      liveTranscriptRefreshInFlight = false;
    }
  }

  function resetLiveTranscript(path?: string): void {
    liveTranscriptPath = path;
    liveTranscriptOffset = 0;
    liveTranscriptDecoder = new StringDecoder("utf8");
    liveTranscriptPendingLine = "";
    liveTranscriptLines = [];
    liveTranscriptDecoderEnded = false;
    liveTranscriptContent = "";
    liveTranslationContent = "";
  }

  function closeModal(): void {
    if (modal !== undefined) {
      renderer.root.remove(modal);
      modal.destroyRecursively();
      modal = undefined;
      activeInput = undefined;
      confirmation = undefined;
      render();
    }
  }

  function confirmPendingAction(): void {
    if (confirmation === undefined) return;
    const pendingAction = confirmation;
    closeModal();
    void runAction(pendingAction.action, pendingAction.fallbackNotice);
  }

  function openTextPrompt(title: string, placeholder: string, submitAction: PromptAction): void {
    if (modal !== undefined) closeModal();
    const overlay = new BoxRenderable(renderer, {
      position: "absolute",
      left: "15%",
      top: "40%",
      width: "70%",
      height: 6,
      zIndex: 50,
      border: true,
      borderColor: COLORS.accent,
      backgroundColor: COLORS.panel,
      padding: 1,
      flexDirection: "column",
      gap: 1,
    });
    addText(overlay, title, COLORS.accent);
    const input = new InputRenderable(renderer, {
      width: "100%",
      placeholder,
      focusedBackgroundColor: COLORS.selected,
      textColor: COLORS.text,
      cursorColor: COLORS.accent,
    });
    overlay.add(input);
    addText(overlay, "決定 [Enter] / キャンセル [Esc]", COLORS.muted);
    input.on(InputRenderableEvents.ENTER, () => {
      const value = input.value.trim();
      closeModal();
      if (value) void submitAction(value);
    });
    modal = overlay;
    activeInput = input;
    render();
    input.focus();
  }

  async function createFolder(name: string): Promise<void> {
    try {
      const parentFolder = currentFolder().path ?? outputRoot;
      await createChildFolder(parentFolder, name);
      notice = `フォルダを作成しました: ${name}`;
      selectedFolderIndex = 0;
      selectedRecordIndex = 0;
      activeHomePanel = "folders";
      await refreshData();
      const createdIndex = folders.findIndex((folder) => folder.path === join(parentFolder, name));
      if (createdIndex >= 0) selectedFolderIndex = createdIndex;
      render();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  function openFolderPrompt(): void {
    openTextPrompt("新しいフォルダ", "フォルダ名を入力", createFolder);
  }

  function openSearchPrompt(): void {
    openTextPrompt("記録を検索", "タイトル・分類・セッションID", async (value) => {
      historySearch = value;
      selectedRecordIndex = 0;
      render();
    });
  }

  function openConfirmationPrompt(
    title: string,
    message: string,
    action: () => Promise<string>,
    fallbackNotice: string,
  ): void {
    if (modal !== undefined) closeModal();
    const overlay = new BoxRenderable(renderer, {
      position: "absolute",
      left: "10%",
      top: "35%",
      width: "80%",
      height: 10,
      zIndex: 50,
      border: true,
      borderColor: COLORS.error,
      backgroundColor: COLORS.panel,
      padding: 1,
      flexDirection: "column",
      gap: 1,
    });
    addText(overlay, title, COLORS.error);
    addText(overlay, message, COLORS.text, 4);
    const buttons = new BoxRenderable(renderer, { width: "100%", height: "auto", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", gap: 1 });
    makeButton(buttons, "完全削除 [Enter]", confirmPendingAction, COLORS.error);
    makeButton(buttons, "キャンセル [Esc]", closeModal, COLORS.muted);
    overlay.add(buttons);
    modal = overlay;
    confirmation = { action, fallbackNotice };
    render();
  }

  function requestDeleteRecording(record: VoiceNoteRecord): void {
    openConfirmationPrompt(
      "録音を完全削除",
      `「${record.title}」（${record.session_id}）の録音フォルダ内にある全ファイルを完全削除します。\n原文、修正結果、要約も削除され、この操作は取り消せません。`,
      async () => {
        await deleteRecording(outputRoot, record.session_dir);
        if (view === "detail") view = returnView;
        selectedRecord = undefined;
        selectedRecordIndex = 0;
        return `録音を完全削除しました: ${record.title}`;
      },
      "録音を削除しています...",
    );
  }

  async function requestDeleteFolder(): Promise<void> {
    const folder = currentFolder();
    if (folder.path === null) return;

    try {
      openConfirmationPrompt(
        "フォルダを完全削除",
        `「${folder.relativePath}」と配下のフォルダ、録音を含むすべてのファイルを完全削除します。\nこの操作は取り消せません。`,
        async () => {
          const message = await deleteFolder(outputRoot, folder.relativePath);
          const parentPath = folder.relativePath.split("/").slice(0, -1).join("/");
          const parentIndex = folders.findIndex((candidate) => candidate.relativePath === parentPath);
          selectedFolderIndex = parentIndex >= 0 ? parentIndex : 0;
          selectedRecordIndex = 0;
          return message;
        },
        "フォルダと配下の記録を削除しています...",
      );
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
      render();
    }
  }

  async function loadRecordPreview(record: VoiceNoteRecord): Promise<string[]> {
    if (showSummary) {
      if (record.summary_path === undefined) return ["要約は未作成です"];
      try {
        return (await readFile(record.summary_path, "utf8")).split(/\r?\n/u);
      } catch {
        return ["要約を読み込めませんでした"];
      }
    }
    if (record.raw_path === undefined) return ["文字起こしは未作成です"];
    try {
      const rawText = await readFile(record.raw_path, "utf8");
      return record.raw_path.endsWith(".vtt")
        ? transcriptPreview(rawText)
        : rawText.split(/\r?\n/u);
    } catch {
      return ["文字起こしを読み込めませんでした"];
    }
  }

  function render(): void {
    if (shell !== undefined) {
      renderer.root.remove(shell);
      shell.destroyRecursively();
    }
    folderScroll = undefined;
    recordScroll = undefined;
    homeFolderRows = [];
    homeNoteRows = [];
    homeFolderPanel = undefined;
    homeNotePanel = undefined;
    homeNoteTitle = undefined;
    homeNoteRowsContainer = undefined;
    homeDeleteButton = undefined;
    homeOpenButton = undefined;
    historyScroll = undefined;
    detailScroll = undefined;
    liveTranscriptScroll = undefined;
    liveTranscriptText = undefined;
    liveTranslationText = undefined;
    liveTranslationScroll = undefined;

    const nextShell = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      paddingX: 1,
      paddingY: 0,
      gap: 1,
      backgroundColor: COLORS.background,
    });
    shell = nextShell;

    statusText = undefined;
    transcriptPathText = undefined;
    if (view !== "detail") {
      const headerHeight = view === "live" ? 8 : view === "status" ? 3 : 5;
      const header = new BoxRenderable(renderer, {
        width: "100%",
        height: headerHeight,
        flexDirection: "column",
        justifyContent: "space-between",
        paddingY: 1,
      });
      const title = view === "home"
        ? "Voice Notes / ホーム"
        : view === "history"
          ? "Voice Notes / 全記録"
          : view === "live"
            ? "Voice Notes / ライブ文字起こし"
            : "Voice Notes / 状態";
      addText(header, title, COLORS.text);
      if (view === "live") {
        statusText = addText(header, formatStatusLine(status), status.phase === "failed" ? COLORS.error : COLORS.muted);
        addText(header, `認識言語: ${getRecognitionLanguage(status) === "en-US" ? "英語" : "日本語"} / 同時翻訳: ${status.translation_mode === "en-ja" ? "英語→日本語" : "オフ"}`, COLORS.muted);
        addText(header, `保存先: ${outputRoot}`, COLORS.muted);
        transcriptPathText = addText(header, `文字起こしファイル: ${status.raw_path ?? "未作成"}`, COLORS.muted, 2);
      } else if (view === "home" || view === "history") {
        statusText = addText(header, formatStatusLine(status), status.phase === "failed" ? COLORS.error : COLORS.muted);
        addText(header, `保存先: ${outputRoot}`, COLORS.muted);
      }

      const actions = new BoxRenderable(renderer, { width: "100%", height: "auto", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", gap: 1 });
      if (view === "live") {
        if (canRetryCurrentSummary()) {
          makeButton(actions, "要約を再実行 [r]", retryCurrentSummary, COLORS.accent);
        } else if (status.phase === "starting" || status.phase === "recording" || status.phase === "stopping" || status.phase === "analyzing") {
          makeButton(actions, "■ 録音停止 [s]", () => {
            void runAction(() => stopCapture(true), "録音を停止し、要約を作成しています...");
          }, COLORS.warning);
        }
        makeButton(actions, "状態 [i]", openStatusView, COLORS.accent);
        makeButton(actions, "ホーム [Esc]", () => {
          view = "home";
          render();
        });
        makeButton(actions, "Finderで開く [f]", () => {
          void openSelectedFolderInFinder();
        });
        makeButton(actions, "閉じる [q]", () => renderer.destroy());
      } else if (view === "status") {
        if (status.phase === "starting" || status.phase === "recording" || status.phase === "stopping" || status.phase === "analyzing") {
          makeButton(actions, "■ 録音停止 [s]", () => {
            void runAction(() => stopCapture(), "録音を停止しています...");
          }, COLORS.warning);
        } else if (canRetryCurrentSummary()) {
          makeButton(actions, "要約を再実行 [r]", retryCurrentSummary, COLORS.accent);
        }
        makeButton(actions, "戻る [Esc]", () => {
          view = statusReturnView;
          render();
        });
        makeButton(actions, "Finderで開く [f]", () => {
          void openSelectedFolderInFinder();
        });
        makeButton(actions, "閉じる [q]", () => renderer.destroy());
      } else {
        makeButton(actions, "🎙 録音開始 [r]", beginDashboardRecording, COLORS.accent);
        if (view === "home") {
          makeButton(actions, `認識言語: ${recognitionLanguage === "en-US" ? "英語" : "日本語"} [l]`, toggleRecognitionLanguage, COLORS.accent);
          makeButton(actions, `同時翻訳: ${translationMode === "en-ja" ? "英語→日本語" : "オフ"} [t]`, toggleTranslationMode, COLORS.accent);
        }
        makeButton(actions, "■ 録音停止 [s]", () => {
          void runAction(() => stopCapture(), "録音を停止しています...");
        }, COLORS.warning);
        makeButton(actions, "＋ 新しいフォルダ [n]", openFolderPrompt, COLORS.success);
        makeButton(actions, "状態 [i]", openStatusView, COLORS.accent);
        if (view === "home") {
          homeDeleteButton = makeButton(actions, "削除 [d]", () => {
            if (activeHomePanel === "folders") void requestDeleteFolder();
            else {
              const selected = currentFolderRecords()[selectedRecordIndex];
              if (selected !== undefined) requestDeleteRecording(selected);
            }
          });
          homeOpenButton = makeButton(actions, "ノートを開く [Enter]", () => {
            if (activeHomePanel === "folders") {
              activeHomePanel = "notes";
              updateHomePanelFocus();
              return;
            }
            const selected = currentFolderRecords()[selectedRecordIndex];
            if (selected !== undefined) setSelectedRecord(selected, "home");
          });
          updateHomeControls();
        }
        makeButton(actions, "全記録 [h]", () => {
          view = "history";
          selectedRecordIndex = 0;
          render();
        });
        makeButton(actions, "Finderで開く [f]", () => {
          void openSelectedFolderInFinder();
        });
        makeButton(actions, "閉じる [q]", () => renderer.destroy());
      }
      nextShell.add(header);
      nextShell.add(actions);
    }

    if (view === "home") {
      const content = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        flexDirection: "row",
        gap: 1,
        minHeight: 0,
      });
      const folderPanel = makePanel(
        `フォルダ (${folders.length - 1})`,
        "31%",
        activeHomePanel === "folders" ? COLORS.accent : COLORS.border,
      );
      homeFolderPanel = folderPanel;
      const folderList = new ScrollBoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        scrollY: true,
        verticalScrollbarOptions: { visible: false },
        minHeight: 0,
        contentOptions: { flexDirection: "column" },
      });
      folderScroll = folderList;
      folders.forEach((folder, index) => {
        const depth = folder.relativePath === "" ? 0 : folder.relativePath.split("/").length;
        const indentation = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
        const label = `${indentation}${folder.name}`;
        homeFolderRows.push(makeRow(folderList, label, index === selectedFolderIndex, () => {
          const folderChanged = selectedFolderIndex !== index;
          if (folderChanged) selectedRecordIndex = 0;
          selectedFolderIndex = index;
          activeHomePanel = "folders";
          if (folderChanged) refreshHomeNotes();
          updateHomeRowSelection();
          updateHomePanelFocus();
        }, index === selectedFolderIndex ? COLORS.text : COLORS.muted));
      });
      folderPanel.add(folderList);

      const folder = currentFolder();
      const recordPanel = new BoxRenderable(renderer, {
        width: "68%",
        height: "100%",
        border: true,
        borderColor: activeHomePanel === "notes" ? COLORS.accent : COLORS.border,
        backgroundColor: COLORS.panel,
        padding: 1,
        flexDirection: "column",
        gap: 1,
        minHeight: 0,
      });
      homeNotePanel = recordPanel;
      homeNoteTitle = addText(recordPanel, `${folder.name} (${currentFolderRecords().length})`, COLORS.accent);
      const recordList = new ScrollBoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        scrollY: true,
        verticalScrollbarOptions: { visible: false },
        minHeight: 0,
        contentOptions: { flexDirection: "column" },
      });
      recordScroll = recordList;
      const noteRowsContainer = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexDirection: "column",
      });
      homeNoteRowsContainer = noteRowsContainer;
      recordList.add(noteRowsContainer);
      recordPanel.add(recordList);
      content.add(folderPanel);
      content.add(recordPanel);
      nextShell.add(content);
      addText(nextShell, notice || "欄切替 [←/→/Tab]   選択 [↑/↓]   スクロール [PgUp/PgDn]   選択範囲をコピー [Cmd+C]", COLORS.muted, "auto");
    } else if (view === "history") {
      const content = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        flexDirection: "row",
        gap: 1,
        minHeight: 0,
      });
      const visibleRecords = visibleHistoryRecords();
      const listPanel = makePanel(`最近の記録 (${visibleRecords.length})`, "39%");
      const historyActions = new BoxRenderable(renderer, { width: "100%", height: "auto", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", gap: 1 });
      makeButton(historyActions, `分類: ${historyCategory ?? "すべて"} [c]`, () => {
        const categories = [undefined, "", ...new Set(records.map((record) => record.category_folder).filter(Boolean))];
        const currentIndex = categories.indexOf(historyCategory);
        historyCategory = categories[(currentIndex + 1) % categories.length];
        selectedRecordIndex = 0;
        render();
      }, COLORS.accent);
      makeButton(historyActions, `検索: ${historySearch || "なし"} [/]`, openSearchPrompt, COLORS.accent);
      listPanel.add(historyActions);
      const historyList = new ScrollBoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        scrollY: true,
        verticalScrollbarOptions: { visible: false },
        minHeight: 0,
        contentOptions: { flexDirection: "column" },
      });
      historyScroll = historyList;
      visibleRecords.forEach((record, index) => {
        makeRow(historyList, `${recordTime(record)}  ${record.title}`, index === selectedRecordIndex, () => {
          selectedRecordIndex = index;
          setSelectedRecord(record, "history");
        });
      });
      listPanel.add(historyList);

      const selected = visibleRecords[Math.min(selectedRecordIndex, Math.max(visibleRecords.length - 1, 0))];
      const detailPanel = makePanel("プレビュー", "60%");
      if (selected !== undefined) {
        addText(detailPanel, `${selected.title}  ${recordTime(selected)}`, COLORS.text);
        const tabs = new BoxRenderable(renderer, { width: "100%", height: "auto", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", gap: 1 });
        makeButton(tabs, showSummary ? "● 要約" : "要約", () => {
          showSummary = true;
          render();
        }, showSummary ? COLORS.accent : COLORS.muted);
        makeButton(tabs, showSummary ? "文字起こし" : "● 文字起こし", () => {
          showSummary = false;
          render();
        }, showSummary ? COLORS.muted : COLORS.accent);
        makeButton(tabs, "ノートを開く [Enter]", () => setSelectedRecord(selected, "history"), COLORS.success);
        makeButton(tabs, "ノート削除 [d]", () => requestDeleteRecording(selected), COLORS.error);
        detailPanel.add(tabs);
        const preview = new ScrollBoxRenderable(renderer, {
          width: "100%",
          height: "auto",
          flexGrow: 1,
          scrollY: true,
          minHeight: 0,
          contentOptions: { flexDirection: "column" },
        });
        detailScroll = preview;
        void loadRecordPreview(selected).then((lines) => {
          if (view !== "history" || detailScroll !== preview) return;
          preview.add(new TextRenderable(renderer, { content: lines.join("\n"), width: "100%", height: "auto", wrapMode: "word", fg: COLORS.text }));
          renderer.requestRender();
        });
        detailPanel.add(preview);
      } else {
        addText(detailPanel, "条件に一致する記録がありません。", COLORS.muted);
      }
      content.add(listPanel);
      content.add(detailPanel);
      nextShell.add(content);
      addText(nextShell, notice || "記録選択 [↑/↓]   スクロール [PgUp/PgDn]   要約/文字起こし [Tab]   選択範囲をコピー [Cmd+C]   戻る [Esc]", COLORS.muted, "auto");
    } else if (view === "status") {
      const statusPanel = makePanel("録音と要約の状態", "100%", status.phase === "failed" ? COLORS.error : COLORS.accent);
      statusText = addText(statusPanel, formatStatusLine(status), status.phase === "failed" ? COLORS.error : COLORS.text);
      addText(statusPanel, `保存先: ${status.output_root ?? outputRoot}`, COLORS.muted);
      addText(statusPanel, `開始時刻: ${status.started_at ?? "未記録"}   停止時刻: ${status.stopped_at ?? "未記録"}`, COLORS.muted);
      transcriptPathText = addText(statusPanel, `文字起こしファイル: ${status.raw_path ?? "未作成"}`, COLORS.muted, 2);
      if (status.result_path !== undefined) addText(statusPanel, `修正結果: ${status.result_path}`, COLORS.muted, 2);
      if (status.summary_path !== undefined) addText(statusPanel, `要約ファイル: ${status.summary_path}`, COLORS.muted, 2);
      if (status.error !== undefined) addText(statusPanel, `エラー: ${status.error}`, COLORS.error, 2);
      nextShell.add(statusPanel);
      if (notice) addText(nextShell, notice, COLORS.muted, "auto");
    } else if (view === "live") {
      const translating = status.translation_mode === "en-ja";
      const liveContent = new BoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        flexDirection: translating ? "row" : "column",
        gap: 1,
        minHeight: 0,
      });
      const transcriptPanel = makePanel(
        getRecognitionLanguage(status) === "en-US" ? "英語の文字起こし" : "日本語の文字起こし",
        translating ? "49%" : "100%",
        COLORS.accent,
      );
      const transcriptScroll = new ScrollBoxRenderable(renderer, {
        width: "100%",
        height: "auto",
        flexGrow: 1,
        scrollY: true,
        stickyScroll: true,
        stickyStart: "bottom",
        minHeight: 0,
        contentOptions: { flexDirection: "column" },
      });
      liveTranscriptScroll = transcriptScroll;
      const transcriptText = new TextRenderable(renderer, {
        content: liveTranscriptContent || "文字起こしを待っています...",
        width: "100%",
        height: "auto",
        wrapMode: "word",
        fg: COLORS.text,
      });
      liveTranscriptText = transcriptText;
      transcriptScroll.add(transcriptText);
      transcriptPanel.add(transcriptScroll);

      liveContent.add(transcriptPanel);
      if (translating) {
        const translationPanel = makePanel("日本語訳", "49%", COLORS.success);
        const translationScroll = new ScrollBoxRenderable(renderer, {
          width: "100%", height: "auto", flexGrow: 1, minHeight: 0,
          scrollY: true, stickyScroll: true, stickyStart: "bottom",
          contentOptions: { flexDirection: "column" },
        });
        liveTranslationScroll = translationScroll;
        liveTranslationText = new TextRenderable(renderer, {
          content: liveTranslationContent || "日本語訳を待っています...",
          width: "100%", height: "auto", wrapMode: "word", fg: COLORS.text,
        });
        translationScroll.add(liveTranslationText);
        translationPanel.add(translationScroll);
        liveContent.add(translationPanel);
      }
      nextShell.add(liveContent);
      addText(nextShell, notice || `${translating ? "原文・訳文" : "文字起こし"}スクロール [PgUp/PgDn]   選択範囲をコピー [Cmd+C]`, COLORS.muted, "auto");
    } else {
      const record = selectedRecord;
      const detailPanel = makePanel(record?.title ?? "ノート", "100%");
      if (record !== undefined) {
        addText(detailPanel, `日時: ${recordTime(record)}  分類: ${record.category_folder || "未分類"}  ID: ${record.session_id}`, COLORS.muted);
        if (selectedRecordStatus !== undefined) {
          addText(detailPanel, `状態: ${statusLabel(selectedRecordStatus)}`, selectedRecordStatus.phase === "failed" ? COLORS.error : COLORS.muted);
          if (selectedRecordStatus.error !== undefined) addText(detailPanel, selectedRecordStatus.error, COLORS.error, "auto");
        }
        addText(detailPanel, `文字起こしファイル: ${record.raw_path ?? "未作成"}`, COLORS.muted, 2);
        const tabs = new BoxRenderable(renderer, { width: "100%", height: "auto", flexShrink: 0, flexDirection: "row", flexWrap: "wrap", gap: 1 });
        makeButton(tabs, showSummary ? "● 要約" : "要約", () => {
          showSummary = true;
          render();
        }, showSummary ? COLORS.accent : COLORS.muted);
        makeButton(tabs, showSummary ? "文字起こし" : "● 文字起こし", () => {
          showSummary = false;
          render();
        }, showSummary ? COLORS.muted : COLORS.accent);
        makeButton(tabs, "戻る [Esc]", () => {
          view = returnView;
          render();
        }, COLORS.success);
        makeButton(tabs, "ノート削除 [d]", () => requestDeleteRecording(record), COLORS.error);
        if (canRetrySelectedSummary()) makeButton(tabs, "要約を再実行 [r]", retrySelectedSummary, COLORS.accent);
        makeButton(tabs, "状態 [i]", openStatusView, COLORS.accent);
        makeButton(tabs, "Finderで開く [f]", () => {
          void openSelectedFolderInFinder();
        });
        detailPanel.add(tabs);
        const preview = new ScrollBoxRenderable(renderer, {
          width: "100%",
          height: "auto",
          flexGrow: 1,
          scrollY: true,
          minHeight: 0,
          contentOptions: { flexDirection: "column" },
        });
        detailScroll = preview;
        void loadRecordPreview(record).then((lines) => {
          if (view !== "detail" || detailScroll !== preview) return;
          preview.add(new TextRenderable(renderer, { content: lines.join("\n"), width: "100%", height: "auto", wrapMode: "word", fg: COLORS.text }));
          renderer.requestRender();
        });
        detailPanel.add(preview);
      }
      nextShell.add(detailPanel);
      addText(nextShell, notice || "要約/文字起こし [Tab]   スクロール [PgUp/PgDn]   選択範囲をコピー [Cmd+C]   閉じる [q]", COLORS.muted, "auto");
    }

    renderer.root.add(nextShell);
    if (view === "home") refreshHomeNotes();
    if (modal !== undefined) {
      renderer.root.remove(modal);
      renderer.root.add(modal);
    }
    renderer.requestRender();
  }

  async function moveFolderSelection(direction: "up" | "down"): Promise<void> {
    const nextIndex = direction === "up"
      ? Math.max(0, selectedFolderIndex - 1)
      : Math.min(folders.length - 1, selectedFolderIndex + 1);
    if (nextIndex === selectedFolderIndex) return;
    selectedFolderIndex = nextIndex;
    selectedRecordIndex = 0;
    refreshHomeNotes();
    updateHomeRowSelection();
    updateHomePanelFocus();
    scrollSelectionIntoView(folderScroll, selectedFolderIndex);
  }

  async function moveHomeSelection(direction: "up" | "down"): Promise<void> {
    if (activeHomePanel === "folders") {
      await moveFolderSelection(direction);
      return;
    }

    const folderRecords = currentFolderRecords();
    const nextIndex = direction === "up"
      ? Math.max(0, selectedRecordIndex - 1)
      : Math.min(Math.max(folderRecords.length - 1, 0), selectedRecordIndex + 1);
    if (nextIndex === selectedRecordIndex || folderRecords.length === 0) return;
    selectedRecordIndex = nextIndex;
    updateHomeRowSelection();
    updateHomeControls();
    scrollSelectionIntoView(recordScroll, selectedRecordIndex);
    renderer.requestRender();
  }

  function moveHistorySelection(direction: "up" | "down"): void {
    const visibleRecords = visibleHistoryRecords();
    selectedRecordIndex = direction === "up"
      ? Math.max(0, selectedRecordIndex - 1)
      : Math.min(visibleRecords.length - 1, selectedRecordIndex + 1);
    render();
  }

  function togglePreview(): void {
    showSummary = !showSummary;
    render();
  }

  function copySelectedText(selectedText = renderer.getSelection()?.getSelectedText()): void {
    if (selectedText === undefined || selectedText.length === 0) {
      notice = "コピーする範囲をマウスで選択してください";
      render();
      return;
    }
    if (!renderer.copyToClipboardOSC52(selectedText)) {
      notice = "この端末はOSC 52でのコピーに対応していません";
      render();
      return;
    }
    notice = "選択範囲をコピーしました";
    render();
  }

  async function onKeyPress(key: { name: string; ctrl: boolean; meta?: boolean; shift?: boolean; super?: boolean }): Promise<void> {
    const keyName = key.name.toLowerCase();
    const copyShortcut = keyName === "c"
      && (key.super === true || key.meta === true || (key.ctrl && key.shift === true));
    if (copyShortcut) {
      if (activeInput !== undefined) {
        const inputSelection = activeInput.getSelectedText();
        if (inputSelection.length > 0) renderer.copyToClipboardOSC52(inputSelection);
        return;
      }
      copySelectedText();
      return;
    }
    if (activeInput !== undefined) {
      if (key.name === "escape") closeModal();
      return;
    }
    if (confirmation !== undefined) {
      if (key.name === "enter" || key.name === "return" || key.name === "y") confirmPendingAction();
      else if (key.name === "escape" || key.name === "n" || key.name === "q") closeModal();
      return;
    }
    if (key.ctrl && keyName === "c") {
      if (renderer.getSelection()?.getSelectedText()) copySelectedText();
      else renderer.destroy();
      return;
    }
    if (keyName === "f" && !key.ctrl && !key.meta && !key.super) {
      await openSelectedFolderInFinder();
      return;
    }
    if (key.name === "q") {
      renderer.destroy();
      return;
    }
    if (key.name === "i" && view !== "status") {
      openStatusView();
      return;
    }
    if (key.name === "escape" || key.name === "b") {
      view = view === "detail" ? returnView : view === "status" ? statusReturnView : "home";
      render();
      return;
    }
    if (view === "home") {
      if (key.name === "up" || key.name === "k") await moveHomeSelection("up");
      else if (key.name === "down" || key.name === "j") await moveHomeSelection("down");
      else if (key.name === "r") beginDashboardRecording();
      else if (key.name === "s") await runAction(() => stopCapture(), "録音を停止しています...");
      else if (key.name === "d") {
        if (activeHomePanel === "folders") await requestDeleteFolder();
        else {
          const selected = currentFolderRecords()[selectedRecordIndex];
          if (selected !== undefined) requestDeleteRecording(selected);
        }
      } else if (key.name === "tab") {
        activeHomePanel = activeHomePanel === "folders" ? "notes" : "folders";
        updateHomePanelFocus();
      } else if (key.name === "left") {
        activeHomePanel = "folders";
        updateHomePanelFocus();
      } else if (key.name === "right") {
        activeHomePanel = "notes";
        updateHomePanelFocus();
      } else if (key.name === "n") openFolderPrompt();
      else if (key.name === "t") toggleTranslationMode();
      else if (key.name === "l") toggleRecognitionLanguage();
      else if (key.name === "h") {
        view = "history";
        selectedRecordIndex = 0;
        render();
      } else if (key.name === "enter" || key.name === "return") {
        if (activeHomePanel === "folders") {
          activeHomePanel = "notes";
          updateHomePanelFocus();
        } else {
          const selected = currentFolderRecords()[selectedRecordIndex];
          if (selected !== undefined) setSelectedRecord(selected, "home");
        }
      } else if (key.name === "pagedown" || key.name === "page-down") {
        const activeScroll = activeHomePanel === "folders" ? folderScroll : recordScroll;
        activeScroll?.scrollBy({ x: 0, y: 12 });
      } else if (key.name === "pageup" || key.name === "page-up") {
        const activeScroll = activeHomePanel === "folders" ? folderScroll : recordScroll;
        activeScroll?.scrollBy({ x: 0, y: -12 });
      }
      return;
    }
    if (view === "live") {
      if (key.name === "r" && canRetryCurrentSummary()) retryCurrentSummary();
      else if (key.name === "s") void runAction(() => stopCapture(true), "録音を停止し、要約を作成しています...");
      else if (key.name === "pagedown" || key.name === "page-down") {
        liveTranscriptScroll?.scrollBy({ x: 0, y: 12 });
        liveTranslationScroll?.scrollBy({ x: 0, y: 12 });
      } else if (key.name === "pageup" || key.name === "page-up") {
        liveTranscriptScroll?.scrollBy({ x: 0, y: -12 });
        liveTranslationScroll?.scrollBy({ x: 0, y: -12 });
      }
      return;
    }
    if (view === "status") {
      if (key.name === "s" && (status.phase === "starting" || status.phase === "recording" || status.phase === "stopping" || status.phase === "analyzing")) {
        void runAction(() => stopCapture(), "録音を停止しています...");
      } else if (key.name === "r" && canRetryCurrentSummary()) retryCurrentSummary();
      return;
    }
    if (view === "history") {
      if (key.name === "up" || key.name === "k") moveHistorySelection("up");
      else if (key.name === "down" || key.name === "j") moveHistorySelection("down");
      else if (key.name === "d") {
        const selected = visibleHistoryRecords()[selectedRecordIndex];
        if (selected !== undefined) requestDeleteRecording(selected);
      }
      else if (key.name === "c") {
        const categories = [undefined, "", ...new Set(records.map((record) => record.category_folder).filter(Boolean))];
        const currentIndex = categories.indexOf(historyCategory);
        historyCategory = categories[(currentIndex + 1) % categories.length];
        selectedRecordIndex = 0;
        render();
      } else if (key.name === "/") openSearchPrompt();
      else if (key.name === "tab" || key.name === "t") togglePreview();
      else if (key.name === "enter" || key.name === "return") {
        const selected = visibleHistoryRecords()[selectedRecordIndex];
        if (selected !== undefined) setSelectedRecord(selected, "history");
      } else if (key.name === "pagedown" || key.name === "page-down") historyScroll?.scrollBy({ x: 0, y: 12 });
      else if (key.name === "pageup" || key.name === "page-up") historyScroll?.scrollBy({ x: 0, y: -12 });
      return;
    }
    if (key.name === "r") retrySelectedSummary();
    else if (key.name === "d" && selectedRecord !== undefined) requestDeleteRecording(selectedRecord);
    else if (key.name === "tab") togglePreview();
    else if (key.name === "pagedown" || key.name === "page-down") detailScroll?.scrollBy({ x: 0, y: 12 });
    else if (key.name === "pageup" || key.name === "page-up") detailScroll?.scrollBy({ x: 0, y: -12 });
  }

  try {
    await refreshData();
    recognitionLanguage = getRecognitionLanguage(status);
    translationMode = recognitionLanguage === "en-US" ? status.translation_mode ?? "off" : "off";
    render();
    const refreshTimer = setInterval(() => {
      void getPublicStatus().then(async (nextStatus) => {
        if (renderer.isDestroyed || dashboardRecordingStartInFlight) return;
        const previousSelectedPhase = selectedRecordStatus?.phase;
        const selectedStatusChanged = view === "detail" && await refreshSelectedRecordStatus();
        if (renderer.isDestroyed) return;
        const selectedSummaryCompleted = selectedStatusChanged
          && previousSelectedPhase !== "completed" && selectedRecordStatus?.phase === "completed";
        const completedSession = nextStatus.phase === "completed" ? nextStatus.session_dir : undefined;
        const activeAnalysisSessions = new Set(nextStatus.active_analysis_sessions ?? []);
        const analysisCompleted = [...lastObservedActiveAnalysisSessions]
          .some((sessionDirectory) => !activeAnalysisSessions.has(sessionDirectory));
        lastObservedActiveAnalysisSessions = activeAnalysisSessions;
        status = nextStatus;
        if (statusText !== undefined) {
          statusText.content = formatStatusLine(status);
          statusText.fg = status.phase === "failed" ? COLORS.error : COLORS.muted;
          renderer.requestRender();
        }
        if (transcriptPathText !== undefined) {
          transcriptPathText.content = `文字起こしファイル: ${status.raw_path ?? "未作成"}`;
        }
        if (
          (completedSession !== undefined && completedSession !== lastRefreshedCompletionSession || analysisCompleted || selectedSummaryCompleted)
          && !completionRefreshInFlight
        ) {
          completionRefreshInFlight = true;
          void refreshDashboardAfterCompletion().catch((error: unknown) => {
            notice = error instanceof Error ? error.message : String(error);
            if (!renderer.isDestroyed) render();
          }).finally(() => {
            completionRefreshInFlight = false;
          });
          return;
        }
        if (selectedStatusChanged && view === "detail") render();
        if (view === "live") {
          void refreshLiveView(nextStatus).catch((error: unknown) => {
            notice = error instanceof Error ? error.message : String(error);
            if (!renderer.isDestroyed) render();
          });
        }
      }).catch((error: unknown) => {
        notice = error instanceof Error ? error.message : String(error);
        render();
      });
    }, 1_000);

    renderer.keyInput.on("keypress", (key) => {
      void onKeyPress(key);
    });
    await new Promise<void>((resolveClose) => {
      renderer.once(CliRenderEvents.DESTROY, () => {
        clearInterval(refreshTimer);
        resolveClose();
      });
    });
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
  }
}
