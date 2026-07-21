/**
 * 批量模式 · 阶段一：素材上传与分析（BatchUpload）。
 *
 * - 拖拽/多选上传 8-80 条（复用现有上传通道：Electron 直选路径 /
 *   浏览器模式经 /api/materials/upload 落盘后登记）
 * - 上传完成自动 materials/add 登记（快哈希去重）→ 自动 analyze 并发分析
 * - 列表显示缩略图/时长/大小/分析状态；命中缓存标注「已缓存」；失败可单独重试
 * - 顶部总进度条轮询 analyze/status（1s，任务结束自动停，见 batch-store）
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
  LinearProgress,
  Paper,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
  alpha,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ErrorIcon from '@mui/icons-material/Error';
import MovieIcon from '@mui/icons-material/Movie';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import StopIcon from '@mui/icons-material/Stop';

import MaterialImportDialog from '@/renderer/components/materials/MaterialImportDialog';
import { useBatchStore } from '@/renderer/store/batch-store';
import { useEditingStore } from '@/renderer/store/editing-store';
import { getBackendBaseUrl } from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { isVideoExtension, formatFileSize, formatDuration } from '@/renderer/types/material';
import type { BatchMaterial } from '@/renderer/types/batch';
import { ANALYSIS_STATUS_META, materialThumbUrl } from './utils';

const MIN_MATERIALS = 8;
const MAX_MATERIALS = 80;

/** 取文件名（兼容两种路径分隔符） */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

interface BatchUploadProps {
  /** 进入下一阶段（素材预修） */
  onNext: () => void;
}

const BatchUpload: React.FC<BatchUploadProps> = ({ onNext }) => {
  const bu = useBackendUrl();
  const batch = useBatchStore((s) => s.batch);
  const analyzeProgress = useBatchStore((s) => s.analyzeProgress);
  const registerMaterials = useBatchStore((s) => s.registerMaterials);
  const startAnalyze = useBatchStore((s) => s.startAnalyze);
  const pauseAnalyze = useBatchStore((s) => s.pauseAnalyze);
  const resumeAnalyze = useBatchStore((s) => s.resumeAnalyze);
  const stopAnalyze = useBatchStore((s) => s.stopAnalyze);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);
  const analysisApiKey = useEditingStore((s) => s.analysisApiKey);
  const analysisKeyUseGlobal = useBatchStore((s) => s.analysisKeyUseGlobal);
  const analysisKeyOverride = useBatchStore((s) => s.analysisKeyOverride);
  const setAnalysisKeyUseGlobal = useBatchStore((s) => s.setAnalysisKeyUseGlobal);
  const setAnalysisKeyOverride = useBatchStore((s) => s.setAnalysisKeyOverride);
  const analysisConcurrency = useBatchStore((s) => s.analysisConcurrency);
  const setAnalysisConcurrency = useBatchStore((s) => s.setAnalysisConcurrency);
  const effectiveAnalysisKey = analysisKeyUseGlobal ? analysisApiKey : analysisKeyOverride;

  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [skippedNotes, setSkippedNotes] = useState<string[]>([]);
  const dragCounterRef = useRef(0);
  /** 勾选集合（默认全选；上传即自动加入，不自动开始分析，由用户点「开始分析」触发） */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** 停止二次确认气泡 */
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);

  const materials = useMemo(() => batch?.materials ?? [], [batch]);
  const analyzing = !!analyzeProgress?.running;

  // 新登记素材自动进入勾选集合（默认全选），删除素材自动移出
  useEffect(() => {
    setSelected((prev) => {
      const prevArr = prev as Set<string>;
      const next = new Set(prevArr);
      let changed = false;
      for (const m of materials) {
        if (!next.has(m.file_hash)) { next.add(m.file_hash); changed = true; }
      }
      const ids = new Set(materials.map((m) => m.file_hash));
      for (const h of prevArr) {
        if (!ids.has(h)) { next.delete(h); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [materials]);

  const stats = useMemo(() => {
    const by = { done: 0, cached: 0, analyzing: 0, pending: 0, failed: 0 };
    for (const m of materials) {
      const k = m.analysis_status as keyof typeof by;
      if (k in by) by[k] += 1;
    }
    return by;
  }, [materials]);

  const allAnalyzed = materials.length > 0 && stats.pending === 0 && stats.analyzing === 0;

  // 分析控制状态机（播放器式：开始/暂停/继续 合并为一个切换键 + 停止二次确认）
  const analyzeState = analyzeProgress?.state ?? 'idle';
  const isActive = !!analyzeProgress?.running
    && (analyzeState === 'running' || analyzeState === 'paused' || analyzeState === 'stopping');
  const selectedPendingHashes = useMemo(
    () => materials
      .filter((m) => selected.has(m.file_hash)
        && (m.analysis_status === 'pending' || m.analysis_status === 'failed'))
      .map((m) => m.file_hash),
    [materials, selected],
  );
  const readyToStart = effectiveAnalysisKey.trim() !== '' && selectedPendingHashes.length > 0;
  const allChecked = materials.length > 0 && materials.every((m) => selected.has(m.file_hash));
  const toggleSelectAll = useCallback(() => {
    setSelected(allChecked ? new Set() : new Set(materials.map((m) => m.file_hash)));
  }, [allChecked, materials]);
  const toggleOne = useCallback((h: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h); else next.add(h);
      return next;
    });
  }, []);

  // F9-lite：空格键切换 开始/暂停/继续（播放器式交互习惯）；输入控件聚焦时不拦截，避免误触
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      if (analyzeState === 'running') void pauseAnalyze();
      else if (analyzeState === 'paused') void resumeAnalyze();
      else if (readyToStart) void startAnalyze(selectedPendingHashes);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [analyzeState, readyToStart, selectedPendingHashes, pauseAnalyze, resumeAnalyze, startAnalyze]);

  /** 登记素材（O4 去重提示）；不再自动分析，由用户点「开始分析」触发（播放器式交互）。
   *  F2：素材多时按每批 10 条分块登记，块间推进确定进度条 X/N（纯前端，无需改后端接口）。 */
  const ingestPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    setImporting(true);
    setSkippedNotes([]);
    setImportProgress({ done: 0, total: paths.length });
    const CHUNK = 10;
    const allSkipped: { path: string; reason: string }[] = [];
    let addedCount = 0;
    try {
      for (let i = 0; i < paths.length; i += CHUNK) {
        const chunk = paths.slice(i, i + CHUNK);
        const result = await registerMaterials(chunk);
        if (!result) continue;
        allSkipped.push(...result.skipped);
        addedCount += result.added.length;
        setImportProgress({ done: Math.min(i + CHUNK, paths.length), total: paths.length });
      }
      if (allSkipped.length > 0) {
        setSkippedNotes(allSkipped.map((s) => `${baseName(s.path)}：${s.reason}`));
      }
      if (addedCount > 0 && !effectiveAnalysisKey.trim()) {
        setError('素材已登记。未配置「画面分析」API Key，请配置后点击「开始分析」。');
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [registerMaterials, effectiveAnalysisKey, setError]);

  /** 对话框导入（复用单条流程同一上传通道） */
  const handleDialogImport = useCallback((paths: string[]) => {
    setImportOpen(false);
    void ingestPaths(paths);
  }, [ingestPaths]);

  /** 页面级拖拽导入：Electron 直取 file.path；浏览器模式先走 /api/materials/upload */
  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    dragCounterRef.current = 0;
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    const videos: Array<File & { path?: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as File & { path?: string };
      const ext = f.name.includes('.') ? `.${f.name.split('.').pop()?.toLowerCase()}` : '';
      if (isVideoExtension(ext)) videos.push(f);
    }
    if (videos.length === 0) {
      setError('拖入的文件中没有支持的视频格式');
      return;
    }

    const direct = videos.filter((f) => !!f.path).map((f) => f.path as string);
    const needUpload = videos.filter((f) => !f.path);
    const paths = [...direct];

    if (needUpload.length > 0) {
      setImporting(true);
      try {
        const baseUrl = await getBackendBaseUrl();
        for (const f of needUpload) {
          const fd = new FormData();
          fd.append('file', f, f.name);
          const resp = await fetch(`${baseUrl}/api/materials/upload`, { method: 'POST', body: fd });
          const d = await resp.json();
          if (d.code === 0 && d.data?.file_path) paths.push(d.data.file_path);
          else setSkippedNotes((prev) => [...prev, `${f.name}：上传失败（${d.message || '未知错误'}）`]);
        }
      } finally {
        setImporting(false);
      }
    }
    void ingestPaths(paths);
  }, [ingestPaths, setError]);

  if (!batch) return null;

  return (
    <Box
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current += 1;
        if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragOver(false); }
      }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { void handleDrop(e); }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 2, position: 'relative' }}
    >
      {/* ── 拖拽覆盖层 ── */}
      {isDragOver && (
        <Box
          sx={{
            position: 'absolute', inset: 0, zIndex: 1000,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
            border: '3px dashed', borderColor: 'primary.main', borderRadius: 2,
            pointerEvents: 'none',
          }}
        >
          <CloudUploadIcon sx={{ fontSize: 56, color: 'primary.main', mb: 1 }} />
          <Typography variant="h6" color="primary.main" fontWeight="bold">释放以加入批次</Typography>
        </Box>
      )}

      {/* ── 上传区 ── */}
      <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setImportOpen(true)}
            disabled={importing}
          >
            导入素材
          </Button>
          <Typography variant="body2" color="text.secondary">
            或直接拖拽视频到本页面（支持多选，同文件按哈希自动去重）
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Chip
            label={`已登记 ${materials.length} 条（建议 ${MIN_MATERIALS}-${MAX_MATERIALS} 条）`}
            size="small"
            variant="outlined"
            color={
              materials.length === 0 ? 'default'
                : materials.length < MIN_MATERIALS || materials.length > MAX_MATERIALS ? 'warning' : 'success'
            }
          />
          {importing && !importProgress && <CircularProgress size={18} />}
          {importProgress && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flex: 1, minWidth: 160 }}>
              <LinearProgress
                variant="determinate"
                value={Math.round((importProgress.done / importProgress.total) * 100)}
                sx={{ flex: 1, borderRadius: 999, height: 6, '& .MuiLinearProgress-bar': { borderRadius: 999 } }}
              />
              <Typography variant="caption" color="text.secondary" noWrap>
                导入中 {importProgress.done}/{importProgress.total}
              </Typography>
            </Box>
          )}
        </Box>
      </Paper>

      {/* ── 分析并发数（② 提速） ── */}
      <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>分析并发数</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 1 }}>
          <Slider
            size="small"
            min={2}
            max={20}
            step={1}
            value={analysisConcurrency}
            onChange={(_, v) => setAnalysisConcurrency(v as number)}
            sx={{ flex: 1 }}
          />
          <Typography variant="body2" sx={{ minWidth: 52, textAlign: 'right' }}>
            {analysisConcurrency} 路
          </Typography>
        </Box>
        <Typography variant="caption" color="text.secondary">
          远程视觉分析为网络等待型，可调高以加速；本地抽帧已自动限流（CPU 核数−2 且单核），不会占满 CPU。
        </Typography>
      </Paper>

      {/* ── 画面分析 API Key（批量可覆盖全局） ── */}
      <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="subtitle2">画面分析 API Key</Typography>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={analysisKeyUseGlobal}
                onChange={(e) => setAnalysisKeyUseGlobal(e.target.checked)}
              />
            }
            label={analysisKeyUseGlobal ? '使用全局密钥' : '自定义覆盖'}
          />
        </Box>
        <TextField
          fullWidth
          size="small"
          type="password"
          placeholder={analysisKeyUseGlobal ? '（使用全局「设置」中的画面分析密钥）' : '粘贴批量专用的画面分析 API Key'}
          value={analysisKeyUseGlobal ? (analysisApiKey || '') : analysisKeyOverride}
          disabled={analysisKeyUseGlobal}
          onChange={(e) => setAnalysisKeyOverride(e.target.value)}
        />
        <Typography variant="caption" color="text.secondary">
          默认复用单条模式的「画面分析」密钥；关闭开关可在此填入批量专用密钥（不影响单条模式）。
        </Typography>
      </Paper>

      {/* ── 跳过去重提示 ── */}
      {skippedNotes.length > 0 && (
        <Alert severity="info" onClose={() => setSkippedNotes([])}>
          {skippedNotes.slice(0, 5).map((s) => <div key={s}>{s}</div>)}
          {skippedNotes.length > 5 && <div>…共 {skippedNotes.length} 条被跳过</div>}
        </Alert>
      )}
      {storeError && <Alert severity="warning" onClose={() => setError(null)}>{storeError}</Alert>}

      {/* ── 分析控制（播放器式 开始/暂停/继续 + 停止） ── */}
      {materials.length > 0 && (
        <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
            <Typography variant="subtitle2">画面分析</Typography>
            {isActive && analyzeProgress && (
              <Chip
                size="small"
                label={analyzeState === 'paused' ? '已暂停' : analyzeState === 'stopping' ? '停止中' : '分析中'}
                color={analyzeState === 'paused' ? 'warning' : 'info'}
                variant="outlined"
              />
            )}
            <Box sx={{ flex: 1 }} />
            {!isActive && (
              <Button size="small" onClick={toggleSelectAll} disabled={materials.length === 0}>
                {allChecked ? '全不选' : '全选'}
              </Button>
            )}
          </Box>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
            {/* 切换键：idle→开始 / running→暂停 / paused→继续 */}
            <Button
              variant="contained"
              startIcon={analyzeState === 'running' ? <PauseIcon /> : <PlayArrowIcon />}
              disabled={analyzeState === 'idle' ? !readyToStart : analyzeState === 'stopping'}
              onClick={() => {
                if (analyzeState === 'running') void pauseAnalyze();
                else if (analyzeState === 'paused') void resumeAnalyze();
                else void startAnalyze(selectedPendingHashes);
              }}
            >
              {analyzeState === 'running'
                ? '暂停'
                : analyzeState === 'paused'
                  ? `继续（${selectedPendingHashes.length}）`
                  : `开始分析（${selectedPendingHashes.length}）`}
            </Button>

            {/* 停止（软放弃）：仅运行中/暂停时可用，带二次确认 */}
            {isActive && analyzeState !== 'stopping' && (
              <Button
                variant="outlined"
                color="error"
                startIcon={<StopIcon />}
                onClick={() => setStopConfirmOpen(true)}
              >
                停止
              </Button>
            )}
            {!readyToStart && analyzeState === 'idle' && (
              <Typography variant="caption" color="text.secondary">
                {effectiveAnalysisKey.trim()
                  ? `勾选至少一条待分析素材（已选 ${selectedPendingHashes.length} 条）`
                  : '未配置画面分析 API Key，无法开始'}
              </Typography>
            )}
          </Box>

          {/* 停止二次确认气泡 */}
          {stopConfirmOpen && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              <Typography variant="body2">
                停止分析？进行中的任务会跑完，剩余 {selectedPendingHashes.length} 条标回「待分析」，不保留进度，可重跑。
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
                <Button size="small" onClick={() => setStopConfirmOpen(false)}>取消</Button>
                <Button
                  size="small"
                  color="error"
                  variant="contained"
                  onClick={() => { setStopConfirmOpen(false); void stopAnalyze(); }}
                >确认停止</Button>
              </Box>
            </Alert>
          )}

          <LinearProgress
            variant="determinate"
            value={
              analyzeProgress && analyzeProgress.total > 0
                ? Math.round((analyzeProgress.done / analyzeProgress.total) * 100)
                : allAnalyzed ? 100 : 0
            }
            sx={{ borderRadius: 999, height: 6, '& .MuiLinearProgress-bar': { borderRadius: 999 } }}
          />
          <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            <Chip size="small" label={`已完成 ${stats.done}`} color="success" variant="outlined" />
            {stats.cached > 0 && <Chip size="small" label={`已缓存 ${stats.cached}`} color="warning" variant="outlined" />}
            {stats.analyzing > 0 && <Chip size="small" label={`分析中 ${stats.analyzing}`} color="info" variant="outlined" />}
            {stats.pending > 0 && <Chip size="small" label={`待分析 ${stats.pending}`} variant="outlined" />}
            {stats.failed > 0 && <Chip size="small" label={`失败 ${stats.failed}`} color="error" variant="outlined" />}
            {isActive && analyzeProgress && (
              <Typography variant="caption" color="text.secondary" noWrap>
                {analyzeProgress.done}/{analyzeProgress.total}
                {analyzeProgress.current ? ` · ${baseName(analyzeProgress.current)}` : ''}
                {analyzeState === 'paused' ? ' · 已暂停（进行中任务完成后停止派发）' : ''}
              </Typography>
            )}
          </Box>
          {analyzeProgress && !analyzeProgress.running && analyzeProgress.error && (
            <Alert severity="warning" sx={{ mt: 1 }}>{analyzeProgress.error}</Alert>
          )}
        </Paper>
      )}

      {/* ── 素材列表 ── */}
      {materials.length === 0 ? (
        <Paper
          elevation={0}
          sx={{
            p: 6, bgcolor: 'background.paperAlt', textAlign: 'center',
            border: '2px dashed', borderColor: 'divider', cursor: 'pointer',
          }}
          onClick={() => setImportOpen(true)}
        >
          <CloudUploadIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
          <Typography variant="body1" gutterBottom>还没有素材</Typography>
          <Typography variant="body2" color="text.secondary">
            点击此处或「导入素材」选择 {MIN_MATERIALS}-{MAX_MATERIALS} 条短视频（单条建议 ≤10s）
          </Typography>
        </Paper>
      ) : (
        <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'background.paperAlt' }}>
          {materials.map((m) => (
            <MaterialRow
              key={m.file_hash}
              batchId={batch.id}
              material={m}
              baseUrl={bu}
              checked={selected.has(m.file_hash)}
              selectable={m.analysis_status === 'pending' || m.analysis_status === 'failed'}
              onToggle={() => toggleOne(m.file_hash)}
              onRetry={m.analysis_status === 'failed' && !analyzing ? () => void startAnalyze([m.file_hash]) : undefined}
            />
          ))}
        </Paper>
      )}

      {/* ── 下一步 ── */}
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          endIcon={<ArrowForwardIcon />}
          onClick={onNext}
          disabled={materials.length === 0}
        >
          下一步：素材预修
        </Button>
      </Box>

      <MaterialImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={handleDialogImport}
      />
    </Box>
  );
};

/* ── 单条素材行 ── */
const MaterialRow: React.FC<{
  batchId: string;
  material: BatchMaterial;
  baseUrl: string;
  checked: boolean;
  selectable: boolean;
  onToggle: () => void;
  onRetry?: () => void;
}> = ({ batchId, material: m, baseUrl, checked, selectable, onToggle, onRetry }) => {
  const [thumbOk, setThumbOk] = useState(true);
  const meta = ANALYSIS_STATUS_META[m.analysis_status] ?? ANALYSIS_STATUS_META.pending;

  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, p: 1, mb: 0.5,
        borderRadius: 1.5, bgcolor: 'background.paper',
        border: '1px solid', borderColor: m.analysis_status === 'failed' ? 'error.main' : 'divider',
      }}
    >
      {/* 勾选框（仅 pending/failed 可勾选，决定「开始分析」范围） */}
      <Checkbox
        size="small"
        checked={checked}
        disabled={!selectable}
        onChange={onToggle}
        sx={{ p: 0.25, flexShrink: 0 }}
      />

      {/* 缩略图 */}
      <Box
        sx={{
          width: 56, height: 72, flexShrink: 0, borderRadius: 1, overflow: 'hidden',
          bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {thumbOk && !m.missing ? (
          <img
            src={materialThumbUrl(baseUrl, batchId, m.file_hash, Math.min(0.5, (m.duration || 1) / 2))}
            alt=""
            loading="lazy"
            onError={() => setThumbOk(false)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <MovieIcon color="disabled" />
        )}
      </Box>

      {/* 信息 */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} noWrap title={m.filename}>
          {m.filename}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {formatFileSize(m.size)}
          {m.duration > 0 ? ` · ${formatDuration(m.duration)}` : ' · 时长待分析'}
          {m.missing ? ' · 文件缺失' : ''}
        </Typography>
        {m.analysis_status === 'failed' && m.analysis_error && (
          <Typography variant="caption" color="error.main" display="block" noWrap title={m.analysis_error}>
            {m.analysis_error}
          </Typography>
        )}
      </Box>

      {/* 状态 */}
      <Chip
        size="small"
        color={meta.color}
        variant={m.analysis_status === 'cached' ? 'filled' : 'outlined'}
        icon={
          m.analysis_status === 'done' || m.analysis_status === 'cached'
            ? <CheckCircleIcon />
            : m.analysis_status === 'failed' ? <ErrorIcon /> : undefined
        }
        label={meta.label}
      />
      {m.analysis_status === 'cached' && (
        <Tooltip title="命中分析缓存，秒过">
          <Typography variant="caption" color="warning.main">已缓存</Typography>
        </Tooltip>
      )}
      {onRetry && (
        <Tooltip title="重试分析">
          <IconButton size="small" color="error" onClick={onRetry}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
};

export default BatchUpload;
