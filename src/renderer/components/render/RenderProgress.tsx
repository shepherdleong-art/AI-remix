/**
 * RenderProgress component.
 *
 * Shows the current render job's detailed progress:
 * - Large progress bar with percentage
 * - Current processing step description
 * - Elapsed time and estimated remaining time
 * - Cancel button
 * - Completion summary (file size, output path, time)
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  LinearProgress,
  Paper,
  Button,
  Chip,
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import StorageIcon from '@mui/icons-material/Storage';

import { useRenderStore } from '@/renderer/store/render-store';
import type { RenderJob } from '@/renderer/types/renderer';
import { formatEta, formatOutputSize } from '@/renderer/types/renderer';

/**
 * Format elapsed time in seconds to "mm:ss" string.
 */
function formatElapsed(seconds: number): string {
  if (seconds < 0) return '00:00';
  const m: number = Math.floor(seconds / 60);
  const s: number = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Progress display for the currently rendering job.
 */
const RenderProgress: React.FC = () => {
  // Store
  const jobs = useRenderStore((s) => s.jobs);
  const isRendering = useRenderStore((s) => s.isRendering);
  const cancelRender = useRenderStore((s) => s.cancelRender);

  // Find the active job
  const activeJob: RenderJob | undefined = jobs.find(
    (j: RenderJob) => j.status === 'processing' || j.status === 'queued',
  );

  // Last completed job for summary
  const lastCompleted: RenderJob | undefined = jobs
    .filter((j: RenderJob) => j.status === 'completed')
    .sort(
      (a: RenderJob, b: RenderJob) =>
        new Date(b.completedAt || '').getTime() - new Date(a.completedAt || '').getTime(),
    )[0];

  // Elapsed time tracker
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (activeJob && activeJob.status === 'processing') {
      const startTime: number = activeJob.startedAt
        ? new Date(activeJob.startedAt).getTime()
        : Date.now();

      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds((Date.now() - startTime) / 1000);
      }, 1000);

      return () => {
        if (elapsedTimerRef.current) {
          clearInterval(elapsedTimerRef.current);
          elapsedTimerRef.current = null;
        }
      };
    } else {
      setElapsedSeconds(0);
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    }
  }, [activeJob?.id, activeJob?.status]);

  const handleCancel = useCallback((): void => {
    if (activeJob) {
      cancelRender(activeJob.id);
    }
  }, [activeJob, cancelRender]);

  // No active job and no recent completion
  if (!activeJob && !lastCompleted) {
    return (
      <Paper elevation={0} sx={{ p: 3, textAlign: 'center' }}>
        <AccessTimeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
        <Typography variant="body1" color="text.secondary" gutterBottom>
          暂无渲染任务
        </Typography>
        <Typography variant="caption" color="text.disabled">
          添加模板到队列后，渲染进度将在此显示
        </Typography>
      </Paper>
    );
  }

  // Show last completed job summary
  if (!activeJob && lastCompleted) {
    return (
      <Paper elevation={0} sx={{ p: 3, textAlign: 'center' }}>
        <CheckCircleIcon sx={{ fontSize: 48, color: 'success.main', mb: 1 }} />
        <Typography variant="h6" color="success.main" gutterBottom>
          渲染完成！
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          {lastCompleted.templateName}
        </Typography>
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, mt: 2 }}>
          <Chip
            icon={<AccessTimeIcon />}
            label={`完成于 ${lastCompleted.completedAt ? new Date(lastCompleted.completedAt).toLocaleTimeString() : '-'}`}
            size="small"
            variant="outlined"
          />
          <Chip
            icon={<StorageIcon />}
            label={lastCompleted.outputPath ? lastCompleted.outputPath.split(/[/\\]/).pop() : '未知文件'}
            size="small"
            variant="outlined"
          />
        </Box>
      </Paper>
    );
  }

  // Active job in progress
  if (!activeJob) return null;

  const showElapsed: boolean = activeJob.status === 'processing' && elapsedSeconds > 0;

  return (
    <Paper elevation={0} sx={{ p: 3 }}>
      <Typography variant="h6" fontWeight={600} gutterBottom>
        渲染进度
      </Typography>

      {/* Job name */}
      <Typography variant="body1" fontWeight={500} gutterBottom>
        {activeJob.templateName}
      </Typography>

      {/* Status chip */}
      <Chip
        label={activeJob.status === 'queued' ? '排队中...' : '正在渲染...'}
        color={activeJob.status === 'queued' ? 'info' : 'primary'}
        size="small"
        sx={{ mb: 2 }}
      />

      {/* Progress bar */}
      <Box sx={{ mb: 2 }}>
        <LinearProgress
          variant="determinate"
          value={activeJob.progress}
          sx={{
            height: 12,
            borderRadius: 6,
            backgroundColor: 'action.hover',
          }}
        />
        <Typography
          variant="h4"
          fontWeight={700}
          color="primary"
          sx={{ mt: 1, textAlign: 'center' }}
        >
          {Math.round(activeJob.progress)}%
        </Typography>
      </Box>

      {/* Current step */}
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, textAlign: 'center' }}>
        {activeJob.currentStep || '准备中...'}
      </Typography>

      {/* Time info */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 3, mb: 2 }}>
        {showElapsed && (
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              已用时间
            </Typography>
            <Typography variant="body2" fontWeight={500}>
              {formatElapsed(elapsedSeconds)}
            </Typography>
          </Box>
        )}
        {activeJob.estimatedRemaining > 0 && (
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">
              预计剩余
            </Typography>
            <Typography variant="body2" fontWeight={500}>
              {formatEta(activeJob.estimatedRemaining)}
            </Typography>
          </Box>
        )}
      </Box>

      {/* Cancel button */}
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
        <Button
          variant="outlined"
          color="error"
          startIcon={<CancelIcon />}
          onClick={handleCancel}
          size="small"
        >
          取消渲染
        </Button>
      </Box>

      {/* Error display */}
      {activeJob.status === 'failed' && activeJob.error && (
        <Box sx={{ mt: 2, p: 2, bgcolor: 'error.light', borderRadius: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
            <ErrorIcon fontSize="small" color="error" />
            <Typography variant="body2" fontWeight={600} color="error.dark">
              渲染失败
            </Typography>
          </Box>
          <Typography variant="caption" color="error.dark">
            {activeJob.error}
          </Typography>
        </Box>
      )}
    </Paper>
  );
};

export default RenderProgress;
