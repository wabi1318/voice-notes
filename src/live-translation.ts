import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensurePrivateFile } from "./storage.ts";
import { TranscriptCueDecoder, type TranscriptCue } from "./transcript-stream.ts";

export const TRANSLATION_FILENAME = "translation.vtt";
export const TRANSLATION_ERROR_FILENAME = ".translation-error.txt";

export type TextTranslator = Readonly<{
  translate: (text: string) => Promise<string>;
  close: () => Promise<void>;
}>;

export async function startLiveTranslation(sessionDirectory: string, translator: TextTranslator): Promise<Readonly<{
  appendTranscriptChunk: (chunk: Buffer) => void;
  finish: () => Promise<void>;
}>> {
  const translationPath = join(sessionDirectory, TRANSLATION_FILENAME);
  const errorPath = join(sessionDirectory, TRANSLATION_ERROR_FILENAME);
  await ensurePrivateFile(translationPath, "WEBVTT\n\n");
  const decoder = new TranscriptCueDecoder();
  let queuedWork = Promise.resolve();
  let failed = false;
  let finished = false;
  let completion: Promise<void> | undefined;

  async function saveTranslationError(error: unknown): Promise<void> {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    await writeFile(errorPath, message, { encoding: "utf8", mode: 0o600 }).catch(() => {
      process.stderr.write("翻訳のエラー記録を保存できませんでした\n");
    });
  }

  function enqueueCues(cues: readonly TranscriptCue[]): void {
    for (const cue of cues) {
      queuedWork = queuedWork.then(async () => {
        if (failed) return;
        const translated = (await translator.translate(cue.text)).replace(/\r?\n/gu, " ").trim();
        if (!translated) throw new Error("翻訳結果が空でした");
        await appendFile(translationPath, `${cue.timing}\n<v ${cue.speaker}>${translated}\n\n`, { mode: 0o600 });
      }).catch(saveTranslationError);
    }
  }

  return {
    appendTranscriptChunk(chunk) {
      if (failed || finished) return;
      enqueueCues(decoder.decodeChunk(chunk));
    },
    finish() {
      if (completion !== undefined) return completion;
      finished = true;
      if (!failed) enqueueCues(decoder.finish());
      completion = (async () => {
        await queuedWork;
        await translator.close().catch(saveTranslationError);
      })();
      return completion;
    },
  };
}
