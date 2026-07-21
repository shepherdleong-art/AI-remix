/**
 * FcpTimeline — P1 视频轨 + P3 T2/T3 联动可视化轨（剪映手感）。
 *
 * P1（T1 视频轨，原有能力不回归）：
 *  - 片段横向渲染（代表帧 + 序号 + 时长），宽度 ∝ duration
 *  - 播放头竖线可拖 scrub（RAF 节流 ≤60fps），点击标尺/轨道空白跳转
 *  - 手写 pointer 拖拽重排：半透明 ghost + 相邻实时让位 + 磁吸 + ESC 取消
 *    （拖拽过程不写 store，松手时一次性 reorderTimeline）
 *  - 单击选中片段（primary 描边），选中自动定位播放头到片段起点
 *  - 双击片段 → 请求进入 P2 重选时段（TrimEditor，由 MusicPreviewPanel 渲染）
 *  - 素材时长不足（source_duration < duration）红色警告角标
 *
 * P3（T2/T3 只读联动可视化轨）：
 *  - sticky 左标签列（视频/字幕/音频，不随横向滚动），T2/T3 可独立折叠，
 *    折叠状态持久化 localStorage（fcp-track-collapse）
 *  - T2 字幕轨：subs 文本块按 [start,end] 经同一 timeToX 横排，只读；
 *    单击 = 选中对应片段 + 播放头跳转块起点（与 T1 单击同语义）；
 *    双击 = 走 TimelineEditor 现有 openEdit Popover 精修；
 *    selectedSegmentIndex === sub.i 联动高亮（primary 描边+淡染），其余字幕块压暗
 *  - T3 音频轨：口播/BGM 两行 Canvas 波形（复用已解码 buffer 峰值，不重解码）；
 *    已播放部分 primary 高亮、未播放半透明；BGM 尾部 2s 淡出区振幅衰减显示；
 *    每行右侧 sticky 音量滑杆 + 静音（写回现有 voiceVolume/bgmVolume，
 *    静音 = 置 0 并记住原值，再点恢复）
 *  - 播放头竖线跨标尺+全部展开轨道；三轨共用同一 timeToX/xToTime 严格对齐
 *  - Trim 模式：T2/T3 与 T1 同步压暗 0.45，且点击全部禁用
 *
 * 颜色全部走 theme token / useTheme 解析值，禁止硬编码强调色。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, IconButton, Slider, Tooltip, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VolumeOffIcon from '@mui/icons-material/VolumeOff';
import { useEditingStore } from '@/renderer/store/editing-store';
import type { TimelineSegment } from '@/renderer/store/editing-store';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { FCP_TIMELINE_CONFIG as CFG } from './fcpTimelineConfig';
import { thumbUrlSized, baseName } from './mediaUrl';
import WaveformCanvas from './WaveformCanvas';

export interface FcpTimelineProps {
  /** 当前播放头（秒），由 MusicPreviewPanel 拥有并下发 */
  scrub: number;
  /** 成片总时长（秒） */
  totalDur: number;
  /** 拖拽播放头中实时调用（直接 seek 主 video，不重启 Web Audio） */
  onScrub: (t: number) => void;
  /** 松手 / 点击跳转（播放中会重启 Web Audio，与旧 Slider onChangeCommitted 同语义） */
  onScrubCommit: (t: number) => void;
  playing: boolean;
  canPlay: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  hasVoice: boolean;
  showSafe: boolean;
  onToggleSafe: () => void;
  /** P2：Trim 模式激活中 —— 禁用拖拽重排与点选，避免与 TrimEditor 冲突 */
  trimActive: boolean;
  /** P2：双击片段请求进入重选时段（素材时长未知时由父级提示并拦截） */
  onTrimRequest: (index: number) => void;
  /** P3：T2 字幕块（TimelineEditor 计算的 subs，区间与 T1 同一时间模型） */
  subs?: Array<{ i?: number; start: number; end: number; text: string }>;
  /** P3：双击字幕块 → 打开现有字幕编辑 Popover（subIndex = subs 数组下标，
      与 TimelineEditor openEdit 签名一致，内部自映射 segment 下标） */
  onSubtitleEdit?: (subIndex: number, e: React.MouseEvent) => void;
  /** P3：T3 波形峰值（0..1）与音频源时长（秒）；null = 无/解析中 */
  voicePeaks?: number[] | null;
  voiceDur?: number;
  bgmPeaks?: number[] | null;
  bgmDur?: number;
  /** P3：音量（0-100）与设置回调（静音 = 置 0 / 恢复原值） */
  voiceVolume?: number;
  bgmVolume?: number;
  onVoiceVolume?: (v: number) => void;
  onBgmVolume?: (v: number) => void;
  /** P3：BGM 名称（空 = 未选择，渲染空态提示） */
  bgmName?: string;
}

interface ClipLayout {
  widths: number[];
  positions: number[];
  cumDur: number[]; // cumDur[i] = 第 i 段起点时刻
  trackW: number;
  total: number;
}

interface DragState {
  idx: number;          // 被拖片段在 timeline 中的原始下标
  ghostX: number;       // ghost 左缘（轨道内 px）
  order: number[];      // 当前预览顺序（元素为 timeline 下标）
  snapX: number | null; // 已吸附的吸附线 x（px）
  snapSeq: number;      // 新吸附 +1，用于重触发微弹跳动画
}

interface PointerSession {
  kind: 'clip' | 'scrub';
  idx: number;          // clip 会话有效
  startClientX: number;
  startClipX: number;
  dragging: boolean;    // clip 会话：是否已越过拖拽阈值
}

/** P3：T2/T3 折叠状态（localStorage 持久化） */
interface TrackCollapse { subtitle: boolean; audio: boolean; }

const loadTrackCollapse = (): TrackCollapse => {
  try {
    const v = JSON.parse(localStorage.getItem(CFG.trackCollapseStorageKey) || '{}');
    return { subtitle: !!v?.subtitle, audio: !!v?.audio };
  } catch {
    return { subtitle: false, audio: false };
  }
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── 单个片段（memo，避免播放头 60fps 更新时整轨重绘） ── */
interface ClipViewProps {
  seg: TimelineSegment;
  num: number;
  width: number;
  x: number;
  thumb: string;
  selected: boolean;
  insufficient: boolean;
  transitionMs: number | null; // null = 无过渡（拖拽中的 ghost / 非拖拽态静止）
  ghost: boolean;
  snapSeq: number;
  onPress: (i: number, e: React.PointerEvent) => void;
  onTrim: (i: number) => void;
  index: number;
  tooltipsEnabled: boolean;
}

const ClipView = React.memo<ClipViewProps>(({
  seg, num, width, x, thumb, selected, insufficient, transitionMs, ghost, snapSeq, onPress, onTrim, index, tooltipsEnabled,
}) => {
  const label = `${baseName(seg.video_path)}\n入点 ${seg.start_time.toFixed(1)}s – ${(seg.start_time + seg.duration).toFixed(1)}s · 槽长 ${seg.duration.toFixed(1)}s\n双击重选时段`;
  const face = (
    <Box
      sx={{
        position: 'absolute', left: 0, top: 0, width, height: '100%',
        transform: `translateX(${x}px)`,
        transition: transitionMs !== null ? `transform ${transitionMs}ms ease` : 'none',
        zIndex: ghost ? 30 : 1,
        opacity: ghost ? CFG.dragGhostOpacity : 1,
        pointerEvents: ghost ? 'none' : 'auto',
        willChange: 'transform',
      }}
    >
      {/* 吸附微弹跳：snapSeq 变化时重挂载重放动画 */}
      <Box
        key={ghost ? snapSeq : 0}
        sx={{
          width: '100%', height: '100%',
          '@keyframes fcpSnapBounce': { '50%': { transform: 'scale(1.04)' } },
          animation: ghost && snapSeq > 0 ? `fcpSnapBounce ${CFG.bounceMs}ms ease` : 'none',
        }}
      >
        <Box
          onPointerDown={ghost ? undefined : (e) => onPress(index, e)}
          onDoubleClick={ghost ? undefined : () => onTrim(index)}
          sx={{
            position: 'relative', width: '100%', height: '100%',
            borderRadius: 1, overflow: 'hidden', cursor: 'grab',
            border: '1px solid', borderColor: 'divider',
            outline: selected ? '2px solid' : 'none',
            outlineColor: 'primary.main',
            outlineOffset: -2,
            bgcolor: 'action.hover',
            userSelect: 'none',
          }}
        >
          <img
            src={thumb} alt="" draggable={false} loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', pointerEvents: 'none' }}
            onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0'; }}
          />
          {/* 序号 */}
          <Box sx={{ position: 'absolute', top: 2, left: 2, px: 0.5, borderRadius: 0.5, bgcolor: 'rgba(0,0,0,0.55)', color: 'common.white', fontSize: '0.6rem', lineHeight: 1.4, fontFamily: 'monospace' }}>
            {num}
          </Box>
          {/* 槽时长 */}
          <Box sx={{ position: 'absolute', bottom: 2, right: 2, px: 0.5, borderRadius: 0.5, bgcolor: 'rgba(0,0,0,0.55)', color: 'common.white', fontSize: '0.6rem', lineHeight: 1.4, fontFamily: 'monospace' }}>
            {seg.duration.toFixed(1)}s
          </Box>
          {/* 素材时长不足警告 */}
          {insufficient && (
            <Tooltip title="素材时长不足，无法填满口播槽" arrow>
              <Box sx={{
                position: 'absolute', top: 2, right: 2, width: 16, height: 16, borderRadius: '50%',
                bgcolor: 'error.main', color: 'error.contrastText',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.65rem', fontWeight: 800, lineHeight: 1,
              }}>!</Box>
            </Tooltip>
          )}
        </Box>
      </Box>
    </Box>
  );
  return (
    <Tooltip title={label} arrow disableHoverListener={!tooltipsEnabled}>
      {face}
    </Tooltip>
  );
});
ClipView.displayName = 'ClipView';

/* ── P3：T2 字幕块（memo：props 全为原始值/稳定回调，scrub 60fps 更新不重绘） ── */
interface SubBlockProps {
  text: string;
  x: number;
  width: number;
  selected: boolean;
  dimmed: boolean;
  disabled: boolean;       // trimActive：禁用点击
  segI: number | undefined;
  start: number;
  subIndex: number;
  selectedTint: string;    // useTheme 解析的 primary 淡染
  onSeek: (segI: number | undefined, start: number) => void;
  onEdit: (subIndex: number, e: React.MouseEvent) => void;
}

const SubBlock = React.memo<SubBlockProps>(({
  text, x, width, selected, dimmed, disabled, segI, start, subIndex, selectedTint, onSeek, onEdit,
}) => (
  <Tooltip title={text} arrow disableHoverListener={disabled}>
    <Box
      onPointerDown={(e) => e.stopPropagation()}
      onClick={disabled ? undefined : () => onSeek(segI, start)}
      onDoubleClick={disabled ? undefined : (e) => onEdit(subIndex, e)}
      sx={{
        position: 'absolute', left: x, top: 3, height: CFG.subtitleTrackHeight - 6,
        width: Math.max(3, width - 1),
        display: 'flex', alignItems: 'center', px: 0.5,
        borderRadius: 0.5, overflow: 'hidden', userSelect: 'none',
        cursor: disabled ? 'default' : 'pointer',
        border: '1px solid', borderColor: selected ? 'primary.main' : 'divider',
        bgcolor: selected ? selectedTint : 'action.hover',
        opacity: dimmed ? CFG.subtitleDimOpacity : 1,
        transition: 'opacity 120ms ease',
      }}
    >
      <Typography sx={{
        fontSize: '0.6rem', lineHeight: 1.2,
        color: selected ? 'primary.main' : 'text.secondary',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {text}
      </Typography>
    </Box>
  </Tooltip>
));
SubBlock.displayName = 'SubBlock';

/* ── P3：sticky 左标签列单元格（视频/字幕/音频 + T2/T3 折叠开关） ── */
interface TrackLabelCellProps {
  label: string;
  height: number;
  borderTop?: boolean;
  collapseKey?: 'subtitle' | 'audio';
  collapsed?: boolean;
  onToggleCollapse?: (k: 'subtitle' | 'audio') => void;
}

const TrackLabelCell = React.memo<TrackLabelCellProps>(({
  label, height, borderTop, collapseKey, collapsed, onToggleCollapse,
}) => (
  <Box sx={{
    height, overflow: 'hidden', userSelect: 'none',
    borderTop: borderTop ? '1px solid' : 'none', borderColor: 'divider',
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  }}>
    <Typography sx={{ fontSize: '0.6rem', lineHeight: 1.3, color: 'text.secondary' }}>{label}</Typography>
    {collapseKey && (
      <IconButton
        size="small" sx={{ p: 0 }}
        onClick={() => onToggleCollapse?.(collapseKey)}
        title={collapsed ? '展开轨道' : '折叠轨道'}
      >
        {collapsed ? <ExpandMoreIcon sx={{ fontSize: 14 }} /> : <ExpandLessIcon sx={{ fontSize: 14 }} />}
      </IconButton>
    )}
  </Box>
));
TrackLabelCell.displayName = 'TrackLabelCell';

/* ── P3：T3 子行右侧 sticky 音量控制（标签 + 静音 + 滑杆 + 数值） ── */
interface AudioRowControlsProps {
  label: string;
  volume: number;
  onVolume?: (v: number) => void;
  onToggleMute: () => void;
}

const AudioRowControls = React.memo<AudioRowControlsProps>(({
  label, volume, onVolume, onToggleMute,
}) => (
  <Box
    onPointerDown={(e) => e.stopPropagation()}
    sx={{
      position: 'sticky', right: 0, flexShrink: 0, alignSelf: 'stretch', zIndex: 6,
      display: 'flex', alignItems: 'center', gap: 0.25, pl: 0.75, pr: 0.5,
      bgcolor: 'background.paper', borderLeft: '1px solid', borderColor: 'divider',
    }}
  >
    <Typography
      title={label}
      sx={{ fontSize: '0.6rem', color: 'text.secondary', maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      {label}
    </Typography>
    <IconButton size="small" onClick={onToggleMute} sx={{ p: 0.25 }} title={volume > 0 ? '静音' : '恢复音量'}>
      {volume > 0
        ? <VolumeUpIcon sx={{ fontSize: 15 }} />
        : <VolumeOffIcon sx={{ fontSize: 15 }} color="disabled" />}
    </IconButton>
    <Slider
      size="small" min={0} max={100} value={volume}
      onChange={(_, v) => onVolume?.(v as number)}
      sx={{ width: 64 }}
    />
    <Typography sx={{ fontSize: '0.55rem', fontFamily: 'monospace', color: 'text.secondary', width: 22, textAlign: 'right' }}>
      {volume}
    </Typography>
  </Box>
));
AudioRowControls.displayName = 'AudioRowControls';

/* ── 主组件 ── */
const FcpTimeline: React.FC<FcpTimelineProps> = ({
  scrub, totalDur, onScrub, onScrubCommit,
  playing, canPlay, onTogglePlay, onStop, hasVoice, showSafe, onToggleSafe,
  trimActive, onTrimRequest,
  subs = [], onSubtitleEdit,
  voicePeaks = null, voiceDur = 0, bgmPeaks = null, bgmDur = 0,
  voiceVolume = 100, bgmVolume = 80, onVoiceVolume, onBgmVolume,
  bgmName = '',
}) => {
  const theme = useTheme();
  const bu = useBackendUrl();
  const tl = useEditingStore((s) => s.timeline);
  const selectedIdx = useEditingStore((s) => s.selectedSegmentIndex);
  const setSelectedIdx = useEditingStore((s) => s.setSelectedSegmentIndex);
  const reorderTimeline = useEditingStore((s) => s.reorderTimeline);
  const aspect = useEditingStore((s) => s.videoAspect);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [containerW, setContainerW] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const sessionRef = useRef<PointerSession | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  // RAF 节流：指针事件只记录最新值，每帧最多应用一次
  const rafRef = useRef(0);
  const pendingXRef = useRef<number | null>(null);
  // 用户手动横向滚动（滚轮/触摸）的时间戳：播放跟随在该窗口期内让位，不与用户抢滚动条
  const userScrollTsRef = useRef(0);

  /* P3：T2/T3 折叠状态（localStorage 持久化） */
  const [collapsed, setCollapsed] = useState<TrackCollapse>(loadTrackCollapse);
  useEffect(() => {
    try { localStorage.setItem(CFG.trackCollapseStorageKey, JSON.stringify(collapsed)); } catch { /* 隐私模式等写失败可忽略 */ }
  }, [collapsed]);
  const toggleCollapse = useCallback((k: 'subtitle' | 'audio') => {
    setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  }, []);

  /* P3：静音记忆（置 0 前的非零音量，取消静音时恢复） */
  const prevVolRef = useRef<{ voice: number; bgm: number }>({ voice: 100, bgm: 80 });
  const toggleMute = useCallback((kind: 'voice' | 'bgm') => {
    const vol = kind === 'voice' ? voiceVolume : bgmVolume;
    const setter = kind === 'voice' ? onVoiceVolume : onBgmVolume;
    if (!setter) return;
    if (vol > 0) {
      prevVolRef.current[kind] = vol;
      setter(0);
    } else {
      setter(prevVolRef.current[kind] > 0 ? prevVolRef.current[kind] : (kind === 'voice' ? 100 : 80));
    }
  }, [voiceVolume, bgmVolume, onVoiceVolume, onBgmVolume]);
  const toggleVoiceMute = useCallback(() => toggleMute('voice'), [toggleMute]);
  const toggleBgmMute = useCallback(() => toggleMute('bgm'), [toggleMute]);

  /* P3：字幕块联动（单击 = 选中对应片段 + 播放头跳转块起点，与 T1 单击同语义） */
  const handleSubSeek = useCallback((segI: number | undefined, start: number) => {
    if (segI != null) setSelectedIdx(segI);
    onScrubCommit(start);
  }, [setSelectedIdx, onScrubCommit]);
  const handleSubEdit = useCallback((subIndex: number, e: React.MouseEvent) => {
    onSubtitleEdit?.(subIndex, e);
  }, [onSubtitleEdit]);

  /* P3：选中字幕块的 primary 淡染（useTheme 解析，禁止硬编码） */
  const subSelectedTint = alpha(theme.palette.primary.main, 0.16);

  /* 容器宽度测量（trackWidth = max(容器宽, 总时长 × pxPerSec)） */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  /* 布局：宽度 ∝ duration，最小宽兜底；时间↔像素双向映射经过片段内插值，
     即使最小宽生效，播放头/标尺仍与片段边缘严格对齐 */
  const layout = useMemo<ClipLayout>(() => {
    const total = tl.reduce((a, s) => a + (s.duration || 0), 0);
    if (total <= 0) return { widths: [], positions: [], cumDur: [], trackW: 0, total: 0 };
    const idealW = tl.map((s) => Math.max(CFG.minClipWidth, (s.duration || 0) * CFG.pxPerSec));
    const idealTrackW = idealW.reduce((a, w) => a + w, 0);
    const scale = containerW > idealTrackW ? containerW / idealTrackW : 1;
    const widths = idealW.map((w) => w * scale);
    const positions: number[] = [];
    const cumDur: number[] = [];
    let x = 0; let t = 0;
    for (let i = 0; i < tl.length; i++) {
      positions.push(x); cumDur.push(t);
      x += widths[i]; t += tl[i].duration || 0;
    }
    return { widths, positions, cumDur, trackW: x, total };
  }, [tl, containerW]);

  const timeToX = useCallback((t: number): number => {
    const { widths, positions, cumDur, trackW, total } = layout;
    if (total <= 0) return 0;
    const tc = clamp(t, 0, total);
    for (let i = 0; i < widths.length; i++) {
      const dur = tl[i].duration || 0;
      if (tc < cumDur[i] + dur || i === widths.length - 1) {
        const f = dur > 0 ? clamp((tc - cumDur[i]) / dur, 0, 1) : 0;
        return positions[i] + f * widths[i];
      }
    }
    return trackW;
  }, [layout, tl]);

  const xToTime = useCallback((x: number): number => {
    const { widths, positions, cumDur, total } = layout;
    if (total <= 0) return 0;
    const xc = clamp(x, 0, layout.trackW);
    for (let i = 0; i < widths.length; i++) {
      if (xc < positions[i] + widths[i] || i === widths.length - 1) {
        const f = widths[i] > 0 ? clamp((xc - positions[i]) / widths[i], 0, 1) : 0;
        return cumDur[i] + f * (tl[i].duration || 0);
      }
    }
    return total;
  }, [layout, tl]);

  /* 指针 x（clientX）→ 轨道内 x（px） */
  const clientToTrackX = useCallback((clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return clientX - r.left + el.scrollLeft;
  }, []);

  /* ── scrub 会话（播放头拖动 / 标尺按住拖动）：RAF 节流 onScrub，松手 onScrubCommit ── */
  const applyScrubMove = useCallback(() => {
    rafRef.current = 0;
    if (pendingXRef.current === null) return;
    const t = xToTime(pendingXRef.current);
    onScrub(t);
  }, [xToTime, onScrub]);

  const startScrubSession = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    sessionRef.current = { kind: 'scrub', idx: -1, startClientX: e.clientX, startClipX: 0, dragging: true };
    pendingXRef.current = clientToTrackX(e.clientX);
    onScrub(xToTime(pendingXRef.current));

    const onMove = (ev: PointerEvent) => {
      if (!sessionRef.current || sessionRef.current.kind !== 'scrub') return;
      pendingXRef.current = clientToTrackX(ev.clientX);
      if (!rafRef.current) rafRef.current = requestAnimationFrame(applyScrubMove);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      sessionRef.current = null;
      pendingXRef.current = null;
      onScrubCommit(xToTime(clientToTrackX(ev.clientX)));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [clientToTrackX, xToTime, onScrub, onScrubCommit, applyScrubMove]);

  /* ── 片段按下：可能是点击选中，也可能是拖拽重排（Trim 模式下禁用，避免冲突） ── */
  const handleClipPress = useCallback((i: number, e: React.PointerEvent) => {
    if (e.button !== 0 || trimActive) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = layout.positions[i] ?? 0;
    sessionRef.current = { kind: 'clip', idx: i, startClientX: e.clientX, startClipX: startX, dragging: false };

    const onMove = (ev: PointerEvent) => {
      const sess = sessionRef.current;
      if (!sess || sess.kind !== 'clip') return;
      pendingXRef.current = ev.clientX;
      if (!rafRef.current) rafRef.current = requestAnimationFrame(applyClipMove);
    };
    const applyClipMove = () => {
      rafRef.current = 0;
      const sess = sessionRef.current;
      if (!sess || sess.kind !== 'clip' || pendingXRef.current === null) return;
      const clientX = pendingXRef.current;
      const dx = clientX - sess.startClientX;
      const cur = dragRef.current;
      if (!sess.dragging && Math.abs(dx) < CFG.dragStartThresholdPx) return;
      const w = layout.widths[sess.idx] ?? CFG.minClipWidth;
      const baseOrder = cur ? cur.order : tl.map((_, k) => k);
      let ghostX = clamp(sess.startClipX + dx, 0, Math.max(0, layout.trackW - w));
      const center = ghostX + w / 2;

      // 1) 目标插入位：ghost 中心越过相邻片段（当前让位布局下）中点即换位
      const others = baseOrder.filter((o) => o !== sess.idx);
      let acc = 0; let target = 0;
      for (const oi of baseOrder) {
        if (oi === sess.idx) { acc += layout.widths[oi] ?? 0; continue; }
        const mid = acc + (layout.widths[oi] ?? 0) / 2;
        if (center > mid) target++;
        acc += layout.widths[oi] ?? 0;
      }

      // 2) 磁吸：ghost 左缘吸附到最近的槽位边界（含轨道起止），阈值内生效
      let bAcc = 0; let snapX: number | null = null; let bestD = CFG.snapThresholdPx + 0.5;
      for (let j = 0; j <= others.length; j++) {
        const d = Math.abs(ghostX - bAcc);
        if (d <= CFG.snapThresholdPx && d < bestD) { bestD = d; snapX = bAcc; }
        if (j < others.length) bAcc += layout.widths[others[j]] ?? 0;
      }
      if (snapX !== null) ghostX = snapX;

      // 3) 预览顺序更新（仅本地 state，不写 store）
      const curTarget = cur ? cur.order.indexOf(sess.idx) : sess.idx;
      const newOrder = target === curTarget
        ? baseOrder
        : [...others.slice(0, target), sess.idx, ...others.slice(target)];
      const snapSeq = cur && snapX !== null && snapX !== cur.snapX ? cur.snapSeq + 1 : (cur?.snapSeq ?? 0);
      sess.dragging = true;
      setDrag({ idx: sess.idx, ghostX, order: newOrder, snapX, snapSeq });
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey, true);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      pendingXRef.current = null;
      const sess = sessionRef.current;
      sessionRef.current = null;
      const cur = dragRef.current;
      setDrag(null);
      if (!sess || sess.kind !== 'clip') return;
      if (sess.dragging && cur) {
        // 松手一次性写回 store（拖拽中从未写 store，取消则原样保留）
        if (commit) {
          const to = cur.order.indexOf(sess.idx);
          if (to !== sess.idx) reorderTimeline(sess.idx, to);
        }
      } else if (!sess.dragging && commit) {
        // 单击：选中片段 + 播放头定位到片段起点
        setSelectedIdx(sess.idx);
        onScrubCommit(layout.cumDur[sess.idx] ?? 0);
      }
    };
    const onUp = () => finish(true);
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
  }, [layout, tl, reorderTimeline, setSelectedIdx, onScrubCommit, trimActive]);

  /* 卸载兜底：清理 RAF 与窗口监听 */
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  /* 轨道空白处点击：跳转播放头并取消选中（T1/T2/T3 空白区共用） */
  const handleTrackEmpty = useCallback((e: React.PointerEvent) => {
    if (drag) return;
    setSelectedIdx(null);
    onScrubCommit(xToTime(clientToTrackX(e.clientX)));
  }, [drag, xToTime, clientToTrackX, onScrubCommit, setSelectedIdx]);

  /* 播放头 x（px），播放中由 MusicPreviewPanel 的 RAF 驱动 scrub 更新跟随 */
  const playheadX = timeToX(Math.min(scrub, layout.total || totalDur || 0));

  /* P3：T3 波形的时间轴覆盖基准（与 timeToX 同一时间模型） */
  const effTotal = layout.total || totalDur || 0;

  /* 播放中播放头自动跟随滚动：仅当播放头越出可视窗口（右缘留 40px 余量 / 左缘）
     才平滑滚动，使播放头落在视口左起 ~20% 处 —— 不越窗不动，避免抖动；
     拖拽片段 / 拖播放头 scrub / 用户刚手动滚动过（1.2s 内）时均不干预。 */
  useEffect(() => {
    if (!playing) return;
    if (drag || sessionRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    if (Date.now() - userScrollTsRef.current < 1200) return;
    const viewW = el.clientWidth;
    if (viewW <= 0) return;
    const left = el.scrollLeft;
    if (playheadX > left + viewW - 40 || playheadX < left) {
      el.scrollTo({ left: Math.max(0, playheadX - viewW * 0.2), behavior: 'smooth' });
    }
  }, [playing, playheadX, drag]);

  /* 拖拽中各片段的展示位置（被拖片段走 ghostX，其余按预览顺序让位） */
  const display = useMemo(() => {
    const xs = new Array(tl.length).fill(0) as number[];
    const nums = new Array(tl.length).fill(0) as number[];
    if (!drag) {
      for (let i = 0; i < tl.length; i++) { xs[i] = layout.positions[i] ?? 0; nums[i] = i + 1; }
      return { xs, nums };
    }
    let acc = 0; let num = 1;
    for (const oi of drag.order) {
      if (oi === drag.idx) { xs[oi] = drag.ghostX; nums[oi] = num++; acc += layout.widths[oi] ?? 0; continue; }
      xs[oi] = acc; nums[oi] = num++; acc += layout.widths[oi] ?? 0;
    }
    return { xs, nums };
  }, [drag, layout, tl.length]);

  if (tl.length === 0) {
    return (
      <Box sx={{ mt: 0.5, p: 1, border: '1px dashed', borderColor: 'divider', borderRadius: 1, textAlign: 'center' }}>
        <Typography variant="caption" color="text.secondary">生成时间线后可在此拖拽排序、点选替换素材</Typography>
      </Box>
    );
  }

  const ticks: number[] = [];
  for (let t = 0; t <= Math.floor(layout.total); t++) ticks.push(t);

  /* P3：三轨高度派生（折叠后保留 collapsedTrackHeight 分隔条，标签列与轨道严格同高） */
  const subLaneH = collapsed.subtitle ? CFG.collapsedTrackHeight : CFG.subtitleTrackHeight;
  const audLaneH = collapsed.audio ? CFG.collapsedTrackHeight : CFG.audioSubRowHeight * 2;
  const t2Top = CFG.rulerHeight + CFG.trackHeight;
  const t3Top = t2Top + subLaneH;
  const contentH = t3Top + audLaneH;

  return (
    <Box sx={{ mt: 0.5 }}>
      {/* ── 播放控制行 ── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        <IconButton size="small" onClick={onTogglePlay} disabled={!canPlay} color={playing ? 'secondary' : 'primary'}>
          {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </IconButton>
        <IconButton size="small" onClick={onStop} disabled={!canPlay} color="error" title="停止并回到开头">
          <StopIcon fontSize="small" />
        </IconButton>
        <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
          {scrub.toFixed(1)}s / {totalDur.toFixed(1)}s
        </Typography>
        <Box sx={{ flex: 1 }} />
        {!hasVoice && (
          <Typography variant="caption" color="warning.main" sx={{ whiteSpace: 'nowrap', fontSize: '0.65rem' }}>请生成口播</Typography>
        )}
        <Chip label="安全区" size="small" color={showSafe ? 'primary' : 'default'} variant={showSafe ? 'filled' : 'outlined'}
          onClick={onToggleSafe} sx={{ cursor: 'pointer', height: 24, fontSize: '0.65rem' }} title="显示九宫格与字幕安全区参考线" />
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: '0.6rem', whiteSpace: 'nowrap' }}>
          空格 播放 · ←/→ 微调
        </Typography>
      </Box>

      {/* ── 标签列 + 标尺/三轨（标签列 sticky 不随横向滚动） ── */}
      <Box sx={{
        display: 'flex', alignItems: 'stretch', borderRadius: 1, overflow: 'hidden',
        border: '1px solid', borderColor: 'divider', bgcolor: 'background.paperAlt',
      }}>
        {/* sticky 左标签列（在滚动容器之外 = 恒不横向滚动） */}
        <Box sx={{
          width: CFG.trackLabelWidth, flexShrink: 0, zIndex: 2,
          borderRight: '1px solid', borderColor: 'divider', bgcolor: 'background.paper',
        }}>
          <Box sx={{ height: CFG.rulerHeight, borderBottom: '1px solid', borderColor: 'divider' }} />
          <TrackLabelCell label="视频" height={CFG.trackHeight} />
          <TrackLabelCell
            label="字幕" height={subLaneH} borderTop
            collapseKey="subtitle" collapsed={collapsed.subtitle} onToggleCollapse={toggleCollapse}
          />
          <TrackLabelCell
            label="音频" height={audLaneH} borderTop
            collapseKey="audio" collapsed={collapsed.audio} onToggleCollapse={toggleCollapse}
          />
        </Box>

        {/* 横向滚动区（标尺 + T1/T2/T3 + 跨轨播放头） */}
        <Box
          ref={scrollRef}
          onWheel={() => { userScrollTsRef.current = Date.now(); }}
          onTouchStart={() => { userScrollTsRef.current = Date.now(); }}
          sx={{
            flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden',
            cursor: drag ? 'grabbing' : 'default',
          }}
        >
          <Box sx={{ position: 'relative', width: layout.trackW, height: contentH }}>
            {/* 时间标尺（点击/按住拖动均可跳转） */}
            <Box
              onPointerDown={startScrubSession}
              sx={{
                position: 'absolute', top: 0, left: 0, right: 0, height: CFG.rulerHeight,
                cursor: 'pointer', userSelect: 'none',
                borderBottom: '1px solid', borderColor: 'divider',
              }}
            >
              {ticks.map((t) => {
                const x = timeToX(t);
                return (
                  <Box key={t} sx={{ position: 'absolute', left: x, top: 0, height: '100%' }}>
                    <Box sx={{ width: 1, height: 6, bgcolor: 'divider' }} />
                    <Typography sx={{ fontSize: '0.55rem', lineHeight: 1, color: 'text.secondary', fontFamily: 'monospace', ml: '2px', mt: '1px' }}>
                      {t}s
                    </Typography>
                  </Box>
                );
              })}
            </Box>

            {/* T1 视频轨（Trim 模式中压暗并禁用片段交互，避免与 TrimEditor 冲突） */}
            <Box
              onPointerDown={handleTrackEmpty}
              sx={{
                position: 'absolute', top: CFG.rulerHeight, left: 0, width: layout.trackW, height: CFG.trackHeight,
                opacity: trimActive ? 0.45 : 1, transition: 'opacity 120ms ease',
              }}
            >
              {tl.map((seg, i) => (
                <ClipView
                  key={`${i}-${seg.video_path}`}
                  index={i}
                  seg={seg}
                  num={display.nums[i]}
                  width={layout.widths[i] ?? CFG.minClipWidth}
                  x={display.xs[i]}
                  thumb={thumbUrlSized(bu, seg.video_path, (seg.start_time || 0) + (seg.duration || 0) / 2, 160, aspect)}
                  selected={selectedIdx === i}
                  insufficient={seg.source_duration != null && seg.source_duration > 0 && seg.source_duration < seg.duration}
                  transitionMs={drag && drag.idx !== i ? CFG.reflowMs : null}
                  ghost={drag?.idx === i}
                  snapSeq={drag?.idx === i ? drag.snapSeq : 0}
                  onPress={handleClipPress}
                  onTrim={onTrimRequest}
                  tooltipsEnabled={!drag && !trimActive}
                />
              ))}
              {/* 磁吸吸附线 */}
              {drag && drag.snapX !== null && (
                <Box sx={{
                  position: 'absolute', top: -2, bottom: -2, left: drag.snapX - 1, width: 2,
                  bgcolor: 'primary.main', color: 'primary.main', zIndex: 25, pointerEvents: 'none',
                  boxShadow: '0 0 4px 0 currentColor',
                }} />
              )}
            </Box>

            {/* T2 字幕轨（只读；Trim 模式压暗 + 禁用点击） */}
            <Box
              onPointerDown={trimActive ? undefined : handleTrackEmpty}
              sx={{
                position: 'absolute', top: t2Top, left: 0, width: layout.trackW, height: subLaneH,
                borderTop: '1px solid', borderColor: 'divider',
                opacity: trimActive ? 0.45 : 1, transition: 'opacity 120ms ease',
                pointerEvents: trimActive ? 'none' : 'auto',
              }}
            >
              {!collapsed.subtitle && subs.map((s, si) => {
                if (!s.text) return null; // 空段不渲染
                const x = timeToX(s.start);
                const w = timeToX(s.end) - x;
                return (
                  <SubBlock
                    key={si}
                    text={s.text}
                    x={x}
                    width={w}
                    selected={selectedIdx !== null && s.i === selectedIdx}
                    dimmed={selectedIdx !== null && s.i !== selectedIdx}
                    disabled={trimActive}
                    segI={s.i}
                    start={s.start}
                    subIndex={si}
                    selectedTint={subSelectedTint}
                    onSeek={handleSubSeek}
                    onEdit={handleSubEdit}
                  />
                );
              })}
            </Box>

            {/* T3 音频轨（口播 + BGM 两行波形；只读位置，音量/静音可调；
                Trim 模式压暗 + 禁用点击） */}
            <Box
              sx={{
                position: 'absolute', top: t3Top, left: 0, width: layout.trackW, height: audLaneH,
                borderTop: '1px solid', borderColor: 'divider',
                opacity: trimActive ? 0.45 : 1, transition: 'opacity 120ms ease',
                pointerEvents: trimActive ? 'none' : 'auto',
              }}
            >
              {!collapsed.audio && (
                <>
                  {/* 口播行 */}
                  <Box sx={{ display: 'flex', width: layout.trackW, height: CFG.audioSubRowHeight }}>
                    <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
                      {!hasVoice ? (
                        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>无口播音频</Typography>
                        </Box>
                      ) : voicePeaks ? (
                        <Box sx={{ position: 'absolute', left: 0, top: 0 }}>
                          <WaveformCanvas
                            peaks={voicePeaks}
                            audioDur={voiceDur}
                            spanSec={Math.min(voiceDur || 0, effTotal)}
                            width={layout.trackW}
                            height={CFG.audioSubRowHeight}
                            playheadX={playheadX}
                            xToTime={xToTime}
                            fadeFromSec={null}
                            fadeToSec={null}
                            unplayedAlpha={CFG.waveformUnplayedAlpha}
                          />
                        </Box>
                      ) : (
                        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>波形解析中…</Typography>
                        </Box>
                      )}
                    </Box>
                    {hasVoice && (
                      <AudioRowControls
                        label="口播"
                        volume={voiceVolume}
                        onVolume={onVoiceVolume}
                        onToggleMute={toggleVoiceMute}
                      />
                    )}
                  </Box>
                  {/* BGM 行（尾部 bgmFadeOutSec 秒视觉淡出，与 play() 增益包络同形） */}
                  <Box sx={{
                    display: 'flex', width: layout.trackW, height: CFG.audioSubRowHeight,
                    borderTop: '1px solid', borderColor: 'divider',
                  }}>
                    <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
                      {!bgmName ? (
                        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>未选择 BGM</Typography>
                        </Box>
                      ) : bgmPeaks ? (
                        <Box sx={{ position: 'absolute', left: 0, top: 0 }}>
                          <WaveformCanvas
                            peaks={bgmPeaks}
                            audioDur={bgmDur}
                            spanSec={effTotal}
                            width={layout.trackW}
                            height={CFG.audioSubRowHeight}
                            playheadX={playheadX}
                            xToTime={xToTime}
                            fadeFromSec={Math.max(0, effTotal - CFG.bgmFadeOutSec)}
                            fadeToSec={effTotal}
                            unplayedAlpha={CFG.waveformUnplayedAlpha}
                          />
                        </Box>
                      ) : (
                        <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <Typography sx={{ fontSize: '0.6rem', color: 'text.disabled' }}>波形解析中…</Typography>
                        </Box>
                      )}
                    </Box>
                    {bgmName && (
                      <AudioRowControls
                        label={bgmName}
                        volume={bgmVolume}
                        onVolume={onBgmVolume}
                        onToggleMute={toggleBgmMute}
                      />
                    )}
                  </Box>
                </>
              )}
            </Box>

            {/* 播放头（跨标尺+全部展开轨道） */}
            <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: playheadX - CFG.playheadWidth / 2, width: CFG.playheadWidth, bgcolor: 'warning.main', zIndex: 20, pointerEvents: 'none' }} />
            {/* 播放头抓手（放大热区） */}
            <Box
              onPointerDown={startScrubSession}
              sx={{
                position: 'absolute', top: 0, height: CFG.rulerHeight + 6,
                left: playheadX - CFG.playheadGripWidth / 2, width: CFG.playheadGripWidth,
                cursor: 'ew-resize', zIndex: 21, touchAction: 'none',
              }}
            >
              <Box sx={{
                position: 'absolute', top: 0, left: (CFG.playheadGripWidth - 8) / 2, width: 8, height: 8,
                bgcolor: 'warning.main', borderRadius: '0 0 2px 2px',
              }} />
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default FcpTimeline;
