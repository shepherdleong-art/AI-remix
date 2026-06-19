/**
 * VideoPreviewDialog component.
 *
 * Full-screen dialog for previewing completed render output:
 * - HTML5 video player with controls
 * - Fullscreen toggle
 * - "Show in file manager" button
 * - Re-export button (creates new job with same config)
 * - Output file info display
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  IconButton,
  Typography,
  Box,
  Chip,
  Tooltip,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FullscreenIcon from '@mui/icons-material/Fullscreen';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import ReplayIcon from '@mui/icons-material/Replay';
import StorageIcon from '@mui/icons-material/Storage';

import { useRenderStore } from '@/renderer/store/render-store';
import type { RenderJob } from '@/renderer/types/renderer';
import { formatOutputSize } from '@/renderer/types/renderer';

interface VideoPreviewDialogProps {
  /** The render job to preview */
  job: RenderJob | null;
  /** Whether the dialog is open */
  open: boolean;
  /** Called when the dialog should close */
  onClose: () => void;
}

/**
 * Full-screen video preview dialog for completed renders.
 */
const VideoPreviewDialog: React.FC<VideoPreviewDialogProps> = ({
  job,
  open,
  onClose,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const addJob = useRenderStore((s) => s.addJob);
  const startRender = useRenderStore((s) => s.startRender);

  const handleFullscreen = useCallback((): void => {
    if (videoRef.current) {
      if (videoRef.current.requestFullscreen) {
        videoRef.current.requestFullscreen();
      }
    }
  }, []);

  const handleOpenFolder = useCallback((): void => {
    if (job?.outputPath && (window as unknown as Record<string, unknown>).electronAPI) {
      const api = (window as unknown as Record<string, unknown>).electronAPI as {
        showItemInFolder?: (path: string) => void;
      };
      if (api.showItemInFolder) {
        api.showItemInFolder(job.outputPath);
      }
    }
    // Fallback: cannot open folder from browser
  }, [job]);

  const handleReExport = useCallback((): void => {
    if (!job) return;
    const newJobId: string = addJob(
      job.templateId,
      `${job.templateName} (重新导出)`,
      job.config,
    );
    startRender(newJobId);
    onClose();
  }, [job, addJob, startRender, onClose]);

  if (!job) return null;

  // Build the video source URL
  // In development, use the backend URL
  const videoUrl: string = job.outputPath
    ? `http://127.0.0.1:18000/api/render/output/${job.id}`
    : '';

  const fileSizeStr: string = job.outputPath ? formatOutputSize(0) : '未知';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="lg"
      fullWidth
      PaperProps={{
        sx: {
          bgcolor: '#000',
          backgroundImage: 'none',
        },
      }}
    >
      <DialogTitle
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          color: 'white',
          bgcolor: 'rgba(0,0,0,0.85)',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="h6" component="span">
            {job.templateName}
          </Typography>
          <Chip
            label={`${job.resolution} · ${job.fps}fps · ${job.outputFormat.toUpperCase()}`}
            size="small"
            sx={{ color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}
            variant="outlined"
          />
        </Box>
        <IconButton onClick={onClose} sx={{ color: 'white' }}>
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent sx={{ p: 0, display: 'flex', justifyContent: 'center', bgcolor: '#111' }}>
        {videoUrl ? (
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            autoPlay
            style={{
              maxWidth: '100%',
              maxHeight: '70vh',
              objectFit: 'contain',
            }}
          >
            您的浏览器不支持视频播放
          </video>
        ) : (
          <Box sx={{ py: 10, textAlign: 'center', color: 'white' }}>
            <StorageIcon sx={{ fontSize: 64, opacity: 0.3, mb: 2 }} />
            <Typography variant="body1" sx={{ opacity: 0.5 }}>
              视频文件不可用
            </Typography>
          </Box>
        )}
      </DialogContent>

      <DialogActions
        sx={{
          justifyContent: 'space-between',
          bgcolor: 'rgba(0,0,0,0.85)',
          px: 3,
          py: 1.5,
        }}
      >
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="在文件管理器中显示">
            <Button
              size="small"
              startIcon={<FolderOpenIcon />}
              onClick={handleOpenFolder}
              sx={{ color: 'white' }}
            >
              打开文件夹
            </Button>
          </Tooltip>
          <Tooltip title="全屏播放">
            <IconButton size="small" onClick={handleFullscreen} sx={{ color: 'white' }}>
              <FullscreenIcon />
            </IconButton>
          </Tooltip>
        </Box>

        <Box sx={{ display: 'flex', gap: 1 }}>
          <Tooltip title="使用相同设置重新导出">
            <Button
              size="small"
              variant="outlined"
              startIcon={<ReplayIcon />}
              onClick={handleReExport}
              sx={{ color: 'white', borderColor: 'rgba(255,255,255,0.3)' }}
            >
              重新导出
            </Button>
          </Tooltip>
          <Button onClick={onClose} sx={{ color: 'white' }}>
            关闭
          </Button>
        </Box>
      </DialogActions>
    </Dialog>
  );
};

export default VideoPreviewDialog;
