import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDashboard } from "./dashboard.ts";
import { resolveOutputRoot } from "./storage.ts";

const CLI_COMMAND = process.env.VOICE_NOTE_COMMAND ?? "voice-note";
const USAGE = `使い方: ${CLI_COMMAND}

ターミナルの操作画面を開きます。
録音・停止・記録の閲覧・フォルダ作成は画面から操作してください。

  -h, --help  このヘルプを表示する`;

async function main(): Promise<number> {
  process.umask(0o077);
  try {
    const argumentsList = process.argv.slice(2);
    if (argumentsList.length === 1 && (argumentsList[0] === "--help" || argumentsList[0] === "-h")) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (argumentsList.length > 0) {
      throw new Error(`操作コマンドは廃止しました。${CLI_COMMAND}を引数なしで起動して画面から操作してください。`);
    }
    await runDashboard(await resolveOutputRoot());
    return 0;
  } catch (error) {
    process.stderr.write(`エラー: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isCliEntry(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
