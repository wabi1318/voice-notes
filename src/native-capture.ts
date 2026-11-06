import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rename, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { PROJECT_DIR, RUN_DIR } from "./config.ts";
import { ensureRunDirectory } from "./state.ts";

const executeFile = promisify(execFile);
const BUILD_TIMEOUT_MS = 120_000;
const SOURCE_HASH_LENGTH = 16;
let preparation: Promise<string> | undefined;

async function compileNativeCapture(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("録音にはmacOSが必要です");
  await ensureRunDirectory();
  const sourcePaths = ["capture.swift", "capture-core.swift"].map((name) => join(PROJECT_DIR, "native", name));
  const infoPath = join(PROJECT_DIR, "native", "capture-info.plist");
  const hash = createHash("sha256");
  for (const path of [...sourcePaths, infoPath]) hash.update(await readFile(path));
  const executable = join(RUN_DIR, `capture-${process.arch}-${hash.digest("hex").slice(0, SOURCE_HASH_LENGTH)}`);
  if (await access(executable).then(() => true).catch(() => false)) return executable;
  const temporaryPath = `${executable}-${randomUUID()}`;
  try {
    await executeFile("/usr/bin/xcrun", [
      "swiftc", "-parse-as-library", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos26.0`,
      "-module-cache-path", join(RUN_DIR, "swift-module-cache"), ...sourcePaths,
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPath,
      "-o", temporaryPath,
    ], { timeout: BUILD_TIMEOUT_MS });
    await rename(temporaryPath, executable);
    return executable;
  } catch (error) {
    throw new Error("録音プログラムを準備できませんでした。macOS 26対応のXcode Command Line Toolsを確認してください。", { cause: error });
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export function prepareNativeCapture(): Promise<string> {
  preparation ??= compileNativeCapture().catch((error: unknown) => {
    preparation = undefined;
    throw error;
  });
  return preparation;
}
