import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, unlink } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { PROJECT_DIR, RUN_DIR } from "./config.ts";
import { ensureRunDirectory } from "./state.ts";
import type { TextTranslator } from "./live-translation.ts";

const executeFile = promisify(execFile);
const BUILD_TIMEOUT_MS = 120_000;
const TRANSLATION_TIMEOUT_MS = 20_000;
const TERMINATION_GRACE_MS = 1_000;
const SOURCE_HASH_LENGTH = 16;
let preparation: Promise<string> | undefined;

async function compileNativeTranslator(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("同時翻訳はmacOSで利用できます");
  await ensureRunDirectory();
  const sourcePath = join(PROJECT_DIR, "native", "translate.swift");
  const digest = createHash("sha256").update(await readFile(sourcePath)).digest("hex").slice(0, SOURCE_HASH_LENGTH);
  const executable = join(RUN_DIR, `translator-${process.arch}-${digest}`);
  if (await access(executable).then(() => true).catch(() => false)) return executable;
  const temporaryPath = `${executable}-${randomUUID()}`;
  try {
    await executeFile("/usr/bin/xcrun", [
      "swiftc", "-parse-as-library", "-O", "-module-cache-path", join(RUN_DIR, "swift-module-cache"),
      sourcePath, "-o", temporaryPath,
    ], { timeout: BUILD_TIMEOUT_MS });
    await rename(temporaryPath, executable);
    return executable;
  } catch (error) {
    throw new Error("翻訳プログラムを準備できませんでした。Xcode Command Line Toolsの導入を確認してください。", { cause: error });
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function prepareNativeTranslator(): Promise<string> {
  preparation ??= compileNativeTranslator().catch((error: unknown) => {
    preparation = undefined;
    throw error;
  });
  return preparation;
}

type PendingReply = Readonly<{
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>;

export async function startNativeTranslator(executable?: string): Promise<TextTranslator> {
  const command = executable ?? await prepareNativeTranslator();
  const child = spawn(command, [], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, PendingReply>();
  let nextId = 0;
  let closed = false;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;

  function rejectPending(error: Error): void {
    for (const reply of pending.values()) {
      clearTimeout(reply.timer);
      reply.reject(error);
    }
    pending.clear();
  }

  function terminate(): void {
    if (closed) return;
    child.kill("SIGTERM");
    terminationTimer ??= setTimeout(() => child.kill("SIGKILL"), TERMINATION_GRACE_MS);
    terminationTimer.unref();
  }

  const completion = new Promise<void>((resolveClose) => {
    child.once("error", (error) => rejectPending(error));
    child.once("close", () => {
      closed = true;
      if (terminationTimer !== undefined) clearTimeout(terminationTimer);
      lines.close();
      rejectPending(new Error("macOSの翻訳プロセスが終了しました"));
      resolveClose();
    });
  });
  child.stdin.on("error", (error) => { rejectPending(error); terminate(); });
  lines.on("line", (line) => {
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) throw new Error("翻訳結果の形式が不正です");
      const id = "id" in value && typeof value.id === "number" ? value.id : 0;
      const reply = pending.get(id);
      if (reply === undefined) return;
      clearTimeout(reply.timer);
      pending.delete(id);
      if ("error" in value && typeof value.error === "string") reply.reject(new Error(value.error));
      else if ("ready" in value && value.ready === true && id === 0) reply.resolve("");
      else if ("text" in value && typeof value.text === "string") reply.resolve(value.text);
      else reply.reject(new Error("翻訳結果の形式が不正です"));
    } catch (error) {
      rejectPending(error instanceof Error ? error : new Error(String(error)));
      terminate();
    }
  });

  function receiveReply(id: number): Promise<string> {
    if (closed) return Promise.reject(new Error("翻訳プロセスは終了しています"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("macOSの翻訳サービスが応答しません。英語・日本語の翻訳言語の設定を確認してください。"));
        terminate();
      }, TRANSLATION_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
    });
  }

  try { await receiveReply(0); } catch (error) { terminate(); await completion; throw error; }
  return {
    translate(text) {
      nextId += 1;
      const response = receiveReply(nextId);
      if (!closed) child.stdin.write(`${JSON.stringify({ id: nextId, text })}\n`);
      return response;
    },
    async close() {
      if (!closed) {
        child.stdin.end();
        terminationTimer ??= setTimeout(() => {
          terminationTimer = undefined;
          terminate();
        }, TERMINATION_GRACE_MS);
      }
      await completion;
    },
  };
}
