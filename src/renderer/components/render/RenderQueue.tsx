/**
 * RenderQueue component.
 *
 * Displays all render jobs in a collapsible list:
 * - Active/queued jobs with progress
 * - Completed jobs (collapsible)
 * - Failed/cancelled jobs
 * - Action buttons: cancel, retry, delete, view output
 */
import React, { useState, useCallback } from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  Chip,
  IconButton,
  Tooltip,
  LinearProgress,
  Collapse,
  Button,
  Paper,
} from '@mui/material';
import CancelIcon from '@mui/icons-material/Cancel';
import ReplayIcon from '@mui/icons-material/Replay';
import DeleteIcon from '@mui/icons-material/Delete';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import VisibilityIcon from '@mui/icons-material/Visibility';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import MovieIcon from '@mui/icons-material/Movie';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';

import { useRenderStore } from '@/renderer/store/render-store';
import type { RenderJob, RenderStatus } from '@/renderer/types/renderer';
import {
  RENDER_STATUS_LABELS,
  RENDER_STATUS_COLORS,
  formatEta,
} from '@/renderer/types/renderer';

/** Icon mapping by status */
const STATUS_ICONS: Record<RenderStatus, React.ReactNode> = {
  pending: <HourglassEmptyIcon fontSize="small" />,
  queued: <HourglassEmptyIcon fontSize="small" color="info" />,
  processing: <MovieIcon fontSize="small" color="primary" />,
  completed: <CheckCircleIcon fontSize="small" color="success" />,
  failed: <ErrorIcon fontSize="small" color="error" />,
  cancelled: <WarningIcon fontSize="small" color="warning" />,
};

interface RenderQueueProps {
  /** Callback when user wants to preview a completed job's output */
  onViewOutput?: (job: RenderJob) => void;
}

/**
 * Render queue panel showing all jobs.
 */
const RenderQueue: React.FC<RenderQueueProps> = ({ onViewOutput }) => {
  // Store
  const jobs = useRenderStore((s) => s.jobs);
  const selectedJobId = useRenderStore((s) => s.selectedJobId);
  const selectJob = useRenderStore((s) => s.selectJob);
  const cancelRender = useRenderStore((s) => s.cancelRender);
  const retryJob = useRenderStore((s) => s.retryJob);
  const removeJob = useRenderStore((s) => s.removeJob);

  // Local state
  const [showCompleted, setShowCompleted] = useState<boolean>(true);

  // Filter jobs
  const activeJobs: RenderJob[] = jobs.filter(
    (j: RenderJob) => j.status === 'pending' || j.status === 'queued' || j.status === 'processing',
  );
  const completedJobs: RenderJob[] = jobs.filter(
    (j: RenderJob) => j.status === 'completed',
  );
  const failedJobs: RenderJob[] = jobs.filter(
    (j: RenderJob) => j.status === 'failed' || j.status === 'cancelled',
  );

  const handleCancel = useCallback(
    (jobId: string): void => {
      cancelRender(jobId);
    },
    [cancelRender],
  );

  const handleRetry = useCallback(
    (jobId: string): void => {
      retryJob(jobId);
    },
    [retryJob],
  );

  const handleDelete = useCallback(
    (jobId: string): void => {
      removeJob(jobId);
    },
    [removeJob],
  );

  const handleSelect = useCallback(
    (jobId: string): void => {
      selectJob(jobId === selectedJobId ? null : jobId);
    },
    [selectJob, selectedJobId],
  );

  /**
   * Render a single job list item.
   */
  const renderJobItem = (job: RenderJob): React.ReactNode => {
    const isActive: boolean = job.status === 'processing' || job.status === 'queued';
    const isSelected: boolean = job.id === selectedJobId;
    const canCancel: boolean = job.status === 'pending' || job.status === 'queued' || job.status === 'processing';
    const canRetry: boolean = job.status === 'failed';
    const canDelete: boolean = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';

    return (
      <Paper
        key={job.id}
        elevation={isSelected ? 2 : 0}
        sx={{
          mb: 1,
          border: isSelected ? 2 : 1,
          borderColor: isSelected ? 'primary.main' : 'divider',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ p: 1.5 }}>
          {/* Header row */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
            <Box
              sx={{ display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', flex: 1 }}
              onClick={() => handleSelect(job.id)}
            >
              {STATUS_ICONS[job.status]}
              <Typography variant="body2" fontWeight={500} noWrap sx={{ maxWidth: 180 }}>
                {job.templateName}
              </Typography>
              <Chip
                label={RENDER_STATUS_LABELS[job.status]}
                color={RENDER_STATUS_COLORS[job.status]}
                size="small"
                sx={{ ml: 0.5 }}
              />
            </Box>

            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {canCancel && (
                <Tooltip title="取消渲染">
                  <IconButton size="small" onClick={() => handleCancel(job.id)}>
                    <CancelIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {canRetry && (
                <Tooltip title="重新渲染">
                  <IconButton size="small" onClick={() => handleRetry(job.id)}>
                    <ReplayIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {canDelete && (
                <Tooltip title="删除记录">
                  <IconButton size="small" onClick={() => handleDelete(job.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
              {job.status === 'completed' && job.outputPath && onViewOutput && (
                <Tooltip title="查看输出">
                  <IconButton size="small" color="primary" onClick={() => onViewOutput(job)}>
                    <VisibilityIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          </Box>

          {/* Progress bar for active jobs */}
          {isActive && (
            <Box sx={{ mt: 1 }}>
              <LinearProgress
                variant="determinate"
                value={job.progress}
                sx={{ height: 6, borderRadius: 3 }}
              />
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                <Typography variant="caption" color="text.secondary">
                  {job.currentStep || '准备中...'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {job.progress}%
                </Typography>
              </Box>
              {job.estimatedRemaining > 0 && (
                <Typography variant="caption" color="text.secondary">
                  预计剩余: {formatEta(job.estimatedRemaining)}
                </Typography>
              )}
            </Box>
          )}

          {/* Completed info */}
          {job.status === 'completed' && (
            <Box sx={{ mt: 0.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <PlayCircleIcon fontSize="small" color="success" />
              <Typography variant="caption" color="text.secondary">
                已完成 · {job.completedAt ? new Date(job.completedAt).toLocaleTimeString() : ''}
              </Typography>
              {job.outputPath && (
                <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 200 }}>
                  {job.outputPath.split(/[/\\]/).pop()}
                </Typography>
              )}
            </Box>
          )}

          {/* Error info */}
          {(job.status === 'failed' || job.status === 'cancelled') && job.error && (
            <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
              {job.error}
            </Typography>
          )}
        </Box>
      </Paper>
    );
  };

  // Empty state
  if (jobs.length === 0) {
    return (
      <Paper elevation={0} sx={{ p: 3, textAlign: 'center' }}>
        <MovieIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
        <Typography variant="body1" color="text.secondary" gutterBottom>
          渲染队列为空
        </Typography>
        <Typography variant="caption" color="text.disabled">
          配置渲染设置后，点击"开始渲染"即可添加任务
        </Typography>
      </Paper>
    );
  }

  return (
    <Box>
      <Typography variant="h6" fontWeight={600} gutterBottom>
        渲染队列
      </Typography>

      {/* Active jobs */}
      {activeJobs.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" color="primary" gutterBottom>
            进行中 ({activeJobs.length})
          </Typography>
          {activeJobs.map(renderJobItem)}
        </Box>
      )}

      {/* Failed jobs */}
      {failedJobs.length > 0 && (
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" color="error" gutterBottom>
            失败/已取消 ({failedJobs.length})
          </Typography>
          {failedJobs.map(renderJobItem)}
        </Box>
      )}

      {/* Completed jobs (collapsible) */}
      {completedJobs.length > 0 && (
        <Box>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              cursor: 'pointer',
              mb: 1,
            }}
            onClick={() => setShowCompleted(!showCompleted)}
          >
            <Typography variant="subtitle2" color="success.main">
              已完成 ({completedJobs.length})
            </Typography>
            <IconButton size="small">
              {showCompleted ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          </Box>
          <Collapse in={showCompleted}>
            {completedJobs.map(renderJobItem)}
          </Collapse>
        </Box>
      )}
    </Box>
  );
};

export default RenderQueue;
