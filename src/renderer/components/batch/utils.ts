/**
 * 批量模式组件共享工具：媒体 URL 构造、阶段/状态文案、格式化。
 */
import type { BatchStage } from '@/renderer/types/batch';

/** 批次阶段 → 中文名 */
export const STAGE_LABELS: Record<BatchStage, string> = {
  upload: '素材上传',
  prescan: '素材预修',
  scripts: '脚本录入',
  allocation: '智能分配',
  review: '分配审改',
  export: '批量导出',
};

/** 向导五阶段（allocation/review 合并为「分配审改」一格） */
export const WIZARD_STAGES: Array<{ key: string; label: string; sub: string }> = [
  { key: 'upload', label: '素材上传', sub: '导入 · 分析' },
  { key: 'prescan', label: '素材预修', sub: '可用区间' },
  { key: 'scripts', label: '脚本录入', sub: '全局设置' },
  { key: 'review', label: '分配审改', sub: '卡片队列' },
  { key: 'export', label: '批量导出', sub: '串行队列' },
];

/** 后端阶段机 → 向导格下标（allocation 与 review 同属第 3 格） */
export function wizardIndexOfStage(stage: BatchStage): number {
  switch (stage) {
    case 'upload': return 0;
    case 'prescan': return 1;
    case 'scripts': return 2;
    case 'allocation':
    case 'review': return 3;
    case 'export': return 4;
    default: return 0;
  }
}

/** 素材视频流 URL（支持 Range，预修台 scrub 用） */
export function materialVideoUrl(baseUrl: string, batchId: string, fileHash: string): string {
  return `${baseUrl}/api/batch/${encodeURIComponent(batchId)}/materials/${encodeURIComponent(fileHash)}/media`;
}

/** 素材缩略帧 URL（服务端帧缓存，302 复用 /api/ai-editing/thumb） */
export function materialThumbUrl(
  baseUrl: string, batchId: string, fileHash: string, t = 0.5, w = 160,
): string {
  return `${materialVideoUrl(baseUrl, batchId, fileHash)}?kind=thumb&t=${t.toFixed(1)}&w=${Math.round(w)}`;
}

/** 分析状态 → 文案 + MUI Chip 颜色 */
export const ANALYSIS_STATUS_META: Record<string, { label: string; color: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  pending: { label: '待分析', color: 'default' },
  analyzing: { label: '分析中', color: 'info' },
  done: { label: '已完成', color: 'success' },
  cached: { label: '已缓存', color: 'warning' },
  failed: { label: '失败', color: 'error' },
};

/** 预修状态 → 文案 + MUI Chip 颜色 */
export const PRESCAN_STATUS_META: Record<string, { label: string; color: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  pending: { label: '待预修', color: 'default' },
  done: { label: 'AI 已建议', color: 'info' },
  confirmed: { label: '已确认', color: 'success' },
  failed: { label: '检测失败', color: 'error' },
};

/** 秒 → "12.3s" */
export function fmtSec(s: number | undefined | null): string {
  if (s === undefined || s === null || !Number.isFinite(s) || s <= 0) return '0.0s';
  return `${s.toFixed(1)}s`;
}

/** 时间戳 → 本地化短格式 */
export function fmtTime(iso: string | undefined | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

/** 成片状态 → 文案 + MUI Chip 颜色（CLIP_STATUSES 状态机着色） */
export const CLIP_STATUS_META: Record<string, { color: 'default' | 'info' | 'success' | 'warning' | 'error' | 'primary' }> = {
  待生成: { color: 'default' },
  生成中: { color: 'info' },
  待确认: { color: 'warning' },
  待重新分配: { color: 'error' },
  已确认: { color: 'primary' },
  导出中: { color: 'info' },
  已完成: { color: 'success' },
  失败: { color: 'error' },
};

/** 文件名清洗（对齐后端 export_queue.filename_safe：去非法字符、空白转下划线、截 40） */
export function safeFileName(text: string, maxLen = 40): string {
  const clean = (text || '').replace(/[\\/:*?"<>|]/g, '').trim().replace(/\s+/g, '_');
  return (clean || 'untitled').slice(0, maxLen);
}

/** 导出文件名预览（O5：批次名_序号_标题变体.mp4；seq 从 1 起） */
export function exportFileNamePreview(batchName: string, seq: number, title: string): string {
  return `${safeFileName(batchName)}_${String(seq).padStart(2, '0')}_${safeFileName(title)}.mp4`;
}
