/**
 * Shared editing state between AI创作, 预览, and 导出 steps.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface TimelineSegment {
  segment_index: number;
  segment_text: string;
  video_path: string;
  start_time: number;
  duration: number;
  /** Total available duration from source video for trim range */
  source_duration?: number;
  reason: string;
}

interface EditingState {
  /** API key (user-supplied, overrides env var) */
  apiKey: string;
  /** AI-generated timeline */
  timeline: TimelineSegment[];
  /** Current script */
  script: string;
  /** Selected voice */
  voice: string;
  /** Rendered output path */
  outputPath: string | null;
  /** TTS audio duration in seconds */
  audioDuration: number | null;
  /** Pre-generated TTS audio path */
  audioPath: string | null;
  /** Speech speed (0.5 - 2.0) */
  speechSpeed: number;
  /** Subtitle style */
  subtitleFont: string;
  subtitleFontPath: string;
  subtitleColor: string;
  subtitleSize: number;
  subtitleStrokeColor: string;
  subtitleStrokeWidth: number;
  /** Per-segment subtitle overrides: {text?, x%, y%} */
  subtitleOverrides: Record<number, { text?: string; x?: number; y?: number }>;
  /** Is any step currently running */
  running: boolean;

  setApiKey: (k: string) => void;
  setTimeline: (tl: TimelineSegment[]) => void;
  setScript: (s: string) => void;
  setVoice: (v: string) => void;
  setOutputPath: (p: string | null) => void;
  setAudioDuration: (d: number | null) => void;
  setAudioPath: (p: string | null) => void;
  setSpeechSpeed: (v: number) => void;
  setSubtitleFont: (f: string) => void;
  setSubtitleColor: (c: string) => void;
  setSubtitleSize: (s: number) => void;
  setSubtitleStrokeColor: (c: string) => void;
  setSubtitleStrokeWidth: (w: number) => void;
  setSubtitleFontPath: (p: string) => void;
  setSubtitleOverrides: (o: Record<number, { text?: string; x?: number; y?: number }>) => void;
  setRunning: (r: boolean) => void;
  reset: () => void;
}

const initialState = {
  apiKey: '',
  timeline: [] as TimelineSegment[],
  script: '',
  voice: 'Cherry',
  outputPath: null as string | null,
  audioDuration: null as number | null,
  audioPath: null as string | null,
  /** Speech speed multiplier (0.5-2.0) */
  speechSpeed: 1.0,
  subtitleFont: 'Microsoft YaHei',
  subtitleFontPath: 'C:/Windows/Fonts/msyh.ttc',
  subtitleColor: '#ffffff',
  subtitleSize: 24,
  subtitleStrokeColor: '#000000',
  subtitleStrokeWidth: 2,
  subtitleOverrides: {} as Record<number, { text?: string; x?: number; y?: number }>,
  running: false,
};

export const useEditingStore = create<EditingState>()(
  persist(
    (set) => ({
      ...initialState,
      setApiKey: (apiKey) => set({ apiKey }),
      setTimeline: (timeline) => set({ timeline }),
      setScript: (script) => set({ script }),
      setVoice: (voice) => set({ voice }),
      setOutputPath: (outputPath) => set({ outputPath }),
      setAudioDuration: (audioDuration) => set({ audioDuration }),
      setAudioPath: (audioPath) => set({ audioPath }),
      setSpeechSpeed: (speechSpeed) => set({ speechSpeed }),
      setSubtitleFont: (subtitleFont) => set({ subtitleFont }),
      setSubtitleColor: (subtitleColor) => set({ subtitleColor }),
      setSubtitleSize: (subtitleSize) => set({ subtitleSize }),
      setSubtitleStrokeColor: (subtitleStrokeColor) => set({ subtitleStrokeColor }),
      setSubtitleStrokeWidth: (subtitleStrokeWidth) => set({ subtitleStrokeWidth }),
      setSubtitleFontPath: (subtitleFontPath) => set({ subtitleFontPath }),
      setSubtitleOverrides: (subtitleOverrides) => set({ subtitleOverrides }),
      setRunning: (running) => set({ running }),
      reset: () => set(initialState),
    }),
    {
      name: 'mashup-editing-store',
      partialize: (state) => {
        // Don't persist ephemeral running state
        const { running, ...rest } = state;
        return rest;
      },
    }
  )
);
