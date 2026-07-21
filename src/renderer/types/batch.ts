/**
 * 批量模式类型定义 —— 镜像 backend/services/batch_service.py 与 routes/batch.py 的数据结构。
 * 与单条流程类型完全独立（editing-store 不受影响）。
 */

/** 批次阶段机（后端 STAGES） */
export type BatchStage = 'upload' | 'prescan' | 'scripts' | 'allocation' | 'review' | 'export';

/** 素材分析状态：pending 待分析 / cached 命中哈希缓存 / analyzing 分析中 / done 已完成 / failed 失败 */
export type AnalysisStatus = 'pending' | 'cached' | 'analyzing' | 'done' | 'failed';

/** 素材预修状态：pending 待检测 / done AI 已给建议 / confirmed 人工已确认 / failed 检测失败 */
export type PrescanStatus = 'pending' | 'done' | 'confirmed' | 'failed';

/** 成片卡片状态（后端 CLIP_STATUSES） */
export type ClipStatus =
  | '待生成' | '生成中' | '待确认' | '待重新分配'
  | '已确认' | '导出中' | '已完成' | '失败';

/** 批次素材条目（materials/add 返回 + 批次详情内嵌） */
export interface BatchMaterial {
  file_hash: string;
  filename: string;
  /** 批次相对路径（$TEMP/ 前缀 或 相对 path_base；前端无需解析，媒体走 media 端点） */
  rel_path: string;
  /** 文件大小（字节） */
  size: number;
  /** 时长（秒，分析/预修后回填；0 = 未知） */
  duration: number;
  /** 可用窗口入点（秒） */
  usable_in: number;
  /** 可用窗口出点（秒，0 = 未设置取 duration） */
  usable_out: number;
  analysis_status: AnalysisStatus | string;
  prescan_status: PrescanStatus | string;
  missing?: boolean;
  analysis_error?: string;
}

/** 脚本 TTS 产物（批次 /tts 端点回填到 scripts[i].tts） */
export interface BatchScriptTts {
  status: 'done' | 'failed' | string;
  audio_path?: string;
  total_duration?: number;
  seg_durations?: number[];
  segments?: Array<{ index?: number; text?: string }>;
  error?: string;
}

/** 批次脚本（copies = 裂变数 D1） */
export interface BatchScript {
  id: string;
  text: string;
  copies: number;
  status: string;
  tts?: BatchScriptTts;
  segments?: Array<Record<string, unknown>>;
}

/** 全局字幕样式（settings.subtitle_style，透传后端 composite） */
export interface SubtitleStyle {
  font?: string;
  font_path?: string;
  color?: string;
  size?: number;
  stroke_color?: string;
  stroke_width?: number;
  /** 字幕纵向位置（百分比） */
  y?: number;
}

/** 批次全局设置（D7 统一设一次） */
export interface BatchGlobalSettings {
  voice: string;
  speed: number;
  tts_provider: string;
  subtitle_style: SubtitleStyle;
  /** 'all' = 全库轮替；string[] = 圈选曲目名（D13） */
  bgm_pool: 'all' | string[];
  target_duration: number;
  segments_per_clip?: number;
}

/** 成片片段（分配器输出） */
export interface ClipSegment {
  video_rel_path: string;
  file_hash: string;
  scene_index: number;
  in: number;
  out: number;
  duration: number;
  score?: number;
}

/** 成片封面（D8 自动差异化 / 人工修改） */
export interface ClipCover {
  video_rel_path?: string;
  file_hash?: string;
  time?: number;
  title?: string;
  subtitle?: string;
  template?: string;
  title_color?: string;
  sub_color?: string;
  title_y?: number;
  sub_y?: number;
  user_modified?: boolean;
}

/** 相似度预警标记 */
export interface SimilarityFlag {
  other_clip: string;
  similarity: number;
}

/** 成片卡片 */
export interface BatchClip {
  id: string;
  script_id: string;
  status: ClipStatus | string;
  segments: ClipSegment[];
  trim_overrides?: unknown;
  subtitle_overrides?: unknown;
  cover: ClipCover | null;
  bgm_name: string | null;
  output_path: string | null;
  similarity_flags?: SimilarityFlag[];
  feasible?: boolean;
  backoff_segments?: unknown[];
  total_duration?: number | null;
}

/** 分配报告（字段以 allocation-report 端点实际返回为准，此处覆盖前端用到的） */
export interface AllocationReport {
  materials_used: number;
  materials_total: number;
  usage_variance: number;
  usage_distribution?: Record<string, number>;
  repeats?: unknown[];
  jaccard_pairs_over_threshold?: Array<{ clip_a: string; clip_b: string; similarity: number }>;
  forced_overlap_count?: number;
  violations?: unknown[];
  bgm_assignments?: Array<{ clip_id: string; bgm_name: string; reused: boolean }>;
  jaccard_threshold?: number;
  [key: string]: unknown;
}

/** 批次完整对象（GET /api/batch/{id}） */
export interface Batch {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  stage: BatchStage;
  materials: BatchMaterial[];
  scripts: BatchScript[];
  global_settings: BatchGlobalSettings;
  clips: BatchClip[];
  allocation_report: AllocationReport | null;
  export_queue: unknown;
  path_base: string;
}

/** 历史列表摘要（GET /api/batch/list） */
export interface BatchSummary {
  id: string;
  name: string;
  stage: BatchStage;
  materials_count: number;
  clips_total: number;
  clips_done: number;
  updated_at: string;
}

/** 分析任务控制状态（暂停/停止软控制用） */
export type AnalyzeState = 'idle' | 'running' | 'paused' | 'stopping';

/** 后台任务进度快照（analyze / prescan / tts status 端点） */
export interface TaskProgress {
  running: boolean;
  done: number;
  total: number;
  current: string;
  last_status: string;
  finished_at: string | null;
  error: string | null;
  /** 分析控制状态（idle/running/paused/stopping），其余任务恒为 'idle' */
  state?: AnalyzeState;
}

/** O2 可行性预估（GET estimate） */
export interface EstimateResult {
  suggested_max_clips: number;
  materials_ready: number;
  total_usable_seconds: number;
  assumptions: {
    avg_scene_len: number;
    segments_per_clip: number;
    note?: string;
  };
  post_allocation: null | {
    clips: number;
    materials_used?: number;
    usage_variance?: number;
    repeats_count?: number;
    jaccard_over_threshold_pairs?: number;
    forced_overlap_count?: number;
  };
}

/** 导出队列任务（export_queue._make_job） */
export interface ExportJob {
  batch_id: string;
  clip_id: string;
  seq: number;
  title: string;
  status: 'pending' | 'rendering' | 'done' | 'failed' | 'cancelled' | 'cancelling' | string;
  progress: number;
  error: string | null;
  output_path: string | null;
}

/** 导出队列快照（GET export/status，已按批次过滤） */
export interface ExportQueueStatus {
  jobs: ExportJob[];
  paused: boolean;
  running?: boolean;
  done_count: number;
  failed_count: number;
  total: number;
  all_done: boolean;
}

/** materials/add 返回 */
export interface AddMaterialsResult {
  added: BatchMaterial[];
  skipped: Array<{ path: string; reason: string }>;
}
