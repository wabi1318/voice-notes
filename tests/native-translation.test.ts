import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeTranslator } from "../src/native-translation.ts";

test("翻訳プロセスを使い続け、複数の発言と日本語の応答を対応付ける", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-note-native-test-"));
  try {
    const executable = join(root, "translator");
    await writeFile(executable, `#!/usr/bin/env bun
import { createInterface } from "node:readline";
process.stdout.write(JSON.stringify({ready: true}) + "\\n");
for await (const line of createInterface({input: process.stdin})) {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({id: request.id, text: "訳: " + request.text}) + "\\n");
}
`, { mode: 0o700 });
    const translator = await startNativeTranslator(executable);
    try {
      expect(await translator.translate("Hello.\nGood morning.")).toBe("訳: Hello.\nGood morning.");
      expect(await translator.translate("Thank you.")).toBe("訳: Thank you.");
    } finally { await translator.close(); }
    await expect(translator.translate("Closed")).rejects.toThrow("終了");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("モデルを準備できない場合は録音前に理由を返す", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-note-native-error-"));
  try {
    const executable = join(root, "translator");
    await writeFile(executable, '#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({error: "翻訳言語をダウンロードしてください"}) + "\\n");\n', { mode: 0o700 });
    await expect(startNativeTranslator(executable)).rejects.toThrow("翻訳言語をダウンロードしてください");
  } finally { await rm(root, { recursive: true, force: true }); }
});
