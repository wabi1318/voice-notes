import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ChildExit = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
export type ChildSignalTarget = Readonly<{ processId: number }>;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function requireCommand(commandName: string): Promise<string> {
  const commandCandidates = commandName.includes("/") || isAbsolute(commandName)
    ? [resolve(commandName)]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => resolve(directory, commandName));

  for (const commandPath of commandCandidates) {
    try {
      const commandStat = await stat(commandPath);
      if (!commandStat.isFile()) continue;
      await access(commandPath, constants.X_OK);
      return commandPath;
    } catch (error) {
      if (isNodeError(error) && error.code !== "ENOENT" && error.code !== "EACCES" && error.code !== "ENOTDIR") throw error;
    }
  }
  throw new Error(`${commandName}が見つかりません。インストール後に再実行してください。`);
}

export function startCommand(commandPath: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
  return spawn(commandPath, [...args], options);
}

export async function openDirectoryInFinder(directoryPath: string): Promise<void> {
  if (!(await stat(directoryPath)).isDirectory()) throw new Error("保存フォルダが見つかりません");
  const childProcess = startCommand("/usr/bin/open", ["-a", "Finder", directoryPath], { stdio: "ignore" });
  const exit = await waitForChild(childProcess);
  if (exit.code !== 0) throw new Error("Finderで保存フォルダを開けませんでした");
}

export function sendChildSignal(childProcess: ChildProcess, signal: NodeJS.Signals): boolean {
  if (childProcess.pid === undefined) return false;
  return sendProcessSignal(childProcess.pid, signal);
}

export function sendProcessSignal(processId: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(processId, signal);
    return true;
  } catch {
    return false;
  }
}

export function waitForChild(
  childProcess: ChildProcess,
  timeoutMs?: number,
  signalTarget?: ChildSignalTarget,
): Promise<ChildExit> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timeout: NodeJS.Timeout | undefined;
    let forceStop: NodeJS.Timeout | undefined;
    let didTimeout = false;
    let didForceStop = false;

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceStop !== undefined) clearTimeout(forceStop);
      childProcess.off("error", handleError);
      childProcess.off("close", handleClose);
    };

    const handleError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };

    const handleClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (didForceStop) {
        rejectPromise(new Error("録音プロセスが停止しませんでした"));
        return;
      }
      resolvePromise({ code: didTimeout ? null : code, signal });
    };

    childProcess.once("error", handleError);
    childProcess.once("close", handleClose);

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        didTimeout = true;
        const target = signalTarget ?? (childProcess.pid === undefined ? undefined : { processId: childProcess.pid });
        if (target !== undefined) sendProcessSignal(target.processId, "SIGTERM");
        forceStop = setTimeout(() => {
          didForceStop = true;
          if (target !== undefined) sendProcessSignal(target.processId, "SIGKILL");
        }, 5_000);
      }, timeoutMs);
    }
  });
}
