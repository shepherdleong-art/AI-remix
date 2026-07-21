/**
 * TrimEditor — P2 重选时段（剪映式）：整条素材胶片条 + 固定宽度选择框滑选入点。
 *
 * 由 MusicPreviewPanel 在「预览框」与「FcpTimeline」之间渲染（双击 T1 片段进入）。
 *
 *  - 胶片条：覆盖整条素材（source_duration），/thumb 小尺寸帧（w=trimThumbWidth，
 *    缓存键含尺寸），~0.5s 一帧，分批增量加载（占位格 → 逐批填充）
 *  - 选择框：固定宽度 = duration/source_duration × stripWidth，pointer 拖拽
 *    （transform 平移，RAF 节流 ≤60fps），活动域 [0, source_duration - duration]
 *  - 磁吸：左缘距整秒位置 ≤ trimSnapThresholdPx 时吸附到整秒
 *  - 大预览联动：拖拽中选择框左缘时刻经 onBoxTimeChange 上报（RAF 节流 +
 *    trimSeekMinDeltaSec 最小位移节流，松手强制上报终值），父级直接 seek
 *    320 预览框里的 trim 预览视频，大画面实时跟随（替代原小图实时帧预览）
 *  - 循环试听：工具条 ▶/⏸ 开关（auditioning / onToggleAudition 由父级实现），
 *    在 [入点, 入点+槽长] 内循环播放素材源；新一轮拖拽开始经 onDragStart
 *    通知父级暂停试听、恢复实时跟随
 *  - 写回策略：拖拽中只动本地 state，松手才写 store（setSegmentInPoint，内部
 *    钳位）→ 合并 300ms 防抖的预览重 assemble；「完成」= 以当前入点关闭，
 *    「取消」/ESC = 恢复进入时的原始入点后关闭
 *  - 区域外画面压暗（rgba 黑罩，非强调色）；强调色一律走 theme token
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import { useEditingStore } from '@/renderer/store/editing-store';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { FCP_TIMELINE_CONFIG as CFG } from './fcpTimelineConfig';
import { thumbUrlSized, baseName } from './mediaUrl';

export interface TrimEditorProps {
  /** 被 trim 的片段在 timeline 中的下标 */
  segmentIndex: number;
  /** 提交/取消后关闭（store 已在内部写定） */
  onClose: () => void;
  /** 拖拽中选择框左缘素材时刻变化（已 RAF + 最小位移节流；松手强制上报终值）。
      父级用它直接 seek 大预览里的 trim 预览视频。 */
  onBoxTimeChange?: (t: number) => void;
  /** 新一轮拖拽开始（含胶片条空白按下跳选）：父级据此暂停循环试听、恢复实时跟随 */
  onDragStart?: () => void;
  /** 循环试听开关状态（父级持有） */
  auditioning?: boolean;
  /** 切换循环试听（父级实现：在 [入点, 入点+槽长] 内循环播放素材源） */
  onToggleAudition?: () => void;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ── 单格胶片帧（自带占位→淡入；加载完成/失败都上报，驱动分批增量加载） ── */
interface FrameCellProps {
  src: string;
  width: number;
  height: number;
  onSettled: () => void;
}
const FrameCell = React.memo<FrameCellProps>(({ src, width, height, onSettled }) => {
  const [ok, setOk] = useState(false);
  return (
    <Box sx={{ width, height, flexShrink: 0, bgcolor: 'action.hover', overflow: 'hidden' }}>
      <img
        src={src} alt="" draggable={false}
        onLoad={() => { setOk(true); onSettled(); }}
        onError={onSettled}
        style={{
          width: '100%', height: '100%', objectFit: 'cover', display: 'block',
          opacity: ok ? 1 : 0, transition: 'opacity 120ms ease', pointerEvents: 'none',
        }}
      />
    </Box>
  );
});
FrameCell.displayName = 'FrameCell';

const TrimEditor: React.FC<TrimEditorProps> = ({
  segmentIndex, onClose, onBoxTimeChange, onDragStart, auditioning = false, onToggleAudition,
}) => {
  const bu = useBackendUrl();
  const seg = useEditingStore((s) => s.timeline[segmentIndex]);
  const aspect = useEditingStore((s) => s.videoAspect);
  const setSegmentInPoint = useEditingStore((s) => s.setSegmentInPoint);

  const srcDur = seg?.source_duration ?? 0;
  const slotDur = seg?.duration ?? 0;
  const maxIn = Math.max(0, srcDur - slotDur);
  const canTrim = srcDur > 0 && maxIn > 0;

  // 进入时的原始入点快照（取消/ESC 恢复用；仅在挂载时捕获一次）
  const origRef = useRef<number>(seg?.start_time ?? 0);
  const [inPoint, setInPoint] = useState(origRef.current);
  const inPointRef = useRef(inPoint);

  const pxPerSec = CFG.trimPxPerSec;

  /* 取帧时刻：~0.5s 一帧，帧数超上限时自动拉大间隔 */
  const interval = useMemo(
    () => (srcDur > 0 ? Math.max(CFG.trimFrameIntervalSec, srcDur / CFG.trimMaxFrames) : CFG.trimFrameIntervalSec),
    [srcDur],
  );
  const times = useMemo(() => {
    if (srcDur <= 0) return [] as number[];
    const n = Math.max(1, Math.ceil(srcDur / interval));
    const arr: number[] = [];
    for (let i = 0; i < n; i++) arr.push(Math.min(i * interval, Math.max(0, srcDur - 0.05)));
    return arr;
  }, [srcDur, interval]);

  /* 条带几何：stripWidth ∝ source_duration；最后一格取余量，保证 时间→像素 映射精确 */
  const stripW = Math.max(1, srcDur * pxPerSec);
  const frameW = useCallback(
    (i: number) => (i < times.length - 1 ? interval * pxPerSec : Math.max(8, stripW - (times.length - 1) * interval * pxPerSec)),
    [times.length, interval, pxPerSec, stripW],
  );
  const boxW = clamp(slotDur * pxPerSec, 24, stripW);
  const boxX = clamp(inPoint, 0, maxIn) * pxPerSec;

  /* 分批增量加载：首屏 trimFrameBatchSize 帧，全部落定后再放下一批 */
  const [windowSize, setWindowSize] = useState<number>(CFG.trimFrameBatchSize);
  const settledRef = useRef(0);
  const [settledTick, setSettledTick] = useState(0);
  useEffect(() => {
    settledRef.current = 0;
    setWindowSize(CFG.trimFrameBatchSize);
  }, [seg?.video_path]);
  const handleFrameSettled = useCallback(() => {
    settledRef.current += 1;
    setSettledTick((t) => t + 1);
  }, []);
  useEffect(() => {
    if (windowSize < times.length && settledRef.current >= windowSize) {
      setWindowSize((w) => Math.min(w + CFG.trimFrameBatchSize, times.length));
    }
  }, [settledTick, windowSize, times.length]);

  /* 大预览联动上报：最小位移 trimSeekMinDeltaSec 二次节流（拖拽本身已 RAF 节流），
     force=true 时无视位移直接上报（松手终值，保证大预览精确落点） */
  const lastFiredRef = useRef(origRef.current);
  const fireBoxTime = useCallback((v: number, force = false) => {
    if (!onBoxTimeChange) return;
    if (force || Math.abs(v - lastFiredRef.current) >= CFG.trimSeekMinDeltaSec) {
      lastFiredRef.current = v;
      onBoxTimeChange(v);
    }
  }, [onBoxTimeChange]);

  /* 拖拽：RAF 节流，只动本地 state；松手一次性写 store */
  const dragRef = useRef<{ startClientX: number; startInPoint: number } | null>(null);
  const rafRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  const applyInPoint = useCallback((raw: number) => {
    let v = clamp(raw, 0, maxIn);
    // 磁吸：左缘距整秒 ≤ 阈值（换算为秒）时吸附到整秒
    const nearest = Math.round(v);
    if (Math.abs(nearest - v) * pxPerSec <= CFG.trimSnapThresholdPx) v = clamp(nearest, 0, maxIn);
    inPointRef.current = v;
    setInPoint(v);
    fireBoxTime(v);
  }, [maxIn, pxPerSec, fireBoxTime]);

  const startDrag = useCallback((e: React.PointerEvent, anchorInPoint?: number) => {
    if (!canTrim || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (anchorInPoint !== undefined) applyInPoint(anchorInPoint);
    dragRef.current = { startClientX: e.clientX, startInPoint: inPointRef.current };
    // 新一轮拖拽开始：父级暂停循环试听，大预览恢复实时跟随
    onDragStart?.();
    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      pendingRef.current = ev.clientX;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const d = dragRef.current;
          if (!d || pendingRef.current === null) return;
          applyInPoint(d.startInPoint + (pendingRef.current - d.startClientX) / pxPerSec);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      dragRef.current = null;
      pendingRef.current = null;
      // 松手：强制上报终值（大预览精确落点），再写 store
      fireBoxTime(inPointRef.current, true);
      // 松手写 store（拖拽中不写，避免中间态触发预览重 assemble 风暴）
      setSegmentInPoint(segmentIndex, inPointRef.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [applyInPoint, canTrim, pxPerSec, segmentIndex, setSegmentInPoint, onDragStart, fireBoxTime]);

  /* 选择框按下：从当前入点起拖 */
  const handleBoxPress = useCallback((e: React.PointerEvent) => startDrag(e), [startDrag]);

  /* 胶片条空白按下：选择框左缘跳到点击处对应时刻，并继续跟手拖动 */
  const handleStripPress = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLDivElement;
    const r = el.getBoundingClientRect();
    const t = (e.clientX - r.left) / pxPerSec;
    startDrag(e, t);
  }, [startDrag, pxPerSec]);

  /* 完成 / 取消 / ESC / Enter */
  const commit = useCallback(() => {
    setSegmentInPoint(segmentIndex, inPointRef.current);
    onClose();
  }, [segmentIndex, setSegmentInPoint, onClose]);
  const cancel = useCallback(() => {
    setSegmentInPoint(segmentIndex, origRef.current);
    onClose();
  }, [segmentIndex, setSegmentInPoint, onClose]);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); cancel(); }
      else if (ev.key === 'Enter') { ev.stopPropagation(); ev.preventDefault(); commit(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel, commit]);

  /* 卸载兜底：清理 RAF */
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  if (!seg) return null;

  /* 素材时长未知/不足：不允许进入的防御分支（入口在 FcpTimeline 已拦截，双保险） */
  if (srcDur <= 0) {
    return (
      <Box sx={{ mt: 0.5, p: 1, border: '1px solid', borderColor: 'warning.main', borderRadius: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="warning.main" sx={{ flex: 1 }}>素材时长未知，无法重选时段</Typography>
        <Button size="small" onClick={onClose}>关闭</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 0.5, p: 1, border: '1px solid', borderColor: 'primary.main', borderRadius: 1, bgcolor: 'background.paper' }}>
      {/* ── 头部：时间码 + 循环试听 + 操作按钮（大预览实时跟随，原小图预览已移除） ── */}
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.75 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ display: 'block', fontFamily: 'monospace' }}>
            入点 {inPoint.toFixed(1)}s / 素材 {srcDur.toFixed(1)}s · 槽长 {slotDur.toFixed(1)}s
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap title={seg.video_path} sx={{ display: 'block' }}>
            #{segmentIndex + 1} {baseName(seg.video_path)}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontSize: '0.6rem' }}>
            {canTrim ? '拖动选择框滑选入点 · 大预览实时跟随 · ▶ 循环试听 · Enter 完成 · ESC 取消' : '素材时长短于口播槽，无可调入点空间'}
          </Typography>
        </Box>
        <Tooltip title={auditioning ? '暂停循环试听' : '循环试听所选时段'}>
          <span>
            <IconButton
              size="small"
              onClick={onToggleAudition}
              disabled={!onToggleAudition}
              color={auditioning ? 'primary' : 'default'}
              sx={{ border: '1px solid', borderColor: auditioning ? 'primary.main' : 'divider' }}
            >
              {auditioning ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
            </IconButton>
          </span>
        </Tooltip>
        <Button size="small" variant="contained" onClick={commit}>完成</Button>
        <Button size="small" onClick={cancel}>取消</Button>
      </Box>

      {/* ── 整条素材胶片条 + 固定宽度选择框 ── */}
      <Box sx={{ overflowX: 'auto', overflowY: 'hidden', borderRadius: 0.5, border: '1px solid', borderColor: 'divider' }}>
        <Box
          onPointerDown={handleStripPress}
          sx={{ position: 'relative', width: stripW, height: CFG.trimStripHeight, userSelect: 'none', touchAction: 'none' }}
        >
          {/* 帧（分批增量加载） */}
          <Box sx={{ display: 'flex', width: '100%', height: '100%', pointerEvents: 'none' }}>
            {times.map((t, i) => (
              i < windowSize ? (
                <FrameCell
                  key={i}
                  src={thumbUrlSized(bu, seg.video_path, t, CFG.trimThumbWidth, aspect)}
                  width={frameW(i)}
                  height={CFG.trimStripHeight}
                  onSettled={handleFrameSettled}
                />
              ) : (
                <Box key={i} sx={{ width: frameW(i), height: '100%', flexShrink: 0, bgcolor: 'action.hover' }} />
              )
            ))}
          </Box>
          {/* 选择框外区域压暗 */}
          <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: boxX, bgcolor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
          <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: boxX + boxW, right: 0, bgcolor: 'rgba(0,0,0,0.55)', pointerEvents: 'none' }} />
          {/* 固定宽度选择框（transform 拖拽） */}
          <Box
            onPointerDown={handleBoxPress}
            sx={{
              position: 'absolute', top: 0, height: '100%', width: boxW,
              transform: `translateX(${boxX}px)`,
              border: '2px solid', borderColor: 'primary.main', borderRadius: 0.5,
              cursor: canTrim ? 'grab' : 'not-allowed', zIndex: 6, touchAction: 'none',
              willChange: 'transform', boxSizing: 'border-box',
              '&:active': { cursor: canTrim ? 'grabbing' : 'not-allowed' },
            }}
          >
            {/* 左右抓手条 */}
            <Box sx={{ position: 'absolute', left: 2, top: '50%', transform: 'translateY(-50%)', width: 4, height: 24, borderRadius: 2, bgcolor: 'common.white', opacity: 0.9, pointerEvents: 'none' }} />
            <Box sx={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', width: 4, height: 24, borderRadius: 2, bgcolor: 'common.white', opacity: 0.9, pointerEvents: 'none' }} />
          </Box>
        </Box>
      </Box>
    </Box>
  );
};

export default TrimEditor;
