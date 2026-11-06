import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RUN_DIR, STATE_PATH } from "./config.ts";
import type { RunPhase, RunState } from "./domain.ts";

const RUN_PHASES = new Set<RunPhase>([
  "idle",
  "starting",
  "recording",
  "recorded",
  "stopping",
  "analyzing",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
const SESSION_STATE_FILENAME = ".voice-note-state.json";
const ACTIVE_SESSIONS_DIR = join(RUN_DIR, "active-sessions");

export function localIsoSeconds(date: Date): string {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRunPhase(value: string): value is RunPhase {
  return [...RUN_PHASES].some((phase) => phase === value);
}

export async function ensureRunDirectory(): Promise<void> {
  await mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const directoryStat = await stat(RUN_DIR);
  if ((directoryStat.mode & 0o777) & 0o077) {
    throw new Error(`実行状態ディレクトリの権限が広すぎます: ${RUN_DIR}（700にしてください）`);
  }
}

async function readStateFile(statePath: string): Promise<RunState | undefined> {
  try {
    const stateJson: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (!isRecord(stateJson)) return { phase: "unknown" };
    const fields = Object.entries(stateJson).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    const state = Object.fromEntries(fields);
    const phaseText = state.phase;
    if (phaseText === undefined || !isRunPhase(phaseText)) return { ...state, phase: "unknown" };
    return { ...state, phase: phaseText };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return { phase: "unknown" };
    if (error instanceof Error && "code" in error) return { phase: "unknown" };
    throw error;
  }
}

function sessionStatePath(sessionDirectory: string): string {
  return join(sessionDirectory, SESSION_STATE_FILENAME);
}

export async function hasSessionStateFile(sessionDirectory: string): Promise<boolean> {
  try {
    await access(sessionStatePath(sessionDirectory));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function activeSessionPath(sessionDirectory: string): string {
  const sessionKey = createHash("sha256").update(resolve(sessionDirectory)).digest("hex").slice(0, 32);
  return join(ACTIVE_SESSIONS_DIR, `${sessionKey}.json`);
}

export async function readState(sessionDirectory?: string): Promise<RunState> {
  if (sessionDirectory !== undefined) {
    const sessionState = await readStateFile(sessionStatePath(sessionDirectory));
    if (sessionState !== undefined) return relocateSessionStatePaths(sessionState, sessionDirectory);
  }

  const currentState = await readStateFile(STATE_PATH);
  if (currentState === undefined) return { phase: "idle" };
  if (sessionDirectory !== undefined && currentState.session_dir !== sessionDirectory) return { phase: "idle" };
  if (sessionDirectory === undefined && currentState.session_dir !== undefined) {
    const sessionState = await readStateFile(sessionStatePath(currentState.session_dir));
    if (sessionState !== undefined) return sessionState;
  }
  return currentState;
}

function relocateSessionStatePaths(state: RunState, sessionDirectory: string): RunState {
  if (!state.session_dir || state.session_dir === sessionDirectory) return state;
  // フォルダ移動後も、選んだ記録の原文・成果物を参照する。読取りだけでは保存内容を変えない。
  const paths = ["raw_path", "result_path", "summary_path", "translation_path"].flatMap((key) => {
    const path = state[key];
    return path && dirname(path) === state.session_dir
      ? [[key, join(sessionDirectory, basename(path))]]
      : [];
  });
  return { ...state, ...Object.fromEntries(paths), session_dir: sessionDirectory };
}

async function writeStateFile(statePath: string, state: Readonly<Record<string, string>>): Promise<void> {
  const temporaryPath = join(dirname(statePath), `.state-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, statePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function markSessionActive(sessionDirectory: string): Promise<void> {
  await mkdir(ACTIVE_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  const directoryStat = await stat(ACTIVE_SESSIONS_DIR);
  if ((directoryStat.mode & 0o777) & 0o077) {
    throw new Error(`実行状態ディレクトリの権限が広すぎます: ${ACTIVE_SESSIONS_DIR}（700にしてください）`);
  }
  await writeStateFile(activeSessionPath(sessionDirectory), { session_dir: resolve(sessionDirectory) });
}

export async function clearActiveSessionMarker(sessionDirectory: string): Promise<void> {
  await unlink(activeSessionPath(sessionDirectory)).catch(() => undefined);
}

export async function listActiveSessionDirectories(): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(ACTIVE_SESSIONS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const sessionDirectories = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      try {
        const markerJson: unknown = JSON.parse(await readFile(join(ACTIVE_SESSIONS_DIR, entry.name), "utf8"));
        if (isRecord(markerJson) && typeof markerJson.session_dir === "string" && isAbsolute(markerJson.session_dir)) {
          return markerJson.session_dir;
        }
      } catch {
        return undefined;
      }
      return undefined;
    }));
  return sessionDirectories.filter((sessionDirectory): sessionDirectory is string => sessionDirectory !== undefined);
}

export async function writeState(
  phase: RunPhase,
  sessionDirectory: string,
  details: Readonly<Record<string, string>> = {},
): Promise<RunState> {
  await ensureRunDirectory();
  const previousState = await readState(sessionDirectory);
  const state: Record<string, string> = previousState.session_dir === sessionDirectory
    ? { ...previousState }
    : {};
  const updatedAt = localIsoSeconds(new Date());
  Object.assign(state, { phase, session_dir: sessionDirectory }, details);
  if (phase !== "failed") delete state.error;
  state.started_at ??= updatedAt;
  if (phase === "stopping" || phase === "recorded" || phase === "analyzing") state.stopped_at ??= updatedAt;

  await writeStateFile(sessionStatePath(sessionDirectory), state);
  if (phase === "starting") await writeStateFile(STATE_PATH, state);
  if (phase === "analyzing") await markSessionActive(sessionDirectory);
  if (phase === "recorded" || phase === "completed" || phase === "failed" || phase === "interrupted") {
    await clearActiveSessionMarker(sessionDirectory);
  }
  return { ...state, phase };
}
