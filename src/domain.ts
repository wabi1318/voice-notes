export type RunPhase =
  | "idle"
  | "starting"
  | "recording"
  | "recorded"
  | "stopping"
  | "analyzing"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export type RunState = Readonly<Record<string, string>> & Readonly<{ phase: RunPhase }>;

export type TranslationMode = "off" | "en-ja";
export type RecognitionLanguage = "ja-JP" | "en-US";

export function getRecognitionLanguage(state: Readonly<{
  recognition_language?: string;
  translation_mode?: string;
}>): RecognitionLanguage {
  if (state.recognition_language === "ja-JP" || state.recognition_language === "en-US") return state.recognition_language;
  // 言語を保存していない旧記録は、録音時の翻訳設定から復元する。
  return state.translation_mode === "en-ja" ? "en-US" : "ja-JP";
}

export type PublicStatus = Readonly<{
  phase: RunPhase;
  active_analysis_count?: number;
  active_analysis_sessions?: readonly string[];
  session_dir?: string;
  session_id?: string;
  started_at?: string;
  stopped_at?: string;
  category_folder?: string;
  output_root?: string;
  error?: string;
  raw_path?: string;
  result_path?: string;
  summary_path?: string;
  translation_mode?: TranslationMode;
  recognition_language?: RecognitionLanguage;
  translation_path?: string;
}>;

export type VoiceNoteRecord = Readonly<{
  session_id: string;
  session_dir: string;
  started_at: string;
  category_folder: string;
  title: string;
  raw_path?: string;
  result_path?: string;
  summary_path?: string;
}>;

export type AnalysisResult = Readonly<{
  result_path: string;
  summary_path: string;
  title_created: boolean;
}>;

export type ControlResponse = Readonly<Record<string, string>>;
