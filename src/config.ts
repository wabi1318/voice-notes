import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = existsSync(join(PROJECT_DIR, ".git"))
  ? PROJECT_DIR
  : join(homedir(), "Library", "Application Support", "Voice Notes");
export const DEFAULT_SESSIONS_DIR = join(DATA_DIR, "sessions");

function expandHomePath(path: string): string {
  if (path === "~") return process.env.HOME ?? path;
  if (path.startsWith("~/")) return join(process.env.HOME ?? "~", path.slice(2));
  return isAbsolute(path) ? path : resolve(path);
}

export const SETTINGS_PATH = resolve(
  expandHomePath(process.env.VOICE_NOTE_SETTINGS_PATH ?? join(DATA_DIR, ".settings.json")),
);
export const RUN_DIR = resolve(
  expandHomePath(process.env.VOICE_NOTE_RUN_DIR ?? join(DATA_DIR, "run")),
);
export const STATE_PATH = join(RUN_DIR, "state.json");
export const LEGACY_CONTROL_SOCKET = join(RUN_DIR, "control.sock");
export const START_LOCK = join(RUN_DIR, "start.lock");
export const RECORD_LOCK = join(RUN_DIR, "record.lock");

export function sessionWorkLockPath(sessionDirectory: string): string {
  return join(sessionDirectory, ".session-work.lock");
}

export const STOP_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 200;
export const WORKER_START_TIMEOUT_MS = 5_000;
export const CAPTURE_START_TIMEOUT_MS = 5_000;
export const CAPTURE_START_POLL_MS = 25;
export const CATEGORY_NAME_MAX_LENGTH = 40;
export const SESSION_NAME_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

export function isSessionName(name: string): boolean {
  return SESSION_NAME_PATTERN.exec(name)?.[0] === name;
}

export function expandPath(path: string): string {
  return resolve(expandHomePath(path));
}
