import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CATEGORY_NAME_MAX_LENGTH, DEFAULT_SESSIONS_DIR, SETTINGS_PATH, expandPath, isSessionName } from "./config.ts";
import type { VoiceNoteRecord } from "./domain.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONTROL_CHARACTER_PATTERN = /[\\/:\x00-\x1f\x7f]/u;

type DirectoryEntry = Readonly<{ name: string; path: string }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPathInside(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(parentPath, targetPath);
  return relativePath !== "" && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

function localIsoSeconds(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? "-" : "+";
  const offsetHour = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetMinute = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${offsetHour}:${offsetMinute}`;
}

function compareUnicode(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftCodePoint = leftCodePoints[index] ?? 0;
    const rightCodePoint = rightCodePoints[index] ?? 0;
    if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

type FolderActivity = Readonly<{
  folderPaths: readonly string[];
  latestFileUpdateByFolder: ReadonlyMap<string, number>;
}>;

async function collectFolderActivity(rootPath: string): Promise<FolderActivity> {
  const folderPaths: string[] = [];
  const latestFileUpdateByFolder = new Map<string, number>();

  async function visit(folderPath: string): Promise<number> {
    let entries;
    try {
      entries = await readdir(folderPath, { withFileTypes: true });
    } catch {
      latestFileUpdateByFolder.set(folderPath, 0);
      return 0;
    }

    let latestFileUpdate = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(folderPath, entry.name);
      if (entry.isDirectory()) {
        if (!isSessionName(entry.name)) folderPaths.push(entryPath);
        latestFileUpdate = Math.max(latestFileUpdate, await visit(entryPath));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        latestFileUpdate = Math.max(latestFileUpdate, (await stat(entryPath)).mtimeMs);
      } catch {
        // ファイルが走査中に消えても残りのフォルダを一覧する。
      }
    }

    latestFileUpdateByFolder.set(folderPath, latestFileUpdate);
    return latestFileUpdate;
  }

  await visit(rootPath);
  return { folderPaths, latestFileUpdateByFolder };
}

function sortFoldersByLatestFileUpdate(folderPaths: readonly string[], activity: FolderActivity): string[] {
  return [...folderPaths].sort((left, right) =>
    (activity.latestFileUpdateByFolder.get(right) ?? 0) - (activity.latestFileUpdateByFolder.get(left) ?? 0)
      || compareUnicode(left, right),
  );
}

function sessionStartedAt(sessionId: string): string {
  const year = Number(sessionId.slice(0, 4));
  const month = Number(sessionId.slice(4, 6));
  const day = Number(sessionId.slice(6, 8));
  const hour = Number(sessionId.slice(9, 11));
  const minute = Number(sessionId.slice(11, 13));
  const second = Number(sessionId.slice(13, 15));
  return localIsoSeconds(new Date(year, month - 1, day, hour, minute, second));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function canonicalizePath(filePath: string): Promise<string> {
  const absolutePath = resolve(filePath);
  let currentPath = absolutePath;
  const missingParts: string[] = [];
  while (true) {
    try {
      const canonicalParent = await realpath(currentPath);
      return resolve(canonicalParent, ...missingParts.reverse());
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) return absolutePath;
      missingParts.push(basename(currentPath));
      currentPath = parentPath;
    }
  }
}

export async function ensurePrivateDirectory(directoryPath: string): Promise<string> {
  const requestedPath = resolve(directoryPath);
  await mkdir(requestedPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const resolvedPath = await realpath(requestedPath);
  const directoryStat = await stat(resolvedPath);
  if ((directoryStat.mode & 0o777) & 0o077) {
    throw new Error(`保存先の権限が広すぎます: ${resolvedPath}（700にしてください）`);
  }
  return resolvedPath;
}

async function resolveExistingDirectory(directoryPath: string): Promise<string> {
  const resolvedPath = await realpath(expandPath(directoryPath));
  if (!(await lstat(resolvedPath)).isDirectory()) throw new Error(`保存先がフォルダではありません: ${resolvedPath}`);
  return resolvedPath;
}

export async function ensurePrivateFile(filePath: string, content = ""): Promise<void> {
  const fileHandle = await open(filePath, "wx", PRIVATE_FILE_MODE);
  try {
    await fileHandle.writeFile(content, "utf8");
  } finally {
    await fileHandle.close();
  }
}

export async function resolveOutputRoot(outputDirectory?: string): Promise<string> {
  if (outputDirectory !== undefined) return canonicalizePath(expandPath(outputDirectory));

  if (await exists(SETTINGS_PATH)) {
    const settingsJson: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    if (!isObject(settingsJson) || typeof settingsJson.output_dir !== "string") {
      throw new Error(`保存先設定を読み取れません: ${SETTINGS_PATH}`);
    }
    return canonicalizePath(expandPath(settingsJson.output_dir));
  }

  return canonicalizePath(expandPath(process.env.VOICE_NOTE_SESSIONS_DIR ?? DEFAULT_SESSIONS_DIR));
}

export function validateFolderName(name: string): string {
  const characterCount = Array.from(name).length;
  if (!name || name !== name.trim() || characterCount > CATEGORY_NAME_MAX_LENGTH) {
    throw new Error("フォルダ名は前後の空白なしで1〜40文字にしてください");
  }
  if (name === "." || name === ".." || name.startsWith(".") || isSessionName(name)) {
    throw new Error("そのフォルダ名は使用できません");
  }
  if (CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new Error("フォルダ名にパス区切り文字や制御文字は使用できません");
  }
  return name;
}

async function readDirectFolders(parentPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const candidatePaths = entries
    .filter((entry) => !entry.name.startsWith(".") && !isSessionName(entry.name))
    .map((entry) => join(parentPath, entry.name));
  const directoryPaths = await Promise.all(candidatePaths.map(async (candidatePath) => {
    try {
      return (await stat(candidatePath)).isDirectory() ? candidatePath : undefined;
    } catch {
      return undefined;
    }
  }));
  const folderPaths = directoryPaths.filter((candidatePath): candidatePath is string => candidatePath !== undefined);
  const activity = await collectFolderActivity(parentPath);
  return sortFoldersByLatestFileUpdate(folderPaths, activity);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function listCategoryFolders(outputRoot: string): Promise<DirectoryEntry[]> {
  const rootPath = await ensurePrivateDirectory(outputRoot);
  const folderPaths = await readDirectFolders(rootPath);
  return folderPaths.map((folderPath) => ({ name: basename(folderPath), path: folderPath }));
}

export async function listNestedFolders(outputRoot: string): Promise<string[]> {
  const rootPath = await ensurePrivateDirectory(outputRoot);
  const activity = await collectFolderActivity(rootPath);
  const childrenByParent = new Map<string, string[]>();
  for (const folderPath of activity.folderPaths) {
    const parentPath = dirname(folderPath);
    const children = childrenByParent.get(parentPath) ?? [];
    children.push(folderPath);
    childrenByParent.set(parentPath, children);
  }

  const orderedFolders: string[] = [];
  function appendChildFolders(parentPath: string): void {
    const children = sortFoldersByLatestFileUpdate(childrenByParent.get(parentPath) ?? [], activity);
    for (const childPath of children) {
      orderedFolders.push(childPath);
      appendChildFolders(childPath);
    }
  }
  appendChildFolders(rootPath);
  return orderedFolders;
}

export async function createCategoryFolder(outputRoot: string, name: string): Promise<string> {
  const rootPath = await ensurePrivateDirectory(outputRoot);
  const folderPath = join(rootPath, validateFolderName(name));
  await ensurePrivateDirectory(folderPath);
  return folderPath;
}

export async function createChildFolder(parentFolder: string, name: string): Promise<string> {
  const parentPath = await ensurePrivateDirectory(parentFolder);
  const folderPath = join(parentPath, validateFolderName(name));
  await mkdir(folderPath, { mode: PRIVATE_DIRECTORY_MODE });
  return folderPath;
}

export async function selectCategoryFolder(outputRoot: string, name: string): Promise<string> {
  const folderPath = join(expandPath(outputRoot), validateFolderName(name));
  let folderStat;
  try {
    folderStat = await stat(folderPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(`分類フォルダがありません。先に作成してください: ${name}`);
    }
    throw error;
  }
  if (!folderStat.isDirectory()) {
    throw new Error(`分類フォルダがありません。先に作成してください: ${name}`);
  }
  if ((folderStat.mode & 0o777) & 0o077) {
    throw new Error(`分類フォルダの権限が広すぎます: ${folderPath}（700にしてください）`);
  }
  return folderPath;
}

export async function deleteSessionDirectory(outputRoot: string, sessionDirectory: string): Promise<void> {
  const rootPath = await resolveExistingDirectory(outputRoot);
  const targetPath = resolve(sessionDirectory);
  if (!isPathInside(rootPath, targetPath) || !isSessionName(basename(targetPath))) {
    throw new Error("削除対象の録音フォルダが保存先の配下にありません");
  }

  const canonicalTarget = await realpath(targetPath);
  if (canonicalTarget !== targetPath || !isPathInside(rootPath, canonicalTarget)) {
    throw new Error("シンボリックリンクを含む録音フォルダは削除できません");
  }
  const targetStat = await lstat(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("削除対象が録音フォルダではありません");
  }

  await rm(targetPath, { recursive: true, force: false });
}

export async function deleteCategoryFolder(outputRoot: string, relativeFolderPath: string): Promise<void> {
  const rootPath = await resolveExistingDirectory(outputRoot);
  const folderSegments = relativeFolderPath.replaceAll("\\", "/").split("/");
  if (!relativeFolderPath || folderSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("保存先ルートや不正なフォルダパスは削除できません");
  }

  const targetPath = resolve(rootPath, ...folderSegments);
  if (!isPathInside(rootPath, targetPath)) throw new Error("保存先の外側にあるフォルダは削除できません");

  const canonicalTarget = await realpath(targetPath);
  if (canonicalTarget !== targetPath || !isPathInside(rootPath, canonicalTarget)) {
    throw new Error("シンボリックリンクを含むフォルダは削除できません");
  }
  const targetStat = await lstat(targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error("削除対象がフォルダではありません");
  }

  await rm(targetPath, { recursive: true, force: false });
}

async function newestMarkdownPath(sessionPath: string, prefix: string): Promise<string | undefined> {
  const entries = await readdir(sessionPath, { withFileTypes: true });
  const matching = entries.filter(
    (entry) => entry.name.startsWith(prefix) && entry.name.endsWith(".md"),
  );
  const fileCandidates = await Promise.all(matching.map(async (entry) => {
      const path = join(sessionPath, entry.name);
      try {
        const fileStat = await stat(path);
        return fileStat.isFile() ? { path, modifiedAt: fileStat.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    }));
  const withTime = fileCandidates.filter((candidate): candidate is { path: string; modifiedAt: number } => candidate !== undefined);
  return withTime.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.path;
}

async function listRecordsInSessionFolder(folderPath: string, outputRoot: string): Promise<VoiceNoteRecord[]> {
  let entries;
  try {
    entries = await readdir(folderPath, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const sessionEntries = entries.filter(
    (entry) => entry.isDirectory() && isSessionName(entry.name),
  );
  const relativeFolder = relative(outputRoot, folderPath);
  const categoryFolder = relativeFolder === "" ? "" : relativeFolder.split(/[\\/]/u).join("/");
  const records = await Promise.all(
    sessionEntries.map(async (sessionEntry) => {
      const sessionPath = join(folderPath, sessionEntry.name);
      const rawPath = join(sessionPath, "raw.vtt");
      const importedTranscriptPath = join(sessionPath, "transcript.txt");
      const summaryPath = await newestMarkdownPath(sessionPath, "summary");
      const resultPath = await newestMarkdownPath(sessionPath, "result-");
      let title = sessionEntry.name;
      if (summaryPath !== undefined) {
        const firstLine = (await readFile(summaryPath, "utf8")).split(/\r?\n/u, 1)[0]?.trim() ?? "";
        title = firstLine.startsWith("# ") ? firstLine.slice(2) : basename(summaryPath, ".md");
      }
      try {
        const importedTitle = (await readFile(join(sessionPath, "title.txt"), "utf8")).trim();
        if (importedTitle.length > 0) title = importedTitle;
      } catch {
        // title.txt is present only for notes imported from another app.
      }

      const record: {
        session_id: string;
        session_dir: string;
        started_at: string;
        category_folder: string;
        title: string;
        raw_path?: string;
        result_path?: string;
        summary_path?: string;
      } = {
        session_id: sessionEntry.name,
        session_dir: sessionPath,
        started_at: sessionStartedAt(sessionEntry.name),
        category_folder: categoryFolder,
        title,
      };
      for (const transcriptPath of [rawPath, importedTranscriptPath]) {
        try {
          if ((await stat(transcriptPath)).isFile()) {
            record.raw_path = transcriptPath;
            break;
          }
        } catch {
          // 既存のraw.vttか、外部アプリから取り込んだtranscript.txtがある場合だけ表示する。
        }
      }
      if (resultPath !== undefined) record.result_path = resultPath;
      if (summaryPath !== undefined) record.summary_path = summaryPath;
      return record;
    }),
  );
  return records;
}

export async function listRecords(
  outputRoot: string,
  options: Readonly<{ recursive?: boolean; directOnly?: boolean }> = {},
): Promise<VoiceNoteRecord[]> {
  const rootPath = await canonicalizePath(expandPath(outputRoot));
  if (!(await exists(rootPath))) return [];
  if (!(await stat(rootPath)).isDirectory()) return [];
  const childFolders = options.directOnly
    ? []
    : options.recursive
      ? await listNestedFolders(rootPath)
      : await readDirectFolders(rootPath);
  const folderRecords = await Promise.all(
    [rootPath, ...childFolders].map((folderPath) => listRecordsInSessionFolder(folderPath, rootPath)),
  );
  return folderRecords.flat().sort((left, right) => right.session_id.localeCompare(left.session_id));
}

export function formatRecords(records: readonly VoiceNoteRecord[]): string {
  if (records.length === 0) return "記録はありません。";
  const lines = ["日時 | タイトル | 分類 | セッションID", "--- | --- | --- | ---"];
  for (const record of records) {
    const date = new Date(record.started_at);
    const recordedAt = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
    const title = record.title.replaceAll("|", "\\|").replaceAll("\n", " ");
    const category = (record.category_folder || "未分類").replaceAll("|", "\\|");
    lines.push(`${recordedAt} | ${title} | ${category} | ${record.session_id}`);
  }
  return lines.join("\n");
}

export async function showRecord(outputRoot: string, target: string): Promise<string> {
  const records = await listRecords(outputRoot, { recursive: true });
  const record = target === "latest"
    ? records[0]
    : records.find((candidate) => candidate.session_id === target);
  if (record === undefined) {
    throw new Error(target === "latest" ? "表示できる記録がありません" : `記録が見つかりません: ${target}`);
  }

  const date = new Date(record.started_at);
  const recordedAt = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
  const lines = [
    `タイトル: ${record.title}`,
    `日時: ${recordedAt}`,
    `分類: ${record.category_folder || "未分類"}`,
    `セッションID: ${record.session_id}`,
  ];
  const fileSections: readonly (readonly [string, string | undefined])[] = [
    ["要約", record.summary_path],
    ["原文", record.raw_path],
    ["修正結果", record.result_path],
  ];
  for (const [label, filePath] of fileSections) {
    lines.push("", label, "---");
    lines.push(filePath === undefined ? "（未作成）" : (await readFile(filePath, "utf8")).trimEnd());
  }
  return lines.join("\n");
}

export async function setDefaultOutputDirectory(outputDirectory: string): Promise<string> {
  const resolvedPath = await ensurePrivateDirectory(expandPath(outputDirectory));
  const temporaryPath = join(dirname(SETTINGS_PATH), `.settings-${randomUUID()}.tmp`);
  try {
    await ensurePrivateFile(temporaryPath, JSON.stringify({ output_dir: resolvedPath }));
    await rename(temporaryPath, SETTINGS_PATH);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return resolvedPath;
}

export async function createPrivateSession(outputRoot: string): Promise<string> {
  const rootPath = await ensurePrivateDirectory(outputRoot);
  const now = new Date();
  const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const sessionId = `${timestamp}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const sessionPath = join(rootPath, sessionId);
  await mkdir(sessionPath, { mode: PRIVATE_DIRECTORY_MODE });
  return sessionPath;
}
