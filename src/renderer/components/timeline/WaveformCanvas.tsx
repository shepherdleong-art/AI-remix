/**
 * WaveformCanvas — P3 T3 音频轨波形（只读联动可视化）。
 *
 * - 数据：MusicPreviewPanel 已解码 buffer 抽出的峰值数组（computeWaveformPeaks），不重解码
 * - 对齐：逐像素列用与 T1 相同的 xToTime 反查时间 → 峰值桶，保证与片段边缘严格对齐
 *   （timeToX 在 minClipWidth 生效时是分段线性的，逐列反查比线性映射更准）
 * - 已播放部分（x < playheadX）primary.main；未播放 text.secondary + 半透明
 * - BGM 尾部淡出：t ∈ [fadeFromSec, fadeToSec] 振幅线性衰减到 0（与 play() 增益包络同形）
 * - devicePixelRatio 缩放保证清晰度；重绘成本 O(宽×常数)，scrub 60fps 更新可承受
 *   （播放中的 scrub 更新本身由 RAF 驱动，重绘天然 RAF 对齐）
 */
import React, { useEffect, useRef } from 'react';
import { useTheme } from '@mui/material';

export interface WaveformCanvasProps {
  /** 峰值数组（0..1，computeWaveformPeaks 产物），代表 audioDur 秒音频 */
  peaks: number[];
  /** 峰值数组对应的音频源时长（秒） */
  audioDur: number;
  /** 波形在时间轴上覆盖的秒数（口播 = min(音频长,总时长)；BGM = 总时长） */
  spanSec: number;
  /** 画布 CSS 尺寸（px）；宽度取整条轨道宽，对齐由 xToTime 保证 */
  width: number;
  height: number;
  /** 播放头 x（px），左侧为已播放 */
  playheadX: number;
  /** 与 T1 共用的时间轴 x → 秒 映射（分段线性，含 minClipWidth 修正） */
  xToTime: (x: number) => number;
  /** 视觉淡出区间（秒）；null/undefined = 无淡出（口播） */
  fadeFromSec?: number | null;
  fadeToSec?: number | null;
  /** 未播放部分不透明度 */
  unplayedAlpha: number;
}

const WaveformCanvas = React.memo<WaveformCanvasProps>(({
  peaks, audioDur, spanSec, width, height, playheadX, xToTime, fadeFromSec, fadeToSec, unplayedAlpha,
}) => {
  const theme = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /* 无依赖数组：组件已被 memo 包裹，仅在 props/theme 变化后重绘。
     播放中 playheadX 每帧变化 → 每帧一次 O(width) 重绘（实测亚毫秒级）。 */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(pw / w, 0, 0, ph / h, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = peaks.length;
    if (!n || audioDur <= 0 || spanSec <= 0) return;
    const mid = h / 2;
    const maxAmp = h / 2 - 1;
    const limit = Math.min(audioDur, spanSec);
    const fadeFrom = fadeFromSec != null ? fadeFromSec : null;
    const fadeTo = fadeToSec != null ? fadeToSec : null;
    const fadeSpan = fadeFrom !== null && fadeTo !== null && fadeTo > fadeFrom ? fadeTo - fadeFrom : 0;
    const px = Math.max(0, Math.min(playheadX, w));

    const drawRange = (x0: number, x1: number) => {
      for (let x = x0; x < x1; x++) {
        const t = xToTime(x);
        if (t >= limit) break; // xToTime 单调不减：之后只会更大
        let amp = peaks[Math.min(n - 1, Math.floor((t / audioDur) * n))] || 0;
        if (fadeSpan > 0 && fadeFrom !== null && fadeTo !== null && t > fadeFrom) {
          amp *= Math.max(0, (fadeTo - t) / fadeSpan);
        }
        const bh = amp * maxAmp;
        if (bh >= 0.5) g.fillRect(x, mid - bh, 1, bh * 2);
      }
    };

    // 先画未播放（右半，半透明 text.secondary），再画已播放（左半，primary.main）
    g.fillStyle = theme.palette.text.secondary;
    g.globalAlpha = unplayedAlpha;
    drawRange(Math.max(0, Math.floor(px)), w);
    g.fillStyle = theme.palette.primary.main;
    g.globalAlpha = 1;
    drawRange(0, Math.ceil(px));
    g.globalAlpha = 1;
  });

  return <canvas ref={canvasRef} style={{ display: 'block' }} />;
});
WaveformCanvas.displayName = 'WaveformCanvas';

export default WaveformCanvas;
