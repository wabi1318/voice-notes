import { expect, test } from "bun:test";
import { TranscriptCueDecoder } from "../src/transcript-stream.ts";

test("分割された入力でも確定した発言だけを一度ずつ取り出す", () => {
  const decoder = new TranscriptCueDecoder();
  const input = Buffer.from("WEBVTT\r\n\r\nNOTE recording\r\n\r\n1\r\n00:00.000 --> 00:01.000\r\n<v System>Hello, café.\r\n\r\n2\r\n00:01.000 --> 00:02.000\r\n<v Mic>Thanks.");
  const cues = [...input].flatMap((byte) => decoder.decodeChunk(Buffer.from([byte])));
  expect(cues).toEqual([{ timing: "00:00.000 --> 00:01.000", speaker: "System", text: "Hello, café." }]);
  expect(decoder.finish()).toEqual([{ timing: "00:01.000 --> 00:02.000", speaker: "Mic", text: "Thanks." }]);
  expect(decoder.finish()).toEqual([]);
});

test("途中の発言と、発言ではない付加情報を翻訳対象にしない", () => {
  const decoder = new TranscriptCueDecoder();
  expect(decoder.decodeChunk(Buffer.from("WEBVTT\n\nNOTE example\n\n00:00.000 --> 00:01.000\n<v System>Good"))).toEqual([]);
  expect(decoder.decodeChunk(Buffer.from(" morning.\n\n")).map((cue) => cue.text)).toEqual(["Good morning."]);
});
