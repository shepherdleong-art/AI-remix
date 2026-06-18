/**
 * Analysis type definitions for the smart analysis module.
 *
 * Defines analysis result data structures including scene detection,
 * quality assessment, tag generation, and highlight identification.
 */

// ─── Analysis Status ────────────────────────────────────────

/** Status of an analysis task */
export type AnalysisStatus =
  | 'pending'     /** Not yet started */
  | 'processing'  /** Actively being analyzed */
  | 'done'        /** Analysis completed successfully */
  | 'error';      /** Analysis failed */

// ─── Sub-step Status ────────────────────────────────────────

/** Status of an individual analysis sub-step */
export type SubStepStatus = 'pending' | 'processing' | 'done' | 'error';

/** Progress of each analysis sub-step */
export interface SubStepProgress {
  /** Sub-step identifier */
  step: SubStepName;
  /** Current status */
  status: SubStepStatus;
  /** Human-readable label in Chinese */
  label: string;
}

/** Names of the four analysis sub-steps */
export type SubStepName = 'scene_detection' | 'quality_analysis' | 'tag_generation' | 'highlight_detection';

/** Default sub-step labels */
export const SUB_STEP_LABELS: Record<SubStepName, string> = {
  scene_detection: '场景检测',
  quality_analysis: '质量分析',
  tag_generation: '标签生成',
  highlight_detection: '亮点识别',
};

// ─── Scene ───────────────────────────────────────────────────

/** A detected scene boundary with metadata */
export interface Scene {
  /** Unique scene identifier */
  id: string;
  /** Start time in seconds */
  startTime: number;
  /** End time in seconds */
  endTime: number;
  /** Base64-encoded JPEG thumbnail or empty string */
  thumbnail: string;
  /** Human-readable scene description */
  description: string;
  /** Detection confidence (0-1) */
  confidence: number;
}

// ─── Highlight ───────────────────────────────────────────────

/** A detected highlight moment within the material */
export interface Highlight {
  /** Unique highlight identifier */
  id: string;
  /** Time range in seconds [start, end] */
  timeRange: [number, number];
  /** Highlight score (0-100) */
  score: number;
  /** Reason for highlighting (e.g., "高动态场景", "色彩丰富") */
  reason: string;
  /** Base64-encoded JPEG thumbnail or empty string */
  thumbnail: string;
}

// ─── Quality Report ─────────────────────────────────────────

/** Per-dimension and overall quality assessment */
export interface QualityReport {
  /** Average brightness (0-255) */
  brightness: number;
  /** Contrast measured as pixel standard deviation */
  contrast: number;
  /** Sharpness measured as Laplacian variance */
  sharpness: number;
  /** Stability score (0-100), lower means shakier footage */
  stability: number;
  /** Audio quality score (0-100), 0 for silent media */
  audioQuality: number;
  /** Overall quality score (0-100) */
  overallScore: number;
}

// ─── Tag Category ───────────────────────────────────────────

/** Tag category groups */
export type TagCategory = 'content' | 'style' | 'technical' | 'scene';

/** Tag category labels */
export const TAG_CATEGORY_LABELS: Record<TagCategory, string> = {
  content: '内容',
  style: '风格',
  technical: '技术',
  scene: '场景',
};

/** A single tag with category grouping */
export interface Tag {
  /** Unique tag identifier */
  id: string;
  /** Display label */
  label: string;
  /** Category this tag belongs to */
  category: TagCategory;
}

// ─── Analysis Result ────────────────────────────────────────

/** Complete analysis result for a single material */
export interface AnalysisResult {
  /** Analysis task identifier (UUID v4) */
  id: string;
  /** Associated material identifier */
  materialId: string;
  /** Overall analysis status */
  status: AnalysisStatus;
  /** Number of detected scenes */
  sceneCount: number;
  /** Total material duration in seconds */
  totalDuration: number;
  /** Overall quality score (0-100) */
  qualityScore: number;
  /** Generated tags */
  tags: Tag[];
  /** Detected scenes */
  scenes: Scene[];
  /** Detected highlights */
  highlights: Highlight[];
  /** Quality detail report */
  qualityReport: QualityReport | null;
  /** Per-sub-step progress */
  subSteps: SubStepProgress[];
  /** Overall progress percentage (0-100) */
  progress: number;
  /** Error message if status is 'error' */
  errorMessage: string;
  /** ISO 8601 timestamp of analysis completion */
  analyzedAt: string;
}

// ─── Backend API DTOs ───────────────────────────────────────

/** Request body for POST /api/analysis/start */
export interface StartAnalysisRequest {
  materialId: string;
  filePath: string;
}

/** Request body for POST /api/analysis/batch */
export interface BatchAnalysisRequest {
  materialIds: string[];
  filePaths: Record<string, string>;
}

/** Response from analysis status endpoint */
export interface AnalysisStatusResponse {
  analysisId: string;
  status: AnalysisStatus;
  progress: number;
  subSteps: SubStepProgress[];
  errorMessage: string;
}

/** Response from analysis result endpoint */
export interface AnalysisResultResponse {
  analysisId: string;
  materialId: string;
  status: AnalysisStatus;
  sceneCount: number;
  totalDuration: number;
  qualityScore: number;
  tags: Tag[];
  scenes: Scene[];
  highlights: Highlight[];
  qualityReport: QualityReport | null;
  analyzedAt: string;
}
