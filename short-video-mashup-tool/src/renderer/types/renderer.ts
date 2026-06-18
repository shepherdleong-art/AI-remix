/**
 * Renderer type definitions for the video rendering module.
 *
 * Defines the core data models for render jobs, configuration,
 * export progress tracking, and format/resolution constants.
 */

// ─── Render Status ────────────────────────────────────────────

/** The lifecycle status of a render job */
export type RenderStatus =
  | 'pending'
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Human-readable labels for render statuses */
export const RENDER_STATUS_LABELS: Record<RenderStatus, string> = {
  pending: '等待中',
  queued: '排队中',
  processing: '渲染中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** Color mapping for status chips (MUI Chip color prop) */
export const RENDER_STATUS_COLORS: Record<RenderStatus, 'default' | 'primary' | 'success' | 'error' | 'warning' | 'info'> = {
  pending: 'default',
  queued: 'info',
  processing: 'primary',
  completed: 'success',
  failed: 'error',
  cancelled: 'warning',
};

// ─── Output Format ────────────────────────────────────────────

/** Supported output file formats */
export type OutputFormat = 'mp4' | 'webm' | 'gif';

/** Human-readable labels for output formats */
export const FORMAT_LABELS: Record<OutputFormat, string> = {
  mp4: 'MP4 (H.264)',
  webm: 'WebM (VP9)',
  gif: 'GIF 动图',
};

/** Supported file extensions by format */
export const FORMAT_EXTENSIONS: Record<OutputFormat, string> = {
  mp4: '.mp4',
  webm: '.webm',
  gif: '.gif',
};

/** All supported output formats as an array */
export const SUPPORTED_FORMATS: OutputFormat[] = ['mp4', 'webm', 'gif'];

// ─── Resolution ───────────────────────────────────────────────

/** Output resolution options */
export type ResolutionOption = '720p' | '1080p' | 'original';

/** Human-readable labels for resolution options */
export const RESOLUTION_LABELS: Record<ResolutionOption, string> = {
  '720p': '720p (1280×720)',
  '1080p': '1080p (1920×1080)',
  original: '原始分辨率',
};

/** Pixel dimensions for each resolution option */
export const RESOLUTION_DIMENSIONS: Record<ResolutionOption, { width: number; height: number } | null> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  original: null,
};

/** All resolution options as an array */
export const RESOLUTION_OPTIONS: ResolutionOption[] = ['720p', '1080p', 'original'];

// ─── FPS ──────────────────────────────────────────────────────

/** Supported frame rate options */
export type FpsOption = 24 | 30 | 60;

/** All FPS options as an array */
export const FPS_OPTIONS: FpsOption[] = [24, 30, 60];

/** Labels for FPS options */
export const FPS_LABELS: Record<FpsOption, string> = {
  24: '24 fps (电影感)',
  30: '30 fps (标准)',
  60: '60 fps (流畅)',
};

// ─── Quality ──────────────────────────────────────────────────

/** Output quality presets */
export type QualityPreset = 'low' | 'medium' | 'high';

/** Human-readable labels for quality presets */
export const QUALITY_LABELS: Record<QualityPreset, string> = {
  low: '低质量 (快速)',
  medium: '中等质量',
  high: '高质量 (慢)',
};

/** CRF values by quality preset (lower = better quality) */
export const QUALITY_CRF: Record<QualityPreset, number> = {
  low: 28,
  medium: 23,
  high: 18,
};

/** Video bitrate by quality preset */
export const QUALITY_BITRATE: Record<QualityPreset, string> = {
  low: '2M',
  medium: '5M',
  high: '12M',
};

// ─── Render Config ────────────────────────────────────────────

/** Complete render configuration */
export interface RenderConfig {
  /** Output file format */
  outputFormat: OutputFormat;
  /** Target resolution */
  resolution: ResolutionOption;
  /** Frame rate */
  fps: FpsOption;
  /** Quality preset */
  quality: QualityPreset;
  /** Whether to include audio track */
  includeAudio: boolean;
  /** Optional watermark text overlay */
  watermark: string;
  /** Optional custom video bitrate string (e.g. "8M") */
  bitrate: string;
}

/** Default render configuration */
export const DEFAULT_RENDER_CONFIG: RenderConfig = {
  outputFormat: 'mp4',
  resolution: '1080p',
  fps: 30,
  quality: 'medium',
  includeAudio: true,
  watermark: '',
  bitrate: '',
};

// ─── Render Job ───────────────────────────────────────────────

/** A single render job in the queue */
export interface RenderJob {
  /** Unique job identifier (UUID v4) */
  id: string;
  /** Associated template ID */
  templateId: string;
  /** Display name (template name) */
  templateName: string;
  /** Current render status */
  status: RenderStatus;
  /** Progress percentage (0-100) */
  progress: number;
  /** Output file path (populated on completion) */
  outputPath: string;
  /** Output file format */
  outputFormat: OutputFormat;
  /** Target resolution */
  resolution: ResolutionOption;
  /** Frame rate */
  fps: FpsOption;
  /** Quality preset */
  quality: QualityPreset;
  /** ISO 8601 timestamp when the job was created */
  startedAt: string;
  /** ISO 8601 timestamp when the job completed (or empty) */
  completedAt: string;
  /** Estimated remaining time in seconds */
  estimatedRemaining: number;
  /** Error message if status is 'failed' */
  error: string;
  /** Current processing step description */
  currentStep: string;
  /** Base64-encoded JPEG thumbnail of the output */
  thumbnail: string;
  /** Render configuration snapshot */
  config: RenderConfig;
}

// ─── Export Progress ──────────────────────────────────────────

/** Real-time export progress update from backend polling */
export interface ExportProgress {
  /** Job ID */
  jobId: string;
  /** Progress percentage (0-100) */
  progress: number;
  /** Human-readable current step description */
  currentStep: string;
  /** Estimated remaining seconds */
  estimatedRemaining: number;
  /** Number of frames processed so far */
  framesProcessed: number;
  /** Total frames to render */
  totalFrames: number;
}

// ─── Render Preset ────────────────────────────────────────────

/** A saved render configuration preset */
export interface RenderPreset {
  /** Unique preset identifier */
  id: string;
  /** Display name */
  name: string;
  /** The saved configuration */
  config: RenderConfig;
  /** ISO 8601 creation timestamp */
  createdAt: string;
}

/** Maximum number of custom presets */
export const MAX_RENDER_PRESETS: number = 3;

// ─── Backend API DTOs ─────────────────────────────────────────

/** Backend render job response (snake_case JSON from API) */
export interface RenderJobResponse {
  id: string;
  template_id: string;
  template_name: string;
  status: string;
  progress: number;
  output_path: string;
  output_format: string;
  resolution: string;
  fps: number;
  quality: string;
  started_at: string;
  completed_at: string;
  estimated_remaining: number;
  error: string;
  current_step: string;
  thumbnail: string;
  config: RenderConfigResponse;
}

/** Backend render config response */
export interface RenderConfigResponse {
  output_format: string;
  resolution: string;
  fps: number;
  quality: string;
  include_audio: boolean;
  watermark: string;
  bitrate: string;
}

/** Backend progress response */
export interface ExportProgressResponse {
  job_id: string;
  progress: number;
  current_step: string;
  estimated_remaining: number;
  frames_processed: number;
  total_frames: number;
}

/** Request body for starting a render job */
export interface RenderStartRequest {
  templateId: string;
  config: RenderConfig;
}

// ─── Conversion Helpers ───────────────────────────────────────

/**
 * Convert a backend RenderJobResponse to a frontend RenderJob.
 */
export function responseToRenderJob(resp: RenderJobResponse): RenderJob {
  return {
    id: resp.id,
    templateId: resp.template_id,
    templateName: resp.template_name,
    status: resp.status as RenderStatus,
    progress: resp.progress,
    outputPath: resp.output_path || '',
    outputFormat: (resp.output_format as OutputFormat) || 'mp4',
    resolution: (resp.resolution as ResolutionOption) || '1080p',
    fps: (resp.fps as FpsOption) || 30,
    quality: (resp.quality as QualityPreset) || 'medium',
    startedAt: resp.started_at || '',
    completedAt: resp.completed_at || '',
    estimatedRemaining: resp.estimated_remaining || 0,
    error: resp.error || '',
    currentStep: resp.current_step || '',
    thumbnail: resp.thumbnail || '',
    config: resp.config
      ? {
          outputFormat: (resp.config.output_format as OutputFormat) || 'mp4',
          resolution: (resp.config.resolution as ResolutionOption) || '1080p',
          fps: (resp.config.fps as FpsOption) || 30,
          quality: (resp.config.quality as QualityPreset) || 'medium',
          includeAudio: resp.config.include_audio ?? true,
          watermark: resp.config.watermark || '',
          bitrate: resp.config.bitrate || '',
        }
      : { ...DEFAULT_RENDER_CONFIG },
  };
}

/**
 * Convert a RenderConfig to snake_case for API request body.
 */
export function renderConfigToSnakeCase(config: RenderConfig): Record<string, unknown> {
  return {
    output_format: config.outputFormat,
    resolution: config.resolution,
    fps: config.fps,
    quality: config.quality,
    include_audio: config.includeAudio,
    watermark: config.watermark,
    bitrate: config.bitrate,
  };
}

/**
 * Build a new UUID v4 identifier.
 */
export function generateRenderId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: string) => {
    const r: number = (Math.random() * 16) | 0;
    const v: number = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Format seconds into a human-readable duration string for ETA display.
 */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '计算中...';
  if (seconds < 60) return `${Math.ceil(seconds)}秒`;
  const m: number = Math.floor(seconds / 60);
  const s: number = Math.ceil(seconds % 60);
  if (m < 60) return `${m}分${s}秒`;
  const h: number = Math.floor(m / 60);
  const rm: number = m % 60;
  return `${h}小时${rm}分`;
}

/**
 * Format file size in bytes to human-readable string.
 */
export function formatOutputSize(bytes: number): string {
  if (bytes === 0) return '未知';
  const units: string[] = ['B', 'KB', 'MB', 'GB'];
  const k: number = 1024;
  const i: number = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
