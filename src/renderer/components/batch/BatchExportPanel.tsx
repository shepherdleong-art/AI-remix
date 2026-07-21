/**
 * 批量阶段五 · 串行导出队列面板（BatchExportPanel，D14/O5）。
 *
 * - 顶部：输出目录说明 + 「打开文件夹」（走后端 open-output，资源管理器定位）
 * - 操作：导出已确认 / 导出全部 / 暂停·继续（队列暂停只在片间生效）
 * - 队列：逐条状态 Chip + 文件名预览（批次名_序号_标题.mp4，与后端 filename_safe 对齐）、
 *   渲染中不定进度条（队列只在完成时置 progress=1）、失败错误文本、
 *   待渲染/渲染中可取消、失败/已取消可重试
 * - 挂载时 pollExportOnce 恢复快照；exportSelected/retry 已自动起 1s 轮询
 * - 完成通知：all_done 由 false→true → Snackbar + 蜂鸣（Web Audio）+ 系统通知
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Snackbar,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ReplayIcon from '@mui/icons-material/Replay';

import { useBatchStore } from '@/renderer/store/batch-store';
import type { ExportJob } from '@/renderer/types/batch';
import { exportFileNamePreview } from './utils';

interface BatchExportPanelProps {
  /** 回阶段三（卡片队列） */
  onBack?: () => void;
}

const JOB_STATUS_META: Record<string, { label: string; color: 'default' | 'info' | 'success' | 'warning' | 'error' }> = {
  pending: { label: '排队中', color: 'default' },
  rendering: { label: '渲染中', color: 'info' },
  done: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'warning' },
  cancelling: { label: '取消中', color: 'warning' },
};

/** 完成蜂鸣：880Hz 短音 ×2（Web Audio，无外部资源） */
function beepTwice(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    [0, 0.35].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
      osc.start(t0);
      osc.stop(t0 + 0.3);
    });
    window.setTimeout(() => { void ctx.close(); }, 1200);
  } catch {
    /* 音频不可用时静默 */
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

const BatchExportPanel: React.FC<BatchExportPanelProps> = ({ onBack }) => {
  const batch = useBatchStore((s) => s.batch);
  const exportStatus = useBatchStore((s) => s.exportStatus);
  const exportSelected = useBatchStore((s) => s.exportSelected);
  const pollExportOnce = useBatchStore((s) => s.pollExportOnce);
  const pauseExport = useBatchStore((s) => s.pauseExport);
  const cancelExport = useBatchStore((s) => s.cancelExport);
  const retryExport = useBatchStore((s) => s.retryExport);
  const openOutputDir = useBatchStore((s) => s.openOutputDir);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);

  const [exporting, setExporting] = useState(false);
  const [openDirError, setOpenDirError] = useState('');
  const [snack, setSnack] = useState('');
  const prevAllDone = useRef<boolean | null>(null);

  /* 挂载恢复一次快照（队列进行中则由 store 轮询接管） */
  useEffect(() => {
    void pollExportOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clips = useMemo(() => batch?.clips ?? [], [batch]);
  const confirmedCount = clips.filter((c) => c.status === '已确认').length;
  const historyDone = clips.filter((c) => c.status === '已完成');

  const jobs = useMemo(() => exportStatus?.jobs ?? [], [exportStatus]);
  const queueActive = !!exportStatus && exportStatus.total > 0 && !exportStatus.all_done;
  const paused = exportStatus?.paused ?? false;

  /* all_done false→true：Snackbar + 蜂鸣 + 系统通知 */
  useEffect(() => {
    const cur = exportStatus && exportStatus.total > 0 ? exportStatus.all_done : null;
    if (cur === true && prevAllDone.current === false) {
      const okCount = exportStatus?.done_count ?? 0;
      const failCount = exportStatus?.failed_count ?? 0;
      const text =
        failCount > 0
          ? `导出队列结束：成功 ${okCount} 条，失败 ${failCount} 条`
          : `批量导出完成：${okCount} 条成片已就绪`;
      setSnack(text);
      beepTwice();
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          new Notification('批量导出', { body: text });
        } else if (Notification.permission === 'default') {
          void Notification.requestPermission();
        }
      }
    }
    if (cur !== null) prevAllDone.current = cur;
  }, [exportStatus]);

  const handleExport = useCallback(
    async (target: 'confirmed' | 'all') => {
      if (!batch) return;
      setExporting(true);
      try {
        if (target === 'confirmed') await exportSelected('confirmed');
        else await exportSelected(clips.map((c) => c.id));
      } finally {
        setExporting(false);
      }
    },
    [batch, clips, exportSelected],
  );

  const handleOpenDir = useCallback(async () => {
    setOpenDirError('');
    const err = await openOutputDir();
    if (err) setOpenDirError(err);
  }, [openOutputDir]);

  if (!batch) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* ── 输出目录 ── */}
      <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'background.paperAlt' }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
          <Box sx={{ flex: 1, minWidth: 220 }}>
            <Typography variant="body2" fontWeight={600}>
              输出目录
            </Typography>
            <Typography variant="caption" color="text.secondary">
              backend/data/output/ 下按「批次名_日期」分目录存放，文件名：批次名_序号_标题.mp4
            </Typography>
          </Box>
          <Button
            size="small"
            variant="outlined"
            startIcon={<FolderOpenIcon />}
            onClick={() => { void handleOpenDir(); }}
          >
            打开文件夹
          </Button>
        </Stack>
        {openDirError && (
          <Alert severity="warning" sx={{ mt: 1 }} onClose={() => setOpenDirError('')}>
            {openDirError}
          </Alert>
        )}
      </Paper>

      {/* ── 操作栏 ── */}
      <Paper
        elevation={0}
        sx={{
          p: 1.5, bgcolor: 'background.paperAlt',
          display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap',
        }}
      >
        <Button
          size="small"
          variant="contained"
          startIcon={<LocalShippingIcon />}
          disabled={exporting || confirmedCount === 0 || queueActive}
          onClick={() => { void handleExport('confirmed'); }}
        >
          导出已确认（{confirmedCount}）
        </Button>
        <Button
          size="small"
          variant="outlined"
          startIcon={<LocalShippingIcon />}
          disabled={exporting || clips.length === 0 || queueActive}
          onClick={() => { void handleExport('all'); }}
        >
          导出全部（{clips.length}）
        </Button>
        {exportStatus && exportStatus.total > 0 && (
          <Tooltip title={paused ? '继续渲染队列' : '暂停（当前片渲染完成后停）'}>
            <Button
              size="small"
              variant="outlined"
              color={paused ? 'success' : 'warning'}
              startIcon={paused ? <PlayArrowIcon /> : <PauseIcon />}
              disabled={exportStatus.all_done}
              onClick={() => { void pauseExport(!paused); }}
            >
              {paused ? '继续' : '暂停'}
            </Button>
          </Tooltip>
        )}
        <Box sx={{ flex: 1 }} />
        {exportStatus && exportStatus.total > 0 && (
          <Typography variant="caption" color="text.secondary">
            队列 {exportStatus.done_count}/{exportStatus.total}
            {exportStatus.failed_count > 0 ? ` · 失败 ${exportStatus.failed_count}` : ''}
            {paused ? ' · 已暂停' : ''}
          </Typography>
        )}
        {onBack && (
          <Button size="small" onClick={onBack}>
            返回审改
          </Button>
        )}
      </Paper>

      {storeError && (
        <Alert severity="warning" onClose={() => setError(null)}>
          {storeError}
        </Alert>
      )}

      {/* ── 导出队列 ── */}
      {jobs.length > 0 ? (
        <Stack spacing={1}>
          {jobs.map((job) => (
            <ExportJobRow
              key={job.clip_id}
              job={job}
              batchName={batch.name}
              onCancel={() => { void cancelExport(job.clip_id); }}
              onRetry={() => { void retryExport(job.clip_id); }}
            />
          ))}
        </Stack>
      ) : (
        <Paper elevation={0} sx={{ p: 3, bgcolor: 'background.paperAlt', textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            导出队列为空。点击上方「导出已确认」或「导出全部」开始串行渲染。
          </Typography>
          {historyDone.length > 0 && (
            <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 1 }}>
              历史已完成 {historyDone.length} 条：
              {historyDone
                .map((c) => (c.output_path ? baseName(c.output_path) : c.id))
                .join('、')}
            </Typography>
          )}
        </Paper>
      )}

      <Snackbar
        open={!!snack}
        autoHideDuration={6000}
        onClose={() => setSnack('')}
        message={snack}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
};

/* ── 单条队列任务行 ── */
interface ExportJobRowProps {
  job: ExportJob;
  batchName: string;
  onCancel: () => void;
  onRetry: () => void;
}

const ExportJobRow: React.FC<ExportJobRowProps> = ({ job, batchName, onCancel, onRetry }) => {
  const meta = JOB_STATUS_META[job.status] ?? JOB_STATUS_META.pending;
  const fileName =
    job.status === 'done' && job.output_path
      ? baseName(job.output_path)
      : exportFileNamePreview(batchName, job.seq, job.title || `成片${job.seq}`);
  const cancellable = job.status === 'pending' || job.status === 'rendering';
  const retryable = job.status === 'failed' || job.status === 'cancelled';

  return (
    <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'background.paperAlt' }}>
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Chip size="small" color={meta.color} label={meta.label} sx={{ flexShrink: 0 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap title={fileName}>
            {fileName}
          </Typography>
          {job.status === 'failed' && job.error && (
            <Typography variant="caption" color="error.main" noWrap title={job.error}>
              {job.error}
            </Typography>
          )}
        </Box>
        {cancellable && (
          <Button
            size="small"
            color="error"
            variant="text"
            startIcon={<CancelIcon />}
            onClick={onCancel}
          >
            取消
          </Button>
        )}
        {retryable && (
          <Button
            size="small"
            color="primary"
            variant="outlined"
            startIcon={<ReplayIcon />}
            onClick={onRetry}
          >
            重试
          </Button>
        )}
      </Stack>
      {job.status === 'rendering' && (
        <LinearProgress variant="indeterminate" sx={{ mt: 1, borderRadius: 1 }} />
      )}
      {job.status === 'done' && (
        <LinearProgress variant="determinate" value={100} color="success" sx={{ mt: 1, borderRadius: 1 }} />
      )}
    </Paper>
  );
};

export default BatchExportPanel;
