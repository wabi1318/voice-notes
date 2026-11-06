import { chmod, open, access } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_DIR } from "./config.ts";
import { startCommand, waitForChild } from "./processes.ts";
import type { ChildProcess } from "node:child_process";

// 移行中もPython実装と同じロックファイルを共用して二重録音を防ぐ。
const LOCKF_COMMAND = "/usr/bin/lockf";
const LOCK_HOLDER_SCRIPT = join(PROJECT_DIR, "src", "lock-holder.ts");
const LOCK_RETRY_INTERVAL_MS = 50;

export type ProcessLock = Readonly<{ release: () => Promise<void> }>;

type LockAttempt =
  | Readonly<{ kind: "acquired"; lock: ProcessLock }>
  | Readonly<{ kind: "held" }>;

type LockStart =
  | Readonly<{ kind: "started"; lock: ProcessLock }>
  | Readonly<{ kind: "held" }>;
type LockOutcome =
  | Readonly<{ kind: "ready"; ready: boolean }>
  | Readonly<{ kind: "exit"; exit: Awaited<ReturnType<typeof waitForChild>> }>;

async function ensureLockFile(lockPath: string): Promise<void> {
  const lockFile = await open(lockPath, "a", 0o600);
  await lockFile.close();
  await chmod(lockPath, 0o600);
}

function waitForLockHolder(childProcess: ChildProcess): Promise<boolean> {
  const output = childProcess.stdout;
  if (output === null) return Promise.resolve(false);

  return new Promise((resolvePromise, rejectPromise) => {
    let outputText = "";
    const cleanup = () => {
      output.off("data", handleData);
      output.off("end", handleEnd);
      output.off("error", handleError);
    };
    const handleData = (chunk: Buffer) => {
      outputText += chunk.toString("utf8");
      const newlineIndex = outputText.indexOf("\n");
      if (newlineIndex < 0) return;
      cleanup();
      resolvePromise(outputText.slice(0, newlineIndex) === "LOCKED");
    };
    const handleEnd = () => {
      cleanup();
      resolvePromise(false);
    };
    const handleError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };

    output.on("data", handleData);
    output.once("end", handleEnd);
    output.once("error", handleError);
  });
}

async function startLockHolder(lockPath: string): Promise<LockStart> {
  await ensureLockFile(lockPath);
  const lockArguments = ["-k", "-n", "-t", "0", lockPath, process.execPath, "run", LOCK_HOLDER_SCRIPT];
  const childProcess = startCommand(LOCKF_COMMAND, lockArguments, {
    detached: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  if (childProcess.stdin === null) throw new Error("排他ロックを保持できませんでした");

  const exitPromise = waitForChild(childProcess);
  void exitPromise.catch(() => undefined);
  const readyPromise = waitForLockHolder(childProcess);
  const outcomes: Promise<LockOutcome>[] = [
    readyPromise.then((ready) => ({ kind: "ready", ready })),
    exitPromise.then((exit) => ({ kind: "exit", exit })),
  ];
  const outcome = await Promise.race(outcomes);

  if (outcome.kind === "exit") {
    if (outcome.exit.code === 75) return { kind: "held" };
    throw new Error(`排他ロックを開始できませんでした: ${lockPath}`);
  }
  if (!outcome.ready) {
    const exit = await exitPromise;
    if (exit.code === 75) return { kind: "held" };
    throw new Error(`排他ロックを開始できませんでした: ${lockPath}`);
  }

  let releasePromise: Promise<void> | undefined;
  return {
    kind: "started",
    lock: {
      release() {
        releasePromise ??= (async () => {
          if (childProcess.stdin !== null && !childProcess.stdin.destroyed) childProcess.stdin.end();
          const exit = await exitPromise;
          if (exit.code !== 0) throw new Error(`排他ロックを解放できませんでした: ${lockPath}`);
        })();
        return releasePromise;
      },
    },
  };
}

export async function tryAcquireProcessLock(lockPath: string): Promise<LockAttempt> {
  const result = await startLockHolder(lockPath);
  return result.kind === "held" ? result : { kind: "acquired", lock: result.lock };
}

export async function acquireProcessLock(lockPath: string, maxWaitMs?: number): Promise<ProcessLock> {
  const deadline = maxWaitMs === undefined ? undefined : Date.now() + maxWaitMs;
  while (true) {
    const result = await startLockHolder(lockPath);
    if (result.kind === "started") return result.lock;
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new Error("操作の待ち時間を超えました。別の操作が終了していない可能性があります。");
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_INTERVAL_MS));
  }
}

export async function isProcessLockActive(lockPath: string): Promise<boolean> {
  try {
    await access(lockPath);
  } catch {
    return false;
  }

  try {
    const probe = startCommand(LOCKF_COMMAND, ["-k", "-n", "-t", "0", lockPath, "/usr/bin/true"], {
      stdio: "ignore",
    });
    const exit = await waitForChild(probe);
    return exit.code === 75;
  } catch {
    return false;
  }
}
