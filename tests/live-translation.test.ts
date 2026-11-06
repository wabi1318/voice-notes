import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveTranslation, TRANSLATION_ERROR_FILENAME, TRANSLATION_FILENAME } from "../src/live-translation.ts";

test("発言を順番に翻訳し、停止時には末尾の発言も保存する", async () => {
  const session = await mkdtemp(join(tmpdir(), "voice-note-translation-"));
  try {
    const calls: string[] = [];
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    let closed = false;
    const translation = await startLiveTranslation(session, {
      async translate(text) {
        calls.push(text);
        activeCalls += 1;
        maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeCalls -= 1;
        return `訳: ${text}`;
      },
      async close() { closed = true; },
    });
    translation.appendTranscriptChunk(Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\n<v System>Hello.\n\n"));
    translation.appendTranscriptChunk(Buffer.from("00:01.000 --> 00:02.000\n<v Mic>Thanks."));
    await translation.finish();
    await translation.finish();
    expect(calls).toEqual(["Hello.", "Thanks."]);
    expect(maximumActiveCalls).toBe(1);
    expect(closed).toBe(true);
    expect(await readFile(join(session, TRANSLATION_FILENAME), "utf8")).toBe(
      "WEBVTT\n\n00:00.000 --> 00:01.000\n<v System>訳: Hello.\n\n00:01.000 --> 00:02.000\n<v Mic>訳: Thanks.\n\n",
    );
  } finally { await rm(session, { recursive: true, force: true }); }
});

test("翻訳が失敗しても終了を妨げず、原文を残してエラーを保存する", async () => {
  const session = await mkdtemp(join(tmpdir(), "voice-note-translation-error-"));
  try {
    const rawPath = join(session, "raw.vtt");
    const rawText = "WEBVTT\n\n00:00.000 --> 00:01.000\n<v System>Hello.\n\n00:01.000 --> 00:02.000\n<v System>Again.\n\n";
    await writeFile(rawPath, rawText);
    let attempts = 0;
    let closed = false;
    const translation = await startLiveTranslation(session, {
      async translate() { attempts += 1; throw new Error("翻訳サービスに接続できません"); },
      async close() { closed = true; },
    });
    translation.appendTranscriptChunk(Buffer.from(rawText));
    await translation.finish();
    expect(attempts).toBe(1);
    expect(closed).toBe(true);
    expect(await readFile(rawPath, "utf8")).toBe(rawText);
    expect(await readFile(join(session, TRANSLATION_ERROR_FILENAME), "utf8")).toContain("翻訳サービスに接続できません");
  } finally { await rm(session, { recursive: true, force: true }); }
});
