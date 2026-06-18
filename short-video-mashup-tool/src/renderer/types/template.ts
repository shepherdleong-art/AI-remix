/**
 * Template type definitions for the template engine module.
 *
 * Defines the core data models for clip templates, including
 * segments, transitions, filters, text overlays, and template categories.
 */

// ─── Transition ─────────────────────────────────────────────

/** Available transition effect types */
export type TransitionType =
  | 'none'
  | 'fade'
  | 'slide'
  | 'zoom'
  | 'wipe'
  | 'dissolve';

/** A transition effect applied between two segments */
export interface Transition {
  /** Transition effect type */
  type: TransitionType;
  /** Transition duration in seconds */
  duration: number;
}

/** Labels for transition types */
export const TRANSITION_LABELS: Record<TransitionType, string> = {
  none: '无',
  fade: '淡入淡出',
  slide: '滑动',
  zoom: '缩放',
  wipe: '擦除',
  dissolve: '溶解',
};

/** Default transition — no effect */
export const DEFAULT_TRANSITION: Transition = {
  type: 'none',
  duration: 0.3,
};

// ─── Text Overlay ───────────────────────────────────────────

/** Text position presets on the video frame */
export type TextPosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

/** Position coordinates in percentages (0-100) */
export interface Position {
  x: number;
  y: number;
}

/** Map text position presets to percentage coordinates */
export const TEXT_POSITION_PRESETS: Record<string, Position> = {
  'top-left': { x: 5, y: 5 },
  'top-center': { x: 50, y: 5 },
  'top-right': { x: 95, y: 5 },
  'center': { x: 50, y: 50 },
  'bottom-left': { x: 5, y: 90 },
  'bottom-center': { x: 50, y: 90 },
  'bottom-right': { x: 95, y: 90 },
};

/** A text overlay on a segment */
export interface TextOverlay {
  /** Display text content */
  text: string;
  /** Font family name */
  font: string;
  /** Font size in px */
  fontSize: number;
  /** Text color as hex string (e.g. "#FFFFFF") */
  color: string;
  /** Position preset key */
  position: string;
  /** Start time offset within the segment (seconds) */
  startTime: number;
  /** Display duration (seconds) */
  duration: number;
}

/** Default text overlay */
export const DEFAULT_TEXT_OVERLAY: TextOverlay = {
  text: '',
  font: '"Microsoft YaHei", "PingFang SC", sans-serif',
  fontSize: 32,
  color: '#FFFFFF',
  position: 'bottom-center',
  startTime: 0,
  duration: 3,
};

// ─── Filter ─────────────────────────────────────────────────

/** Available filter types */
export type FilterType =
  | 'brightness'
  | 'contrast'
  | 'saturation'
  | 'blur'
  | 'sharpen';

/** Labels for filter types */
export const FILTER_LABELS: Record<FilterType, string> = {
  brightness: '亮度',
  contrast: '对比度',
  saturation: '饱和度',
  blur: '模糊',
  sharpen: '锐化',
};

/** Default filter values (neutral) */
export const FILTER_DEFAULTS: Record<FilterType, number> = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  blur: 0,
  sharpen: 0,
};

/** Filter value ranges [min, max] */
export const FILTER_RANGES: Record<FilterType, [number, number]> = {
  brightness: [0, 200],
  contrast: [0, 200],
  saturation: [0, 200],
  blur: [0, 20],
  sharpen: [0, 10],
};

/** A visual filter applied to a segment */
export interface Filter {
  /** Filter type */
  type: FilterType;
  /** Filter value within its valid range */
  value: number;
}

// ─── Segment ────────────────────────────────────────────────

/** A single segment (clip) within a template timeline */
export interface Segment {
  /** Unique segment identifier */
  id: string;
  /** Associated material ID (from materials store) */
  materialId: string;
  /** Start time within the source material (seconds) */
  startTime: number;
  /** End time within the source material (seconds) */
  endTime: number;
  /** Computed duration (endTime - startTime) in seconds */
  duration: number;
  /** Display order on the timeline (0-indexed) */
  order: number;
  /** Incoming transition from previous segment */
  transitionIn: Transition;
  /** Outgoing transition to next segment */
  transitionOut: Transition;
  /** Applied visual filters */
  filters: Filter[];
  /** Optional text overlay */
  textOverlay: TextOverlay | null;
  /** Volume level (0.0 - 1.0) */
  volume: number;
  /** Playback speed multiplier (0.5 - 2.0) */
  speed: number;
}

/** Maximum number of segments allowed in a template */
export const MAX_SEGMENTS: number = 100;

/** Minimum segment duration in seconds */
export const MIN_SEGMENT_DURATION: number = 0.1;

/** Maximum segment duration in seconds */
export const MAX_SEGMENT_DURATION: number = 300;

// ─── Template Category ──────────────────────────────────────

/** Template category definition */
export interface TemplateCategory {
  /** Unique category identifier */
  id: string;
  /** Display name */
  name: string;
  /** Material icon name (for MUI Icon) */
  icon: string;
  /** Brief description */
  description: string;
  /** Number of templates in this category */
  templateCount: number;
}

/** Predefined template categories */
export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  {
    id: 'all',
    name: '全部',
    icon: 'Apps',
    description: '所有模板',
    templateCount: 0,
  },
  {
    id: 'fast-paced',
    name: '快节奏',
    icon: 'FlashOn',
    description: '适合运动、街拍、快节奏内容',
    templateCount: 0,
  },
  {
    id: 'vlog',
    name: 'Vlog',
    icon: 'Videocam',
    description: '日常Vlog、生活记录',
    templateCount: 0,
  },
  {
    id: 'product',
    name: '产品展示',
    icon: 'Storefront',
    description: '产品评测、开箱、展示',
    templateCount: 0,
  },
  {
    id: 'tutorial',
    name: '教程',
    icon: 'School',
    description: '教学视频、操作演示',
    templateCount: 0,
  },
  {
    id: 'festival',
    name: '节日',
    icon: 'Celebration',
    description: '节日主题、庆祝活动',
    templateCount: 0,
  },
  {
    id: 'slideshow',
    name: '幻灯片',
    icon: 'Slideshow',
    description: '图片幻灯片、相册',
    templateCount: 0,
  },
  {
    id: 'custom',
    name: '自定义',
    icon: 'Build',
    description: '用户自定义模板',
    templateCount: 0,
  },
];

// ─── Template ───────────────────────────────────────────────

/** A complete clip template definition */
export interface Template {
  /** Unique template identifier (UUID v4) */
  id: string;
  /** Display name */
  name: string;
  /** Brief description */
  description: string;
  /** Category ID */
  category: string;
  /** Thumbnail URL or data URL; empty string if not set */
  thumbnail: string;
  /** Ordered list of segments */
  segments: Segment[];
  /** Total template duration (sum of segment durations, excluding transitions) */
  totalDuration: number;
  /** Default transition used between new segments */
  transition: Transition;
  /** Search tags */
  tags: string[];
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** ISO 8601 last modified timestamp */
  updatedAt: string;
  /** Whether this is a built-in preset template */
  isBuiltin: boolean;
}

// ─── Backend API DTOs ───────────────────────────────────────

/** Backend template response (snake_case JSON) */
export interface TemplateResponse {
  id: string;
  name: string;
  description: string;
  category: string;
  thumbnail: string;
  segments: SegmentResponse[];
  total_duration: number;
  transition: TransitionResponse;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_builtin: boolean;
}

/** Backend segment response */
export interface SegmentResponse {
  id: string;
  material_id: string;
  start_time: number;
  end_time: number;
  duration: number;
  order: number;
  transition_in: TransitionResponse;
  transition_out: TransitionResponse;
  filters: FilterResponse[];
  text_overlay: TextOverlayResponse | null;
  volume: number;
  speed: number;
}

/** Backend transition response */
export interface TransitionResponse {
  type: string;
  duration: number;
}

/** Backend filter response */
export interface FilterResponse {
  type: string;
  value: number;
}

/** Backend text overlay response */
export interface TextOverlayResponse {
  text: string;
  font: string;
  font_size: number;
  color: string;
  position: string;
  start_time: number;
  duration: number;
}

/** Request body for creating/updating a template */
export interface TemplateRequest {
  name: string;
  description: string;
  category: string;
  thumbnail: string;
  segments: Segment[];
  transition: Transition;
  tags: string[];
  is_builtin: boolean;
}

// ─── Conversion Helpers ─────────────────────────────────────

/**
 * Convert a frontend camelCase Template to backend snake_case format.
 */
export function templateToRequest(template: Template): Record<string, unknown> {
  return {
    name: template.name,
    description: template.description,
    category: template.category,
    thumbnail: template.thumbnail,
    segments: template.segments.map(segmentToSnakeCase),
    transition: transitionToSnakeCase(template.transition),
    tags: template.tags,
    is_builtin: template.isBuiltin,
  };
}

/**
 * Convert a backend snake_case response to frontend camelCase Template.
 */
export function responseToTemplate(response: TemplateResponse): Template {
  return {
    id: response.id,
    name: response.name,
    description: response.description,
    category: response.category,
    thumbnail: response.thumbnail,
    segments: (response.segments || []).map(responseToSegment),
    totalDuration: response.total_duration,
    transition: responseToTransition(response.transition),
    tags: response.tags || [],
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    isBuiltin: response.is_builtin,
  };
}

function segmentToSnakeCase(seg: Segment): Record<string, unknown> {
  return {
    id: seg.id,
    material_id: seg.materialId,
    start_time: seg.startTime,
    end_time: seg.endTime,
    duration: seg.duration,
    order: seg.order,
    transition_in: transitionToSnakeCase(seg.transitionIn),
    transition_out: transitionToSnakeCase(seg.transitionOut),
    filters: seg.filters.map((f: Filter) => ({ type: f.type, value: f.value })),
    text_overlay: seg.textOverlay
      ? {
          text: seg.textOverlay.text,
          font: seg.textOverlay.font,
          font_size: seg.textOverlay.fontSize,
          color: seg.textOverlay.color,
          position: seg.textOverlay.position,
          start_time: seg.textOverlay.startTime,
          duration: seg.textOverlay.duration,
        }
      : null,
    volume: seg.volume,
    speed: seg.speed,
  };
}

function responseToSegment(seg: SegmentResponse): Segment {
  return {
    id: seg.id,
    materialId: seg.material_id,
    startTime: seg.start_time,
    endTime: seg.end_time,
    duration: seg.duration,
    order: seg.order,
    transitionIn: responseToTransition(seg.transition_in),
    transitionOut: responseToTransition(seg.transition_out),
    filters: (seg.filters || []).map((f: FilterResponse) => ({
      type: f.type as FilterType,
      value: f.value,
    })),
    textOverlay: seg.text_overlay
      ? {
          text: seg.text_overlay.text,
          font: seg.text_overlay.font,
          fontSize: seg.text_overlay.font_size,
          color: seg.text_overlay.color,
          position: seg.text_overlay.position,
          startTime: seg.text_overlay.start_time,
          duration: seg.text_overlay.duration,
        }
      : null,
    volume: seg.volume,
    speed: seg.speed,
  };
}

function transitionToSnakeCase(t: Transition): Record<string, unknown> {
  return { type: t.type, duration: t.duration };
}

function responseToTransition(t: TransitionResponse): Transition {
  return {
    type: (t.type as TransitionType) || 'none',
    duration: t.duration || 0.3,
  };
}

/**
 * Build a new UUID v4 identifier.
 */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: string) => {
    const r: number = (Math.random() * 16) | 0;
    const v: number = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Create a default empty segment.
 */
export function createDefaultSegment(materialId: string = '', order: number = 0): Segment {
  return {
    id: generateId(),
    materialId,
    startTime: 0,
    endTime: 3,
    duration: 3,
    order,
    transitionIn: { ...DEFAULT_TRANSITION },
    transitionOut: { ...DEFAULT_TRANSITION },
    filters: [],
    textOverlay: null,
    volume: 1,
    speed: 1,
  };
}

/**
 * Create a default empty template.
 */
export function createDefaultTemplate(): Template {
  const now: string = new Date().toISOString();
  return {
    id: generateId(),
    name: '未命名模板',
    description: '',
    category: 'custom',
    thumbnail: '',
    segments: [],
    totalDuration: 0,
    transition: { ...DEFAULT_TRANSITION },
    tags: [],
    createdAt: now,
    updatedAt: now,
    isBuiltin: false,
  };
}
