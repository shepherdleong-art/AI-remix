/**
 * Material type definitions for the short video mashup tool.
 *
 * Defines the core data models for video and image materials,
 * including their metadata, status tracking, and display properties.
 */

/** Processing / import status for a material */
export type MaterialStatus =
  | 'pending'     /** Awaiting import/validation */
  | 'importing'   /** Currently being imported */
  | 'ready'       /** Successfully imported and ready for use */
  | 'error'       /** Import/validation failed */
  | 'processing'; /** Being processed (thumb gen, probe) */

/** Material type discriminator */
export type MaterialType = 'video' | 'image';

/**
 * Base material interface containing fields shared by all material types.
 */
export interface Material {
  /** Unique identifier (UUID v4) */
  id: string;

  /** Display file name (without path) */
  fileName: string;

  /** Full absolute file path on disk */
  filePath: string;

  /** Material type discriminator */
  type: MaterialType;

  /** Formatted duration string (e.g. "02:35") or "N/A" for images */
  duration: string;

  /** Resolution string (e.g. "1920×1080" or "800×600") */
  resolution: string;

  /** Formatted file size (e.g. "15.2 MB") or raw bytes number for sorting */
  size: string;

  /** Thumbnail data URL or path; empty string if not yet generated */
  thumbnail: string;

  /** Current processing/import status */
  status: MaterialStatus;

  /** ISO 8601 timestamp when the material was added */
  addedAt: string;
}

/**
 * Video-specific material with detailed media metadata.
 */
export interface VideoMaterial extends Material {
  type: 'video';

  /** Duration in seconds (float) */
  durationSeconds: number;

  /** Frame rate (e.g. 29.97, 60) */
  fps: number;

  /** Video codec name (e.g. "h264", "hevc") */
  codec: string;

  /** Video bitrate in bps */
  bitrate: number;

  /** Pixel width */
  width: number;

  /** Pixel height */
  height: number;
}

/**
 * Image-specific material with dimensions and format info.
 */
export interface ImageMaterial extends Material {
  type: 'image';

  /** Pixel width */
  width: number;

  /** Pixel height */
  height: number;

  /** Image format (e.g. "jpeg", "png", "gif", "webp") */
  format: string;
}

/** Union type for any material */
export type AnyMaterial = VideoMaterial | ImageMaterial;

/**
 * Supported video file extensions.
 */
export const VIDEO_EXTENSIONS: readonly string[] = [
  '.mp4', '.mov', '.avi', '.webm', '.mkv', '.m4v', '.flv', '.wmv',
] as const;

/**
 * Supported image file extensions.
 */
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff',
] as const;

/**
 * All supported file extensions combined.
 */
export const ALL_SUPPORTED_EXTENSIONS: readonly string[] = [
  ...VIDEO_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
] as const;

/**
 * Maximum file size in bytes (2 GB).
 */
export const MAX_FILE_SIZE_BYTES: number = 2 * 1024 * 1024 * 1024;

/**
 * Check if a file extension is a supported video format.
 */
export function isVideoExtension(ext: string): boolean {
  return (VIDEO_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Check if a file extension is a supported image format.
 */
export function isImageExtension(ext: string): boolean {
  return (IMAGE_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * Get the material type from a file extension.
 */
export function getMaterialTypeFromExtension(ext: string): MaterialType | null {
  const lower = ext.toLowerCase();
  if (isVideoExtension(lower)) return 'video';
  if (isImageExtension(lower)) return 'image';
  return null;
}

/**
 * Format file size in bytes to a human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units: string[] = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k: number = 1024;
  const i: number = Math.floor(Math.log(bytes) / Math.log(k));
  const size: string = (bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1);
  return `${size} ${units[i]}`;
}

/**
 * Format seconds into a human-readable duration string (e.g. "02:35" or "1:02:35").
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'N/A';
  const h: number = Math.floor(seconds / 3600);
  const m: number = Math.floor((seconds % 3600) / 60);
  const s: number = Math.floor(seconds % 60);
  const pad: (n: number) => string = (n: number) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}
