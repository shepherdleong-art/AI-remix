/**
 * 批量模式 · 阶段 1.5：素材预修台（MaterialPrescan，O1）。
 *
 * - 进入自动跑 prescan：AI 黑帧/静默检测给出建议可用区间（轮询 prescan/status）
 * - 逐条卡片：内嵌视频 scrub + 双手柄区间滑块（独立轻量实现，非 TrimEditor）
 * - 键盘流：I 打入点 / O 打出点 / Enter 确认并跳下一条（80 条几分钟过完）
 * - 「全部采纳 AI 建议」一键确认；「整批跳过」把全部素材按全段可用确认
 * - 确认结果经 materials/update 写回（后端自动置 prescan_status=confirmed）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  LinearProgress,
  Paper,
  Slider,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import SkipNextIcon from '@mui/icons-material/SkipNext';

import { useBatchStore } from '@/renderer/store/batch-store';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import type { BatchMaterial } from '@/renderer/types/batch';
import { PRESCAN_STATUS_META, fmtSec, materialVideoUrl } from './utils';

const MIN_WINDOW = 0.3; // 可用窗口最小时长（秒），防止两手柄重合

/** 素材当前生效的区间值（本地未保存编辑优先，其次 AI 建议/已确认值） */
function effectiveRange(
  m: BatchMaterial,
  edits: Record<string, { in: number; out: number }>,
): { in: number; out: number } {
  const e = edits[m.file_hash];
  if (e) return e;
  const dur = m.duration || 0;
  return {
    in: Math.max(0, m.usable_in || 0),
    out: (m.usable_out || 0) > 0 ? (m.usable_out as number) : dur,
  };
}

interface MaterialPrescanProps {
  onNext: () => void;
  onBack: () => void;
}

const MaterialPrescan: React.FC<MaterialPrescanProps> = ({ onNext, onBack }) => {
  const bu = useBackendUrl();
  const batch = useBatchStore((s) => s.batch);
  const prescanProgress = useBatchStore((s) => s.prescanProgress);
  const startPrescan = useBatchStore((s) => s.startPrescan);
  const updateMaterialRange = useBatchStore((s) => s.updateMaterialRange);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);

  /** 本地未保存的区间编辑（hash → {in,out}） */
  const [edits, setEdits] = useState<Record<string, { in: number; out: number }>>({});
  /** 键盘作用的目标卡片 */
  const [activeHash, setActiveHash] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const videoRefs = useRef<Map<string, HTMLVideoElement>>(new Map());
  /** 是否已自动启动过预修（组件生命周期内只跑一次） */
  const autoStartedRef = useRef(false);

  const materials = useMemo(() => batch?.materials ?? [], [batch]);
  const usableMaterials = useMemo(() => materials.filter((m) => !m.missing), [materials]);
  const confirmedCount = useMemo(
    () => usableMaterials.filter((m) => m.prescan_status === 'confirmed').length,
    [usableMaterials],
  );
  const suggestibleCount = useMemo(
    () => usableMaterials.filter((m) => m.prescan_status === 'done').length,
    [usableMaterials],
  );
  const pendingCount = useMemo(
    () => usableMaterials.filter((m) => m.prescan_status === 'pending').length,
    [usableMaterials],
  );
  const running = !!prescanProgress?.running;

  /* 进入自动跑预修（O1：仅当还有 pending 素材且任务未在跑） */
  useEffect(() => {
    if (autoStartedRef.current) return;
    autoStartedRef.current = true;
    const hasPending = (batch?.materials ?? []).some(
      (m) => !m.missing && m.prescan_status === 'pending',
    );
    if (hasPending && !useBatchStore.getState().prescanProgress?.running) {
      void startPrescan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVideoRef = useCallback((hash: string, el: HTMLVideoElement | null) => {
    if (el) videoRefs.current.set(hash, el);
    else videoRefs.current.delete(hash);
  }, []);

  /** 更新本地编辑值（可选联动 seek 视频） */
  const applyEdit = useCallback((hash: string, next: { in: number; out: number }, seekTo?: number) => {
    setEdits((prev) => ({ ...prev, [hash]: next }));
    if (seekTo !== undefined) {
      const v = videoRefs.current.get(hash);
      if (v) v.currentTime = seekTo;
    }
  }, []);

  /** 确认单条（hash 为空时确认 activeHash 对应卡片）；返回是否成功 */
  const confirmOne = useCallback(async (hash: string): Promise<boolean> => {
    const m = useBatchStore.getState().batch?.materials.find((x) => x.file_hash === hash);
    if (!m) return false;
    const range = effectiveRange(m, edits);
    // 钳位：0 ≤ in < out ≤ duration（duration 未知时不钳上界）
    const dur = m.duration || 0;
    const inV = Math.max(0, range.in);
    let outV = Math.max(inV + MIN_WINDOW, range.out);
    if (dur > 0) outV = Math.min(dur, outV);
    const ok = await updateMaterialRange(hash, Math.round(inV * 100) / 100, Math.round(outV * 100) / 100);
    if (ok) {
      setEdits((prev) => {
        const next = { ...prev };
        delete next[hash];
        return next;
      });
    }
    return ok;
  }, [edits, updateMaterialRange]);

  /** Enter：确认当前条并跳到下一条未确认卡片 */
  const confirmAndNext = useCallback(async () => {
    if (!activeHash) return;
    const ok = await confirmOne(activeHash);
    if (!ok) return;
    const list = useBatchStore.getState().batch?.materials.filter((m) => !m.missing) ?? [];
    const idx = list.findIndex((m) => m.file_hash === activeHash);
    const next = list.slice(idx + 1).find((m) => m.prescan_status !== 'confirmed')
      ?? list.find((m) => m.prescan_status !== 'confirmed');
    if (next) {
      setActiveHash(next.file_hash);
      document.getElementById(`prescan-card-${next.file_hash}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [activeHash, confirmOne]);

  /** 全局键盘流：I 打入点 / O 打出点 / Enter 确认下一条 */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!activeHash) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const key = e.key.toLowerCase();
      const m = useBatchStore.getState().batch?.materials.find((x) => x.file_hash === activeHash);
      if (!m) return;
      if (key === 'i' || key === 'o') {
        const v = videoRefs.current.get(activeHash);
        if (!v) return;
        const cur = effectiveRange(m, edits);
        const t = Math.round(v.currentTime * 100) / 100;
        if (key === 'i') {
          const inV = Math.min(t, cur.out - MIN_WINDOW);
          applyEdit(activeHash, { in: Math.max(0, inV), out: cur.out });
        } else {
          const outV = Math.max(t, cur.in + MIN_WINDOW);
          applyEdit(activeHash, { in: cur.in, out: outV });
        }
        e.preventDefault();
      } else if (key === 'enter') {
        e.preventDefault();
        void confirmAndNext();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeHash, edits, applyEdit, confirmAndNext]);

  /** 全部采纳 AI 建议（prescan_status=done 的素材按建议值确认） */
  const acceptAllSuggestions = useCallback(async () => {
    setSaving(true);
    try {
      const list = useBatchStore.getState().batch?.materials ?? [];
      for (const m of list) {
        if (m.missing || m.prescan_status !== 'done') continue;
        const inV = Math.max(0, m.usable_in || 0);
        const outV = (m.usable_out || 0) > 0 ? (m.usable_out as number) : (m.duration || 0);
        if (outV <= inV) continue;
        await updateMaterialRange(m.file_hash, inV, outV);
      }
      setEdits({});
    } finally {
      setSaving(false);
    }
  }, [updateMaterialRange]);

  /** 整批跳过：全部素材按「全段可用」确认（AI 生成素材质量稳定场景） */
  const skipAll = useCallback(async () => {
    setSaving(true);
    try {
      const list = useBatchStore.getState().batch?.materials ?? [];
      for (const m of list) {
        if (m.missing || m.prescan_status === 'confirmed') continue;
        const dur = m.duration || 0;
        const inV = 0;
        const outV = dur > 0 ? dur : ((m.usable_out || 0) > 0 ? (m.usable_out as number) : 0);
        if (outV <= inV) continue; // 时长未知的留给人工
        await updateMaterialRange(m.file_hash, inV, outV);
      }
      setEdits({});
    } finally {
      setSaving(false);
    }
  }, [updateMaterialRange]);

  if (!batch) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* ── 顶部：进度 + 批量操作 ── */}
      <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2">素材预修（标可用区间，分配只在窗口内取段）</Typography>
          <Chip size="small" variant="outlined" color="success" label={`已确认 ${confirmedCount}/${usableMaterials.length}`} />
          {pendingCount > 0 && <Chip size="small" variant="outlined" label={`待检测 ${pendingCount}`} />}
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="outlined"
            startIcon={<AutoFixHighIcon />}
            disabled={saving || running || suggestibleCount === 0}
            onClick={() => { void acceptAllSuggestions(); }}
          >
            全部采纳 AI 建议（{suggestibleCount}）
          </Button>
          <Tooltip title="AI 生成素材质量稳定，可按全段可用整批确认">
            <span>
              <Button
                size="small"
                variant="outlined"
                startIcon={<SkipNextIcon />}
                disabled={saving || running || confirmedCount === usableMaterials.length}
                onClick={() => { void skipAll(); }}
              >
                整批跳过
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="对未确认素材重新跑黑帧/静默检测">
            <span>
              <IconButton size="small" onClick={() => { void startPrescan(); }} disabled={running || saving}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        {running && prescanProgress && (
          <Box sx={{ mt: 1.5 }}>
            <LinearProgress
              variant="determinate"
              value={prescanProgress.total > 0 ? Math.round((prescanProgress.done / prescanProgress.total) * 100) : 0}
              sx={{ borderRadius: 999, height: 6, '& .MuiLinearProgress-bar': { borderRadius: 999 } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              AI 检测中 {prescanProgress.done}/{prescanProgress.total}（可同时在下方手工标区间）
            </Typography>
          </Box>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          快捷键：点击卡片选中后，I = 在当前画面打入点，O = 打出点，Enter = 确认并跳下一条
        </Typography>
      </Paper>

      {storeError && <Alert severity="warning" onClose={() => setError(null)}>{storeError}</Alert>}
      {prescanProgress && !prescanProgress.running && prescanProgress.error && (
        <Alert severity="warning">{prescanProgress.error}</Alert>
      )}
      {usableMaterials.length === 0 && (
        <Alert severity="info">本批次还没有可用素材，请回上一步导入。</Alert>
      )}

      {/* ── 逐条预修卡片 ── */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
          gap: 2,
        }}
      >
        {usableMaterials.map((m) => (
          <PrescanCard
            key={m.file_hash}
            batchId={batch.id}
            material={m}
            baseUrl={bu}
            range={effectiveRange(m, edits)}
            dirty={!!edits[m.file_hash]}
            active={activeHash === m.file_hash}
            saving={saving}
            onActivate={() => setActiveHash(m.file_hash)}
            onRangeChange={(next, seekTo) => applyEdit(m.file_hash, next, seekTo)}
            onConfirm={() => { void confirmOne(m.file_hash); }}
            setVideoRef={setVideoRef}
          />
        ))}
      </Box>

      {/* ── 底部导航 ── */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button onClick={onBack}>上一步：素材上传</Button>
        <Button
          variant="contained"
          endIcon={<ArrowForwardIcon />}
          onClick={onNext}
          disabled={running}
        >
          下一步：脚本录入{confirmedCount < usableMaterials.length ? `（${usableMaterials.length - confirmedCount} 条未确认）` : ''}
        </Button>
      </Box>
    </Box>
  );
};

/* ── 单条预修卡片 ── */
interface PrescanCardProps {
  batchId: string;
  material: BatchMaterial;
  baseUrl: string;
  range: { in: number; out: number };
  dirty: boolean;
  active: boolean;
  saving: boolean;
  onActivate: () => void;
  onRangeChange: (next: { in: number; out: number }, seekTo?: number) => void;
  onConfirm: () => void;
  setVideoRef: (hash: string, el: HTMLVideoElement | null) => void;
}

const PrescanCard: React.FC<PrescanCardProps> = ({
  batchId, material: m, baseUrl, range, dirty, active, saving,
  onActivate, onRangeChange, onConfirm, setVideoRef,
}) => {
  const [playing, setPlaying] = useState(false);
  const duration = m.duration || 0;
  const meta = PRESCAN_STATUS_META[m.prescan_status] ?? PRESCAN_STATUS_META.pending;
  const confirmed = m.prescan_status === 'confirmed';
  const windowLen = Math.max(0, range.out - range.in);

  const handleSlider = (_e: Event, value: number | number[], activeThumb: number): void => {
    if (!Array.isArray(value)) return;
    let [a, b] = value as [number, number];
    if (b - a < MIN_WINDOW) {
      if (activeThumb === 0) a = b - MIN_WINDOW;
      else b = a + MIN_WINDOW;
    }
    a = Math.max(0, a);
    if (duration > 0) b = Math.min(duration, b);
    onRangeChange({ in: a, out: b }, activeThumb === 0 ? a : b);
  };

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>): void => {
    const v = e.currentTarget;
    if (playing && range.out > range.in && v.currentTime >= range.out - 0.05) {
      v.currentTime = range.in; // 窗口内循环
    }
  };

  return (
    <Paper
      id={`prescan-card-${m.file_hash}`}
      elevation={0}
      onClick={onActivate}
      sx={{
        p: 1.5,
        bgcolor: 'background.paperAlt',
        border: '1.5px solid',
        borderColor: active ? 'primary.main' : confirmed ? 'success.main' : 'divider',
        cursor: 'pointer',
        transition: 'border-color .15s',
      }}
    >
      {/* 头部 */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="body2" fontWeight={600} noWrap title={m.filename} sx={{ flex: 1, minWidth: 0 }}>
          {m.filename}
        </Typography>
        {dirty && <Chip size="small" color="warning" label="未保存" variant="outlined" />}
        <Chip size="small" color={meta.color} variant="outlined" label={meta.label} />
      </Box>

      {/* 视频 scrub 预览 */}
      <Box
        sx={{
          position: 'relative', bgcolor: '#000', borderRadius: 1, overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, mb: 1,
        }}
      >
        <video
          ref={(el) => setVideoRef(m.file_hash, el)}
          src={materialVideoUrl(baseUrl, batchId, m.file_hash)}
          preload="metadata"
          muted
          playsInline
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          style={{ maxWidth: '100%', maxHeight: '100%' }}
        />
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            const v = e.currentTarget.closest('div')?.querySelector('video');
            if (!v) return;
            if (v.paused) {
              if (range.out > range.in && (v.currentTime < range.in || v.currentTime >= range.out)) {
                v.currentTime = range.in;
              }
              void v.play();
            } else {
              v.pause();
            }
          }}
          sx={{
            position: 'absolute', left: 6, bottom: 6,
            bgcolor: 'rgba(0,0,0,0.55)', color: '#fff',
            '&:hover': { bgcolor: 'rgba(0,0,0,0.75)' },
          }}
        >
          {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
        </IconButton>
      </Box>

      {/* 可用区间双手柄滑块 */}
      <Box sx={{ px: 0.5 }} onClick={(e) => e.stopPropagation()}>
        <Slider
          size="small"
          value={[range.in, range.out]}
          min={0}
          max={duration > 0 ? duration : Math.max(range.out, 1)}
          step={0.1}
          disabled={duration <= 0}
          onChange={handleSlider}
          valueLabelDisplay="auto"
          valueLabelFormat={(v) => fmtSec(v)}
          disableSwap
        />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="caption" color="text.secondary">
            入 {fmtSec(range.in)} · 出 {fmtSec(range.out)} · 可用 <b>{fmtSec(windowLen)}</b>
            {duration > 0 ? ` / 总长 ${fmtSec(duration)}` : '（时长未知）'}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant={confirmed && !dirty ? 'outlined' : 'contained'}
            color={confirmed && !dirty ? 'success' : 'primary'}
            startIcon={<DoneAllIcon />}
            disabled={saving || duration <= 0}
            onClick={onConfirm}
          >
            {confirmed && !dirty ? '已确认' : '确认区间'}
          </Button>
        </Box>
      </Box>
    </Paper>
  );
};

export default MaterialPrescan;
