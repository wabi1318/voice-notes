import { rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const INTERRUPTED_EXIT_CODE = 130;
const FORCE_STOP_GRACE_MS = 4_000;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

// lockfが録音の終了までロックを保持できるように、ここで起動と出力中継を行う。
async function runLockedCapture(argumentsList: readonly string[]): Promise<number> {
  const [readyPath, capturePath, ...captureArguments] = argumentsList;
  if (readyPath === undefined || capturePath === undefined) {
    process.stderr.write("文字起こしの起動情報がありません\n");
    return 2;
  }

  let captureProcess: ChildProcess | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let outputErrorHandler: ((error: Error) => void) | undefined;
  let readiness: Promise<void> | undefined;
  let readinessError: unknown;
  const forwardSignal = (signal: NodeJS.Signals) => {
    receivedSignal = signal;
    if (captureProcess === undefined) return;
    const activeCaptureProcess = captureProcess;
    activeCaptureProcess.kill(signal);
    if (signal === "SIGTERM") {
      forceKillTimer = setTimeout(() => activeCaptureProcess.kill("SIGKILL"), FORCE_STOP_GRACE_MS);
    }
  };
  const handleInterrupt = () => forwardSignal("SIGINT");
  const handleTerminate = () => forwardSignal("SIGTERM");

  try {
    captureProcess = spawn(capturePath, captureArguments, {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (captureProcess.stdout === null) throw new Error("文字起こしを受け取れませんでした");
    let canDisplayTranscript = true;
    outputErrorHandler = (error: Error) => {
      canDisplayTranscript = false;
      captureProcess?.stdout?.resume();
      if (isNodeError(error) && error.code === "EPIPE") {
        return;
      }
      process.stderr.write(`文字起こしの表示に失敗しました: ${error.message}\n`);
    };
    process.stdout.on("error", outputErrorHandler);
    captureProcess.stdout.on("data", (chunk: Buffer) => {
      readiness ??= (async () => {
        const temporaryReadyPath = `${readyPath}.tmp`;
        await writeFile(temporaryReadyPath, String(process.pid), { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporaryReadyPath, readyPath);
      })().catch((error: unknown) => {
        readinessError = error;
        forwardSignal("SIGTERM");
      });
      if (!canDisplayTranscript) return;
      if (!process.stdout.write(chunk)) {
        captureProcess?.stdout?.pause();
        process.stdout.once("drain", () => captureProcess?.stdout?.resume());
      }
    });
    process.once("SIGINT", handleInterrupt);
    process.once("SIGTERM", handleTerminate);

    const exitPromise = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolvePromise, rejectPromise) => {
      captureProcess?.once("error", rejectPromise);
      captureProcess?.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    void exitPromise.catch(() => undefined);
    const exit = await exitPromise;
    await readiness;
    if (readinessError !== undefined) throw readinessError;
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    if (exit.code !== null) return exit.code;
    if (receivedSignal === "SIGINT" || exit.signal === "SIGINT") return INTERRUPTED_EXIT_CODE;
    return 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    process.off("SIGINT", handleInterrupt);
    process.off("SIGTERM", handleTerminate);
    if (outputErrorHandler !== undefined) process.stdout.off("error", outputErrorHandler);
    await unlink(readyPath).catch(() => undefined);
    await unlink(`${readyPath}.tmp`).catch(() => undefined);
  }
}

process.umask(0o077);
void runLockedCapture(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
