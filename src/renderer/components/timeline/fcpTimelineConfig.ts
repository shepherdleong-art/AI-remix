/**
 * FcpTimeline — 集中可调常量（P1 验收时按手感微调）。
 *
 * 颜色一律走 MUI theme token（'primary.main' / 'warning.main' / 'error.main'），
 * 禁止硬编码 #1976d2 之类的强调色（见 AI_HANDOFF §4.4 / §9）。
 */
export const FCP_TIMELINE_CONFIG = {
  /** 时间轴缩放：每秒对应的像素宽（trackWidth = max(容器宽, 总时长 × pxPerSec)） */
  pxPerSec: 60,
  /** 片段最小像素宽（过短片段兜底，保证可点中） */
  minClipWidth: 48,
  /** 磁吸阈值（px）：ghost 边缘距吸附目标 ≤ 该值时吸附 */
  snapThresholdPx: 6,
  /** 相邻片段实时让位的过渡时长（ms），仅 transform，不触发 layout */
  reflowMs: 120,
  /** 吸附瞬间片段微弹跳时长（ms） */
  bounceMs: 80,
  /** 区分「点击选中」与「拖拽重排」的位移阈值（px） */
  dragStartThresholdPx: 4,
  /** 拖拽中 ghost 的不透明度 */
  dragGhostOpacity: 0.65,
  /** 轨道高度（px） */
  trackHeight: 64,
  /** 时间标尺高度（px） */
  rulerHeight: 20,
  /** 播放头竖线宽（px） */
  playheadWidth: 2,
  /** 播放头顶部抓手宽（px，放大点击热区） */
  playheadGripWidth: 12,
  /** 预览重 assemble 的编辑防抖（ms）：连续修改合并后再请求后端，避免排队风暴 */
  previewAssembleDebounceMs: 300,

  /* ── P2 重选时段（TrimEditor） ── */
  /** 胶片条缩放：每秒素材对应的像素宽（stripWidth = source_duration × trimPxPerSec） */
  trimPxPerSec: 90,
  /** 胶片条取帧间隔（秒）；帧数超过 trimMaxFrames 时自动拉大间隔 */
  trimFrameIntervalSec: 0.5,
  /** 胶片条最大帧数（超出则拉大取帧间隔） */
  trimMaxFrames: 40,
  /** 胶片条每批增量加载帧数（占位 → 逐批填充） */
  trimFrameBatchSize: 6,
  /** 入点磁吸阈值（px）：选择框左缘距整秒位置 ≤ 该值时吸附到整秒 */
  trimSnapThresholdPx: 4,
  /** 胶片条高度（px） */
  trimStripHeight: 72,
  /** 拖拽联动大预览：选择框左缘时刻变化 ≥ 该值（秒）才通知父级 seek trim 预览视频
      （拖拽本身已 RAF 节流，此为二次节流，避免无意义的高频 currentTime 赋值） */
  trimSeekMinDeltaSec: 0.03,
  /** 胶片条请求的缩略图宽度（/thumb w 参数），远小于全尺寸 1080 */
  trimThumbWidth: 160,

  /* ── P3 T2/T3 联动可视化轨 ── */
  /** sticky 左侧轨道标签列宽（px，不随横向滚动） */
  trackLabelWidth: 48,
  /** T2 字幕轨高度（px） */
  subtitleTrackHeight: 28,
  /** T3 音频轨每个子行高度（px；口播/BGM 两行） */
  audioSubRowHeight: 30,
  /** T2/T3 折叠后残留的轨道条高度（px，仅保留分隔线与展开按钮位） */
  collapsedTrackHeight: 20,
  /** 轨道折叠状态 localStorage 键（JSON {subtitle: bool, audio: bool}） */
  trackCollapseStorageKey: 'fcp-track-collapse',
  /** 波形包络桶数（峰值点数；单桶样本过多时自动抽稀，见 waveformPeaks.ts） */
  waveformBuckets: 1200,
  /** BGM 尾部视觉淡出时长（s）：最后 fadeOutSec 内波形振幅线性衰减到 0
      （与 play() 的 Web Audio 增益包络同形：totalDur-2 起线性淡出） */
  bgmFadeOutSec: 2,
  /** T1 有选中片段时，其它字幕块的压暗不透明度 */
  subtitleDimOpacity: 0.55,
  /** 波形未播放部分的不透明度（已播放部分恒为 1，走 primary.main） */
  waveformUnplayedAlpha: 0.45,
} as const;

export type FcpTimelineConfig = typeof FCP_TIMELINE_CONFIG;
