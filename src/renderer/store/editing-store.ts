/**
 * Shared editing state between AI创作, 预览, and 导出 steps.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

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

/** TTS 服务商：千问（默认）| 豆包（火山引擎）。用于约束 ttsApiKeys 的 key 与切换逻辑。 */
export type TtsProvider = 'qwen' | 'doubao';

interface EditingState {
  /** 画面分析：分析模型（如 gpt-5.5），可切换 */
  analysisModel: string;
  /** 画面分析：用户自备 API Key（覆盖环境变量） */
  analysisApiKey: string;
  /** TTS provider: "qwen" (default) | "doubao" (Volcano Engine) */
  ttsProvider: TtsProvider;
  /** 各 TTS 服务商的 API Key（切换不丢） */
  ttsApiKeys: Record<TtsProvider, string>;
  /** AI-generated timeline */
  timeline: TimelineSegment[];
  /** Currently selected timeline segment (array index), null = none */
  selectedSegmentIndex: number | null;
  /** Current script */
  script: string;
  /** Selected voice */
  voice: string;
  /** Rendered output path */
  outputPath: string | null;
  /** User-customized export directory (absolute path). Null = use backend default (TEMP_DIR/outputs). */
  outputDir: string | null;
  /** TTS audio duration in seconds */
  audioDuration: number | null;
  /** Pre-generated TTS audio path */
  audioPath: string | null;
  /** TTS 音频版本号：每次 split-tts 成功自增，用于强制前端丢弃旧音频缓存（同路径覆盖场景） */
  audioVersion: number;
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
  /** Video cover */
  coverVideoPath: string;
  coverTime: number;
  coverTitle: string;
  coverSubtitle: string;
  coverTitleX: number;
  coverTitleY: number;
  coverSubX: number;
  coverSubY: number;
  /** Cover-specific style (independent from subtitle) */
  coverTitleSize: number;
  coverSubSize: number;
  coverTitleColor: string;
  coverSubColor: string;
  coverTitleStrokeColor: string;
  coverTitleStrokeWidth: number;
  coverSubStrokeColor: string;
  coverSubStrokeWidth: number;
  coverTitleItalic: boolean;
  coverSubItalic: boolean;
  coverAspect: string;  // '9:16' or '3:4'
  /** 主视频画幅（预览+导出共用的全局设置）。9:16 → 1080×1920；3:4 → 1440×1920。 */
  videoAspect: '9:16' | '3:4';
  /** 主视频输出分辨率：1080p(宽1080) / 2K(宽1440)。与画幅正交，独立可调。 */
  videoResolution: '1080p' | '2K';
  coverZoom: number;
  coverOffsetX: number;
  coverOffsetY: number;
  /** Cover-specific font */
  coverFont: string;
  coverFontPath: string;
  /** Font favorites + recently-used (persisted to localStorage). Separate per
   *  context: subtitle vs cover. Stored as font NAME lists. */
  favSubtitleFonts: string[];
  favCoverFonts: string[];
  recentSubtitleFonts: string[];
  recentCoverFonts: string[];
  /** Is any step currently running */
  running: boolean;
  /** API Key 软校验错误标记（跨组件通信：右栏输入区 ↔ 主区域 handleRun） */
  analysisKeyError: boolean;
  ttsKeyError: boolean;
  /** Background music */
  bgmName: string;        // file name in music library (empty = none)
  bgmVolume: number;      // 0-100 (%)
  voiceVolume: number;    // 0-100 (%)

  setAnalysisModel: (m: string) => void;
  setAnalysisApiKey: (k: string) => void;
  setTtsProvider: (p: TtsProvider) => void;
  setTtsApiKey: (provider: TtsProvider, key: string) => void;
  setTimeline: (tl: TimelineSegment[]) => void;
  setSelectedSegmentIndex: (i: number | null) => void;
  /** 拖拽重排：把 fromIndex 的片段移动到 toIndex。重排后重编 segment_index，
   *  并重映射 subtitleOverrides 的键，让每段字幕覆盖跟随自己的片段。
   *  仅在松手时调用一次（拖拽过程中不写 store）。 */
  reorderTimeline: (fromIndex: number, toIndex: number) => void;
  /** 点选替换片段素材：保留原入点，越界自动钳位到 [0, sourceDuration - duration]。
   *  sourceDuration ≤ 0（未知时长）时仅换路径，不覆写 source_duration、不钳位。 */
  replaceSegmentVideo: (index: number, videoPath: string, sourceDuration: number) => void;
  /** 设置片段入点（P2 Trim 用），钳位到 [0, (source_duration||duration) - duration]。 */
  setSegmentInPoint: (index: number, t: number) => void;
  setScript: (s: string) => void;
  setVoice: (v: string) => void;
  setOutputPath: (p: string | null) => void;
  setOutputDir: (d: string | null) => void;
  setAudioDuration: (d: number | null) => void;
  setAudioPath: (p: string | null) => void;
  bumpAudioVersion: () => void;
  setSpeechSpeed: (v: number) => void;
  setSubtitleFont: (f: string) => void;
  setSubtitleColor: (c: string) => void;
  setSubtitleSize: (s: number) => void;
  setSubtitleStrokeColor: (c: string) => void;
  setSubtitleStrokeWidth: (w: number) => void;
  setSubtitleFontPath: (p: string) => void;
  setSubtitleOverrides: (o: Record<number, { text?: string; x?: number; y?: number }>) => void;
  setCoverVideoPath: (p: string) => void;
  setCoverTime: (t: number) => void;
  setCoverTitle: (t: string) => void;
  setCoverSubtitle: (t: string) => void;
  setCoverTitleX: (x: number) => void;
  setCoverTitleY: (y: number) => void;
  setCoverSubX: (x: number) => void;
  setCoverSubY: (y: number) => void;
  setCoverTitleSize: (s: number) => void;
  setCoverSubSize: (s: number) => void;
  setCoverTitleColor: (c: string) => void;
  setCoverSubColor: (c: string) => void;
  setCoverTitleStrokeColor: (c: string) => void;
  setCoverTitleStrokeWidth: (w: number) => void;
  setCoverSubStrokeColor: (c: string) => void;
  setCoverSubStrokeWidth: (w: number) => void;
  setCoverTitleItalic: (v: boolean) => void;
  setCoverSubItalic: (v: boolean) => void;
  setCoverAspect: (v: string) => void;
  setVideoAspect: (v: '9:16' | '3:4') => void;
  setVideoResolution: (v: '1080p' | '2K') => void;
  setCoverZoom: (v: number) => void;
  setCoverOffsetX: (v: number) => void;
  setCoverOffsetY: (v: number) => void;
  setCoverFont: (f: string) => void;
  setCoverFontPath: (p: string) => void;
  /** 重置所有封面设置到默认值（入口卡片 hover 的「重置封面」操作） */
  resetCover: () => void;
  toggleFavSubtitleFont: (name: string) => void;
  toggleFavCoverFont: (name: string) => void;
  pushRecentSubtitleFont: (name: string) => void;
  pushRecentCoverFont: (name: string) => void;
  setRunning: (r: boolean) => void;
  setAnalysisKeyError: (v: boolean) => void;
  setTtsKeyError: (v: boolean) => void;
  setBgmName: (n: string) => void;
  setBgmVolume: (v: number) => void;
  setVoiceVolume: (v: number) => void;
  reset: () => void;
}

const initialState = {
  analysisModel: 'gpt-5.5',
  analysisApiKey: '',
  ttsProvider: 'qwen' as TtsProvider,
  ttsApiKeys: { qwen: '', doubao: '' },
  timeline: [] as TimelineSegment[],
  selectedSegmentIndex: null as number | null,
  script: '',
  voice: 'Cherry',
  outputPath: null as string | null,
  outputDir: null as string | null,
  audioDuration: null as number | null,
  audioPath: null as string | null,
  audioVersion: 0,
  /** Speech speed multiplier (0.5-2.0) */
  speechSpeed: 1.0,
  subtitleFont: 'Microsoft YaHei',
  subtitleFontPath: 'C:/Windows/Fonts/msyh.ttc',
  subtitleColor: '#ffffff',
  subtitleSize: 7,
  subtitleStrokeColor: '#000000',
  subtitleStrokeWidth: 2,
  subtitleOverrides: {} as Record<number, { text?: string; x?: number; y?: number }>,
  coverVideoPath: '',
  coverTime: 0,
  coverTitle: '',
  coverSubtitle: '',
  coverTitleX: 50,
  coverTitleY: 35,
  coverSubX: 50,
  coverSubY: 55,
  coverTitleSize: 48,
  coverSubSize: 24,
  coverTitleColor: '#ffffff',
  coverSubColor: '#cccccc',
  coverTitleStrokeColor: '#000000',
  coverTitleStrokeWidth: 2,
  coverSubStrokeColor: '#000000',
  coverSubStrokeWidth: 2,
  coverTitleItalic: false,
  coverSubItalic: false,
  coverAspect: '9:16',
  videoAspect: '9:16' as const,
  videoResolution: '1080p' as const,
  coverZoom: 1.0,
  coverOffsetX: 0,
  coverOffsetY: 0,
  coverFont: 'Microsoft YaHei',
  coverFontPath: 'C:/Windows/Fonts/msyh.ttc',
  favSubtitleFonts: [] as string[],
  favCoverFonts: [] as string[],
  recentSubtitleFonts: [] as string[],
  recentCoverFonts: [] as string[],
  running: false,
  analysisKeyError: false,
  ttsKeyError: false,
  bgmName: '',
  bgmVolume: 80,
  voiceVolume: 100,
};

export const useEditingStore = create<EditingState>()(
  persist(
    (set) => ({
      ...initialState,
  setAnalysisModel: (analysisModel) => set({ analysisModel }),
  setAnalysisApiKey: (analysisApiKey) => set({ analysisApiKey }),
  setTtsProvider: (ttsProvider) => set({ ttsProvider }),
  setTtsApiKey: (provider, key) => set((s) => ({ ttsApiKeys: { ...s.ttsApiKeys, [provider]: key } })),
  setTimeline: (timeline) => set((s) => ({
    timeline,
    // 时间线被整体替换（重新生成/时长调整等）时，钳位选中索引避免悬空
    selectedSegmentIndex:
      s.selectedSegmentIndex !== null && s.selectedSegmentIndex < timeline.length
        ? s.selectedSegmentIndex
        : null,
  })),
  setSelectedSegmentIndex: (selectedSegmentIndex) => set({ selectedSegmentIndex }),
  reorderTimeline: (fromIndex, toIndex) => set((s) => {
    const n = s.timeline.length;
    if (
      fromIndex === toIndex ||
      fromIndex < 0 || fromIndex >= n ||
      toIndex < 0 || toIndex >= n
    ) return {};
    // order[newPos] = oldPos —— 先算位置映射，再一次性重排
    const order = s.timeline.map((_, i) => i);
    const [moved] = order.splice(fromIndex, 1);
    order.splice(toIndex, 0, moved);
    const timeline = order.map((oldIdx, newIdx) => ({
      ...s.timeline[oldIdx],
      segment_index: newIdx,
    }));
    // subtitleOverrides 以数组下标为键：重映射，让覆盖跟随原片段
    const subtitleOverrides: EditingState['subtitleOverrides'] = {};
    order.forEach((oldIdx, newIdx) => {
      const ov = s.subtitleOverrides[oldIdx];
      if (ov) subtitleOverrides[newIdx] = ov;
    });
    // 选中态跟随被移动的片段
    let selectedSegmentIndex = s.selectedSegmentIndex;
    if (selectedSegmentIndex !== null) {
      const newSel = order.indexOf(selectedSegmentIndex);
      selectedSegmentIndex = newSel >= 0 ? newSel : null;
    }
    return { timeline, subtitleOverrides, selectedSegmentIndex };
  }),
  replaceSegmentVideo: (index, videoPath, sourceDuration) => set((s) => {
    const seg = s.timeline[index];
    if (!seg) return {};
    // 守卫：sourceDuration 无效（≤0 = 素材探测失败/未探测）时仅换路径——
    // 不覆写 source_duration、不钳位 start_time（后端渲染有 tpad 溢出保护），
    // 避免 source_duration=0 引发红色「!」误报和入点被错误归零。
    if (sourceDuration <= 0) {
      const timeline = s.timeline.map((g, i) =>
        i === index ? { ...g, video_path: videoPath } : g);
      return { timeline };
    }
    // 保留原入点；新素材不够长时自动钳位到合法域 [0, sourceDuration - duration]
    const maxIn = Math.max(0, sourceDuration - seg.duration);
    const start_time = Math.min(Math.max(0, seg.start_time), maxIn);
    const timeline = s.timeline.map((g, i) =>
      i === index ? { ...g, video_path: videoPath, source_duration: sourceDuration, start_time } : g);
    return { timeline };
  }),
  setSegmentInPoint: (index, t) => set((s) => {
    const seg = s.timeline[index];
    if (!seg) return {};
    const src = seg.source_duration || seg.duration;
    const maxIn = Math.max(0, src - seg.duration);
    const start_time = Math.min(Math.max(0, t), maxIn);
    const timeline = s.timeline.map((g, i) => (i === index ? { ...g, start_time } : g));
    return { timeline };
  }),
  setScript: (script) => set({ script }),
  setVoice: (voice) => set({ voice }),
  setOutputPath: (outputPath) => set({ outputPath }),
  setOutputDir: (outputDir) => set({ outputDir }),
  setAudioDuration: (audioDuration) => set({ audioDuration }),
  setAudioPath: (audioPath) => set({ audioPath }),
  bumpAudioVersion: () => set((s) => ({ audioVersion: s.audioVersion + 1 })),
  setSpeechSpeed: (speechSpeed) => set({ speechSpeed }),
  setSubtitleFont: (subtitleFont) => set({ subtitleFont }),
  setSubtitleColor: (subtitleColor) => set({ subtitleColor }),
  setSubtitleSize: (subtitleSize) => set({ subtitleSize }),
  setSubtitleStrokeColor: (subtitleStrokeColor) => set({ subtitleStrokeColor }),
  setSubtitleStrokeWidth: (subtitleStrokeWidth) => set({ subtitleStrokeWidth }),
  setSubtitleFontPath: (subtitleFontPath) => set({ subtitleFontPath }),
  setSubtitleOverrides: (subtitleOverrides) => set({ subtitleOverrides }),
  setCoverVideoPath: (coverVideoPath) => set({ coverVideoPath }),
  setCoverTime: (coverTime) => set({ coverTime }),
  setCoverTitle: (coverTitle) => set({ coverTitle }),
  setCoverSubtitle: (coverSubtitle) => set({ coverSubtitle }),
  setCoverTitleX: (coverTitleX) => set({ coverTitleX }),
  setCoverTitleY: (coverTitleY) => set({ coverTitleY }),
  setCoverSubX: (coverSubX) => set({ coverSubX }),
  setCoverSubY: (coverSubY) => set({ coverSubY }),
  setCoverTitleSize: (coverTitleSize) => set({ coverTitleSize }),
  setCoverSubSize: (coverSubSize) => set({ coverSubSize }),
  setCoverTitleColor: (coverTitleColor) => set({ coverTitleColor }),
  setCoverSubColor: (coverSubColor) => set({ coverSubColor }),
  setCoverTitleStrokeColor: (coverTitleStrokeColor) => set({ coverTitleStrokeColor }),
  setCoverTitleStrokeWidth: (coverTitleStrokeWidth) => set({ coverTitleStrokeWidth }),
  setCoverSubStrokeColor: (coverSubStrokeColor) => set({ coverSubStrokeColor }),
  setCoverSubStrokeWidth: (coverSubStrokeWidth) => set({ coverSubStrokeWidth }),
  setCoverTitleItalic: (coverTitleItalic) => set({ coverTitleItalic }),
  setCoverSubItalic: (coverSubItalic) => set({ coverSubItalic }),
  setCoverAspect: (coverAspect) => set({ coverAspect }),
  setVideoAspect: (videoAspect) => set({ videoAspect, coverAspect: videoAspect }),
  setVideoResolution: (videoResolution) => set({ videoResolution }),
  setCoverZoom: (coverZoom) => set({ coverZoom }),
  setCoverOffsetX: (coverOffsetX) => set({ coverOffsetX }),
  setCoverOffsetY: (coverOffsetY) => set({ coverOffsetY }),
  setCoverFont: (coverFont) => set({ coverFont }),
  setCoverFontPath: (coverFontPath) => set({ coverFontPath }),
  resetCover: () => set({
    coverVideoPath: '',
    coverTime: 0,
    coverTitle: '',
    coverSubtitle: '',
    coverTitleX: 50,
    coverTitleY: 35,
    coverSubX: 50,
    coverSubY: 55,
    coverTitleSize: 48,
    coverSubSize: 24,
    coverTitleColor: '#ffffff',
    coverSubColor: '#cccccc',
    coverTitleStrokeColor: '#000000',
    coverTitleStrokeWidth: 2,
    coverSubStrokeColor: '#000000',
    coverSubStrokeWidth: 2,
    coverTitleItalic: false,
    coverSubItalic: false,
    coverZoom: 1.0,
    coverOffsetX: 0,
    coverOffsetY: 0,
    coverFont: 'Microsoft YaHei',
    coverFontPath: 'C:/Windows/Fonts/msyh.ttc',
  }),
  toggleFavSubtitleFont: (name) => set((s) => ({
    favSubtitleFonts: s.favSubtitleFonts.includes(name)
      ? s.favSubtitleFonts.filter((n) => n !== name)
      : [...s.favSubtitleFonts, name],
  })),
  toggleFavCoverFont: (name) => set((s) => ({
    favCoverFonts: s.favCoverFonts.includes(name)
      ? s.favCoverFonts.filter((n) => n !== name)
      : [...s.favCoverFonts, name],
  })),
  pushRecentSubtitleFont: (name) => set((s) => {
    const next = [name, ...s.recentSubtitleFonts.filter((n) => n !== name)].slice(0, 5);
    return { recentSubtitleFonts: next };
  }),
  pushRecentCoverFont: (name) => set((s) => {
    const next = [name, ...s.recentCoverFonts.filter((n) => n !== name)].slice(0, 5);
    return { recentCoverFonts: next };
  }),
  setRunning: (running) => set({ running }),
  setAnalysisKeyError: (analysisKeyError) => set({ analysisKeyError }),
  setTtsKeyError: (ttsKeyError) => set({ ttsKeyError }),
  setBgmName: (bgmName) => set({ bgmName }),
  setBgmVolume: (bgmVolume) => set({ bgmVolume: Math.max(0, Math.min(100, bgmVolume)) }),
  setVoiceVolume: (voiceVolume) => set({ voiceVolume: Math.max(0, Math.min(100, voiceVolume)) }),
  reset: () => set(initialState),
    }),
    {
      name: 'editing-store',
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 API 相关字段（key 重启不丢）；其余运行时状态每次重置为初始
      partialize: (s) => ({
        analysisModel: s.analysisModel,
        analysisApiKey: s.analysisApiKey,
        ttsProvider: s.ttsProvider,
        ttsApiKeys: s.ttsApiKeys,
        // 字体收藏 + 最近使用（各自独立，持久化以跨刷新保留）
        favSubtitleFonts: s.favSubtitleFonts,
        favCoverFonts: s.favCoverFonts,
        recentSubtitleFonts: s.recentSubtitleFonts,
        recentCoverFonts: s.recentCoverFonts,
        // Background music preferences
        bgmName: s.bgmName,
        bgmVolume: s.bgmVolume,
        voiceVolume: s.voiceVolume,
        // Subtitle style preferences — persisted so step-3 tweaks survive a refresh
        // and stay in sync with the exported video (WYSIWYG).
        subtitleFont: s.subtitleFont,
        subtitleFontPath: s.subtitleFontPath,
        subtitleColor: s.subtitleColor,
        subtitleSize: s.subtitleSize,
        subtitleStrokeColor: s.subtitleStrokeColor,
        subtitleStrokeWidth: s.subtitleStrokeWidth,
        // Global video aspect (shared by preview + export)
        videoAspect: s.videoAspect,
        videoResolution: s.videoResolution,
        // Custom export directory preference (persisted; empty = backend default)
        outputDir: s.outputDir,
      }),
      // v1：旧版单一 apiKey 升级时，迁移到「画面分析 + 千问 TTS」两侧，避免用户重填
      version: 1,
      migrate: (persisted: any, version: number) => {
        if (version < 1 && persisted && typeof persisted.apiKey === 'string' && persisted.apiKey) {
          return {
            ...persisted,
            analysisApiKey: persisted.analysisApiKey || persisted.apiKey,
            ttsApiKeys: {
              qwen: persisted.ttsApiKeys?.qwen || persisted.apiKey,
              doubao: persisted.ttsApiKeys?.doubao || '',
            },
          };
        }
        return persisted;
      },
    }
  )
);

/** 分辨率预设 → 输出宽度。1080p=宽1080, 2K=宽1440；高度按画幅推算。 */
export const RESOLUTION_WIDTH: Record<'1080p' | '2K', number> = { '1080p': 1080, '2K': 1440 };
/** 画幅 → 高/宽 比例（用于由宽度推算高度）。 */
export const ASPECT_HW_RATIO: Record<'9:16' | '3:4', number> = { '9:16': 16 / 9, '3:4': 4 / 3 };
/** 由画幅 + 分辨率计算输出像素尺寸（四组合唯一确定，与后端一致）。 */
export function computeOutputDims(
  aspect: '9:16' | '3:4',
  resolution: '1080p' | '2K',
): { width: number; height: number } {
  const w = RESOLUTION_WIDTH[resolution];
  const h = Math.round(w * ASPECT_HW_RATIO[aspect]);
  return { width: w, height: h };
}

/**
 * 步骤3预览用像素尺寸：固定宽 480（高度按画幅推算并取偶，libx264 要求偶数）。
 * 预览只在 320px 框里播放，按导出全尺寸（1080/1440 宽）渲染纯属浪费——
 * 实测渲染耗时可降 4-6 倍。字幕/封面均为百分比定位，与分辨率无关，不影响 WYSIWYG。
 * 注意：assemble 缓存 key 含宽高，预加热与实际请求必须使用同一函数。
 */
export function computePreviewDims(
  aspect: '9:16' | '3:4',
): { width: number; height: number } {
  const w = 480;
  const h = Math.round((w * ASPECT_HW_RATIO[aspect]) / 2) * 2;
  return { width: w, height: h };
}
