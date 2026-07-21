/**
 * 时间轴相关的小工具：后端媒体 URL 构造（与 TimelineEditor.tsx 内 fp/thumb 同规则）。
 */

/** 后端接口要求正斜杠 + URL 编码的路径 */
export function fp(path: string): string {
  return encodeURIComponent((path || '').replace(/\\/g, '/'));
}

/** 取素材某时刻的代表帧（/api/ai-editing/thumb，服务端有缓存） */
export function thumbUrl(baseUrl: string, path: string, t: number): string {
  return `${baseUrl}/api/ai-editing/thumb?path=${fp(path)}&t=${t.toFixed(1)}`;
}

/** 取小尺寸代表帧（P2 胶片条/实时帧预览；w/h 进入服务端缓存键，编码成本低） */
export function thumbUrlSized(baseUrl: string, path: string, t: number, w: number, aspect?: string): string {
  const a = aspect ? `&aspect=${encodeURIComponent(aspect)}` : '';
  return `${baseUrl}/api/ai-editing/thumb?path=${fp(path)}&t=${t.toFixed(2)}${a}&w=${Math.round(w)}`;
}

/** 素材视频流（hover 预览等） */
export function videoUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/api/ai-editing/video?path=${fp(path)}`;
}

/** 取路径的文件名部分 */
export function baseName(path: string): string {
  return (path || '').split(/[\\/]/).pop() || '';
}
