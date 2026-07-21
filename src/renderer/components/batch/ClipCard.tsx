/**
 * 批量阶段三 · 单张成片卡片（ClipCard，D5/D6）。
 *
 * - 内嵌小预览：悬停播放前 3 秒（静音循环），悬停移动 scrub；离开暂停
 * - 标题（封面标题/脚本预览）、状态着色 Chip、总时长、BGM、封面缩略图角标
 * - 相似度预警（黄 icon）、待重新分配「重跑分配」按钮、已确认/已导出锁定 icon
 */
import React, { useMemo, useRef, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import LockIcon from '@mui/icons-material/Lock';
import ReplayIcon from '@mui/icons-material/Replay';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import type { BatchClip } from '@/renderer/types/batch';
import { CLIP_STATUS_META, fmtSec, materialThumbUrl, materialVideoUrl } from './utils';

/** 小预览循环窗口（秒） */
const PREVIEW_LOOP = 3;

/** 锁定状态（点击需先解锁） */
export function isClipLocked(status: string): boolean {
  return status === '已确认' || status === '已完成' || status === '导出中';
}

interface ClipCardProps {
  batchId: string;
  clip: BatchClip;
  /** 脚本预览文案（由父级按 script_id 解析） */
  scriptLabel: string;
  baseUrl: string;
  onOpen: () => void;
  onShowSimilarity: () => void;
  onReallocate: () => void;
  reallocating: boolean;
}

const ClipCard: React.FC<ClipCardProps> = ({
  batchId, clip, scriptLabel, baseUrl, onOpen, onShowSimilarity, onReallocate, reallocating,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hovering, setHovering] = useState(false);

  const firstSeg = clip.segments[0];
  const meta = CLIP_STATUS_META[clip.status] ?? CLIP_STATUS_META.待生成;
  const locked = isClipLocked(clip.status);
  const warnCount = clip.similarity_flags?.length ?? 0;
  const title = clip.cover?.title || scriptLabel || clip.id;
  const totalDur = clip.total_duration ?? clip.segments.reduce((a, s) => a + (s.duration || 0), 0);

  const videoSrc = useMemo(
    () => (firstSeg ? materialVideoUrl(baseUrl, batchId, firstSeg.file_hash) : ''),
    [baseUrl, batchId, firstSeg],
  );
  const loopStart = firstSeg?.in ?? 0;
  const loopEnd = loopStart + Math.min(PREVIEW_LOOP, firstSeg?.duration ?? PREVIEW_LOOP);

  const coverThumb = useMemo(() => {
    const cv = clip.cover;
    if (cv?.file_hash) return materialThumbUrl(baseUrl, batchId, cv.file_hash, cv.time ?? 0.5, 96);
    return null;
  }, [baseUrl, batchId, clip.cover]);

  const handleEnter = (): void => {
    setHovering(true);
    const v = videoRef.current;
    if (v) {
      v.currentTime = loopStart;
      void v.play().catch(() => {});
    }
  };
  const handleLeave = (): void => {
    setHovering(false);
    videoRef.current?.pause();
  };
  const handleScrub = (e: React.MouseEvent<HTMLVideoElement>): void => {
    const v = videoRef.current;
    if (!v) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    v.currentTime = loopStart + ratio * (loopEnd - loopStart);
  };
  const handleTimeUpdate = (): void => {
    const v = videoRef.current;
    if (v && v.currentTime >= loopEnd) v.currentTime = loopStart;
  };

  return (
    <Paper
      elevation={0}
      onClick={onOpen}
      sx={{
        bgcolor: 'background.paperAlt',
        border: '1.5px solid',
        borderColor:
          clip.status === '待重新分配' ? 'error.main'
            : warnCount > 0 ? 'warning.main'
              : clip.status === '已完成' ? 'success.main' : 'divider',
        borderRadius: 2,
        overflow: 'hidden',
        cursor: 'pointer',
        transition: 'border-color .15s, transform .15s',
        '&:hover': { borderColor: 'primary.main', transform: 'translateY(-2px)' },
      }}
    >
      {/* ── 预览区 ── */}
      <Box
        sx={{ position: 'relative', height: 200, bgcolor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
      >
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            preload="metadata"
            muted
            playsInline
            onMouseMove={handleScrub}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={(e) => { e.currentTarget.currentTime = loopStart; }}
            style={{ maxWidth: '100%', maxHeight: '100%' }}
          />
        ) : (
          <Typography variant="caption" color="text.secondary">无片段</Typography>
        )}
        {!hovering && (
          <Typography
            variant="caption"
            sx={{
              position: 'absolute', left: 6, top: 6, px: 0.75, py: 0.25,
              bgcolor: 'rgba(0,0,0,0.55)', borderRadius: 1, color: '#fff',
            }}
          >
            悬停预览
          </Typography>
        )}
        {/* 封面缩略图角标 */}
        {coverThumb && (
          <Tooltip title={`封面：${clip.cover?.title || ''}`}>
            <Box
              component="img"
              src={coverThumb}
              alt="封面"
              sx={{
                position: 'absolute', right: 6, bottom: 6, width: 44, height: 62,
                objectFit: 'cover', borderRadius: 1, border: '2px solid #fff',
              }}
            />
          </Tooltip>
        )}
        {/* 锁定角标 */}
        {locked && (
          <Tooltip title={clip.status === '已确认' ? '已确认（点击先解锁）' : `${clip.status}（锁定）`}>
            <Box
              sx={{
                position: 'absolute', right: 6, top: 6, width: 26, height: 26,
                borderRadius: '50%', bgcolor: 'rgba(0,0,0,0.55)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <LockIcon sx={{ fontSize: 15, color: '#fff' }} />
            </Box>
          </Tooltip>
        )}
      </Box>

      {/* ── 信息区 ── */}
      <Box sx={{ p: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            {clip.id}
          </Typography>
          <Box sx={{ flex: 1 }} />
          {warnCount > 0 && (
            <Tooltip title="与批次内其他成片素材重合度超阈值，点击查看撞车明细">
              <IconButton
                size="small"
                color="warning"
                onClick={(e) => { e.stopPropagation(); onShowSimilarity(); }}
                sx={{ p: 0.25 }}
              >
                <WarningAmberIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Chip size="small" color={meta.color} label={clip.status} />
        </Box>
        <Typography variant="body2" fontWeight={600} noWrap title={title}>
          {title}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {fmtSec(totalDur)} · {clip.segments.length} 段
          {clip.bgm_name ? ` · ♪ ${clip.bgm_name}` : ''}
        </Typography>
        {clip.feasible === false && (
          <Typography variant="caption" color="error.main" display="block">
            素材不足降级分配
          </Typography>
        )}
        {clip.status === '待重新分配' && (
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={<ReplayIcon />}
            disabled={reallocating}
            onClick={(e) => { e.stopPropagation(); onReallocate(); }}
            sx={{ mt: 0.75 }}
          >
            {reallocating ? '重跑中…' : '重跑分配'}
          </Button>
        )}
        {clip.status === '已完成' && clip.output_path && (
          <Typography variant="caption" color="success.main" display="block" noWrap title={clip.output_path}>
            ✓ {clip.output_path.split(/[\\/]/).pop()}
          </Typography>
        )}
      </Box>
    </Paper>
  );
};

export default ClipCard;
