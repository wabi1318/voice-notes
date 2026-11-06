import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { CODEX_PROMPT, TITLE_PROMPT } from "./prompts.ts";
import { requireCommand, startCommand, waitForChild } from "./processes.ts";
import { createPrivateSession, ensurePrivateFile } from "./storage.ts";
import type { AnalysisResult } from "./domain.ts";
import { expandPath } from "./config.ts";

const SUMMARY_CODEX_CONFIG = [
  'default_permissions="voice_note_summary"',
  'permissions.voice_note_summary.filesystem={":root"="deny",":minimal"="read"}',
  "permissions.voice_note_summary.network.enabled=false",
  'approval_policy="never"',
  'approvals_reviewer="user"',
  'web_search="disabled"',
  "mcp_servers={}",
  "project_doc_max_bytes=0",
  "skills.include_instructions=false",
  "features.skip_host_skill_discovery=true",
  "features.shell_tool=false",
  "features.shell_snapshot=false",
  "features.view_image=false",
  "features.multi_agent=false",
  "agents.enabled=false",
  "features.apps=false",
  "features.plugins=false",
  "features.hooks=false",
  "features.memories=false",
  "features.skill_search=false",
  "features.tool_suggest=false",
  "features.browser_use=false",
  "features.computer_use=false",
  "features.image_generation=false",
] as const;

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function localFileTimestamp(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

export function sanitizeTitle(title: string): string {
  if (title.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u).length !== 1) return "";
  const normalizedTitle = title.normalize("NFKC");
  const safeTitle = normalizedTitle
    .replace(/[\\/:\x00-\x1f\x7f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[ .]+|[ .]+$/gu, "");
  return Array.from(safeTitle).slice(0, 40).join("").replace(/[ .]+$/gu, "");
}

export async function runCodex(
  inputPath: string,
  outputPath: string,
  prompt: string,
): Promise<boolean> {
  const codexPath = await requireCommand("codex");
  const workingDirectory = await mkdtemp(join(tmpdir(), "voice-note-summary-"));
  try {
    // 発言中の指示から、保存済みの記録や利用者の接続設定を参照できないようにする。
    const argumentsList = [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--skip-git-repo-check",
      ...SUMMARY_CODEX_CONFIG.flatMap((setting) => ["--config", setting]),
      "--cd",
      workingDirectory,
      "--output-last-message",
      resolve(outputPath),
      prompt,
    ];
    const childProcess = startCommand(
      codexPath,
      argumentsList,
      { cwd: workingDirectory, stdio: ["pipe", "ignore", "inherit"] },
    );
    if (childProcess.stdin === null) throw new Error("Codexへ文字起こしを渡せませんでした");
    const exitPromise = waitForChild(childProcess);
    try {
      await pipeline(createReadStream(inputPath), childProcess.stdin);
    } catch {
      await exitPromise.catch(() => undefined);
      return false;
    }
    const exit = await exitPromise;
    return exit.code === 0 && await isFile(outputPath) && (await stat(outputPath)).size > 0;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

async function titleSummary(summaryPath: string, summary: string): Promise<string | undefined> {
  const titleOutputPath = join(dirname(summaryPath), `.title-${randomUUID()}.tmp`);
  try {
    if (!(await runCodex(summaryPath, titleOutputPath, TITLE_PROMPT))) return undefined;
    const title = sanitizeTitle((await readFile(titleOutputPath, "utf8")).trim());
    if (!title) return undefined;

    for (let suffix = 1; suffix < 1_000; suffix += 1) {
      const suffixText = suffix === 1 ? "" : `-${suffix}`;
      const titledPath = join(dirname(summaryPath), `summary-${title}${suffixText}.md`);
      try {
        await ensurePrivateFile(titledPath, `# ${title}\n\n${summary}\n`);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw error;
      }
      await unlink(summaryPath);
      return titledPath;
    }
    return undefined;
  } finally {
    await unlink(titleOutputPath).catch(() => undefined);
  }
}

export async function analyzeTranscript(rawPath: string, outputRoot?: string): Promise<AnalysisResult> {
  const resolvedRawPath = await realpath(expandPath(rawPath));
  if (!(await isFile(resolvedRawPath)) || (await stat(resolvedRawPath)).size === 0) {
    throw new Error(`文字起こしファイルが空です: ${resolvedRawPath}`);
  }

  const destination = outputRoot === undefined ? dirname(resolvedRawPath) : await createPrivateSession(outputRoot);
  const resultPath = join(destination, `result-${localFileTimestamp(new Date())}-${randomUUID().replaceAll("-", "").slice(0, 8)}.md`);
  process.stderr.write("文字起こし本文をCodexへ送信し、修正と要約を作成します。\n");
  if (!(await runCodex(resolvedRawPath, resultPath, CODEX_PROMPT))) {
    throw new Error(`Codexの処理が完了しませんでした。原文は残っています: ${resolvedRawPath}`);
  }

  const resultText = await readFile(resultPath, "utf8");
  if (!/^#{1,6}[ \t]+修正した文字起こし[ \t]*$/mu.test(resultText)) {
    throw new Error(`Codexの出力に必要な節がありません。原文と出力を確認してください: ${resultPath}`);
  }
  const summaryMatch = /^#{1,6}[ \t]+要約[ \t]*$/mu.exec(resultText);
  if (summaryMatch === null) {
    throw new Error(`Codexの出力に要約がありません。原文と出力を確認してください: ${resultPath}`);
  }
  const summaryStart = summaryMatch.index + summaryMatch[0].length;
  const summary = resultText.slice(summaryStart).trim();
  if (!summary) throw new Error(`Codexの要約が空です。原文と出力を確認してください: ${resultPath}`);

  let summaryPath = join(destination, "summary.md");
  if (await access(summaryPath).then(() => true).catch(() => false)) {
    summaryPath = join(destination, `summary-${randomUUID().replaceAll("-", "").slice(0, 8)}.md`);
  }
  await ensurePrivateFile(summaryPath, `# 要約\n\n${summary}\n`);
  const titledPath = await titleSummary(summaryPath, summary);
  if (titledPath === undefined) {
    process.stderr.write(`タイトル生成に失敗しました。要約は保存済みです: ${summaryPath}\n`);
    return { result_path: resultPath, summary_path: summaryPath, title_created: false };
  }
  return { result_path: resultPath, summary_path: titledPath, title_created: true };
}
