/**
 * 从已解码的 AudioBuffer 提取波形包络峰值（P3 T3 音频轨用）。
 *
 * 复用 MusicPreviewPanel 已 decodeAudioData 的 buffer，绝不重新解码。
 * 每桶取 |sample| 最大值（peak），最后按全局峰值归一化到 0..1。
 * 单桶样本数过大（长音频）时按步长等距抽稀：每桶最多扫 MAX_SCAN 个样本，
 * 总读取上限 ≈ buckets × MAX_SCAN（≈1200×8192），远低于"几百 ms"预算。
 */

/** 单桶最多扫描的样本数（超出则等距抽稀，包络近似足够） */
const MAX_SCAN_PER_BUCKET = 8192;

export function computeWaveformPeaks(buf: AudioBuffer, buckets: number): number[] {
  const data = buf.getChannelData(0);
  const n = data.length;
  if (!n || buckets <= 0) return [];
  const per = n / buckets;
  const step = per > MAX_SCAN_PER_BUCKET ? Math.ceil(per / MAX_SCAN_PER_BUCKET) : 1;
  const out = new Array<number>(buckets);
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const s0 = Math.floor(b * per);
    const s1 = Math.min(n, Math.floor((b + 1) * per));
    let a = 0;
    for (let i = s0; i < s1; i += step) {
      const v = data[i];
      const av = v < 0 ? -v : v;
      if (av > a) a = av;
    }
    out[b] = a;
    if (a > max) max = a;
  }
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max;
  return out;
}
