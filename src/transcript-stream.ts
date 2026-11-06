import { StringDecoder } from "node:string_decoder";

export type TranscriptCue = Readonly<{
  timing: string;
  speaker: "Mic" | "System";
  text: string;
}>;

const CUE_TIMING = /^\d{2}:\d{2}(?::\d{2})?\.\d{3}\s+-->\s+\d{2}:\d{2}(?::\d{2})?\.\d{3}$/u;

function parseTranscriptCue(block: string): TranscriptCue | undefined {
  const lines = block.trim().split("\n");
  const timingIndex = lines.findIndex((line) => CUE_TIMING.test(line.trim()));
  if (timingIndex < 0) return undefined;
  const timing = lines[timingIndex]?.trim();
  const body = lines.slice(timingIndex + 1).join(" ").trim();
  const voice = /^<v (Mic|System)>([\s\S]*)$/u.exec(body);
  const speaker = voice?.[1];
  const text = voice?.[2]?.replaceAll("</v>", "").trim();
  if (timing === undefined || !text || (speaker !== "Mic" && speaker !== "System")) return undefined;
  return { timing, speaker, text };
}

export class TranscriptCueDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pendingText = "";
  private ended = false;

  decodeChunk(chunk: Buffer): TranscriptCue[] {
    if (this.ended) return [];
    this.pendingText += this.decoder.write(chunk);
    return this.takeCompletedCues(false);
  }

  finish(): TranscriptCue[] {
    if (this.ended) return [];
    this.ended = true;
    this.pendingText += this.decoder.end();
    return this.takeCompletedCues(true);
  }

  private takeCompletedCues(includeLastBlock: boolean): TranscriptCue[] {
    const blocks = this.pendingText.replaceAll("\r\n", "\n").split("\n\n");
    this.pendingText = includeLastBlock ? "" : blocks.pop() ?? "";
    return blocks.flatMap((block) => {
      const cue = parseTranscriptCue(block);
      return cue === undefined ? [] : [cue];
    });
  }
}
