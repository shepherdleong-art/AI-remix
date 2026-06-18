/**
 * TemplatePreview component.
 *
 * Embedded video player that simulates template playback using canvas.
 * Shows colored blocks representing each segment in sequence with transitions.
 * Includes play/pause/stop controls and a progress bar.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Slider,
  Paper,
  Chip,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious';
import SkipNextIcon from '@mui/icons-material/SkipNext';
import { useTemplateStore } from '@/renderer/store/template-store';
import type { Segment } from '@/renderer/types/template';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import { formatDuration } from '@/renderer/types/material';

/** Canvas dimensions */
const CANVAS_WIDTH: number = 640;
const CANVAS_HEIGHT: number = 360;

/**
 * Color palette for segment blocks in the canvas preview.
 */
const SEGMENT_COLORS: string[] = [
  '#1976d2', '#388e3c', '#f57c00', '#7b1fa2',
  '#c2185b', '#00796b', '#5d9cec', '#8bc34a',
  '#ff9800', '#e91e63', '#00bcd4', '#795548',
];

/**
 * Canvas-based template preview player.
 *
 * Simulates template playback by rendering colored blocks for each
 * segment in sequence. Each block shows the segment order number
 * and duration. Transition effects are visualized with cross-fade.
 */
const TemplatePreview: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animFrameRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const pausedAtRef = useRef<number>(0);

  const currentTemplate = useTemplateStore((s) => s.currentTemplate);
  const selectedSegmentId = useTemplateStore((s) => s.selectedSegmentId);
  const selectSegment = useTemplateStore((s) => s.selectSegment);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [currentSegmentIdx, setCurrentSegmentIdx] = useState<number>(-1);

  const template = currentTemplate();

  const totalDuration: number = template?.totalDuration || 0;
  const segments: Segment[] = template?.segments || [];

  /**
   * Find which segment is active at a given time.
   */
  const getSegmentAtTime = useCallback(
    (time: number): { index: number; segTime: number } => {
      let accumulated: number = 0;
      for (let i: number = 0; i < segments.length; i++) {
        const segEnd: number = accumulated + segments[i].duration;
        if (time < segEnd) {
          return { index: i, segTime: time - accumulated };
        }
        accumulated = segEnd;
      }
      return { index: segments.length - 1, segTime: segments.length > 0 ? segments[segments.length - 1].duration : 0 };
    },
    [segments],
  );

  /**
   * Draw the current frame on canvas.
   */
  const drawFrame = useCallback(
    (time: number): void => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
      if (!ctx) return;

      // Clear canvas
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      if (segments.length === 0) {
        // Draw empty state
        ctx.fillStyle = '#ffffff';
        ctx.font = '18px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('暂无片段，请添加片段到时间轴', CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2);
        return;
      }

      const { index, segTime } = getSegmentAtTime(time);
      setCurrentSegmentIdx(index);

      const segment: Segment = segments[index];
      const color: string = SEGMENT_COLORS[index % SEGMENT_COLORS.length];

      // Draw segment block
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Draw segment info overlay
      ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.fillRect(0, CANVAS_HEIGHT - 60, CANVAS_WIDTH, 60);

      // Segment order
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 24px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`片段 #${index + 1}`, 20, CANVAS_HEIGHT - 28);

      // Time info
      ctx.font = '14px "Microsoft YaHei", sans-serif';
      ctx.fillText(
        `${formatDuration(segTime)} / ${formatDuration(segment.duration)}`,
        20,
        CANVAS_HEIGHT - 8,
      );

      // Material type badge
      ctx.textAlign = 'right';
      const matType: string = segment.materialId ? '已关联素材' : '未关联素材';
      ctx.fillText(matType, CANVAS_WIDTH - 20, CANVAS_HEIGHT - 8);

      // Draw transition indicator
      if (segment.transitionIn.type !== 'none' || segment.transitionOut.type !== 'none') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        if (segment.transitionIn.type !== 'none') {
          ctx.fillRect(0, 0, 40, CANVAS_HEIGHT);
        }
        if (segment.transitionOut.type !== 'none') {
          ctx.fillRect(CANVAS_WIDTH - 40, 0, 40, CANVAS_HEIGHT);
        }
      }

      // Speed indicator
      if (segment.speed !== 1) {
        ctx.fillStyle = 'rgba(255, 152, 0, 0.8)';
        ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${segment.speed}x`, CANVAS_WIDTH - 20, CANVAS_HEIGHT - 40);
      }
    },
    [segments, getSegmentAtTime],
  );

  /**
   * Animation loop.
   */
  const animate = useCallback((): void => {
    const now: number = performance.now();
    const elapsed: number = (now - startTimeRef.current) / 1000;

    if (totalDuration > 0 && elapsed >= totalDuration) {
      // Finished — stop at end
      setCurrentTime(totalDuration);
      drawFrame(totalDuration);
      setIsPlaying(false);
      return;
    }

    const time: number = Math.min(elapsed, totalDuration || elapsed);
    setCurrentTime(time);
    drawFrame(time);
    animFrameRef.current = requestAnimationFrame(animate);
  }, [totalDuration, drawFrame]);

  // Initial draw
  useEffect(() => {
    drawFrame(0);
    setCurrentTime(0);
    setCurrentSegmentIdx(-1);
  }, [template?.id, segments.length, drawFrame]);

  // Cleanup animation on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  const handlePlay = useCallback((): void => {
    if (isPlaying) return;
    if (segments.length === 0) return;

    startTimeRef.current = performance.now() - pausedAtRef.current * 1000;
    setIsPlaying(true);
    animFrameRef.current = requestAnimationFrame(animate);
  }, [isPlaying, segments.length, animate]);

  const handlePause = useCallback((): void => {
    if (!isPlaying) return;
    pausedAtRef.current = currentTime;
    setIsPlaying(false);
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
  }, [isPlaying, currentTime]);

  const handleStop = useCallback((): void => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
    }
    setIsPlaying(false);
    setCurrentTime(0);
    pausedAtRef.current = 0;
    setCurrentSegmentIdx(-1);
    drawFrame(0);
  }, [drawFrame]);

  const handleSkipPrev = useCallback((): void => {
    const { index } = getSegmentAtTime(currentTime);
    const prevIdx: number = Math.max(0, index - 1);

    // Calculate time at start of prev segment
    let time: number = 0;
    for (let i: number = 0; i < prevIdx; i++) {
      time += segments[i].duration;
    }

    setCurrentTime(time);
    pausedAtRef.current = time;
    drawFrame(time);

    if (isPlaying) {
      startTimeRef.current = performance.now() - time * 1000;
    }
  }, [currentTime, segments, getSegmentAtTime, drawFrame, isPlaying]);

  const handleSkipNext = useCallback((): void => {
    const { index } = getSegmentAtTime(currentTime);
    const nextIdx: number = Math.min(segments.length - 1, index + 1);

    // Calculate time at start of next segment
    let time: number = 0;
    for (let i: number = 0; i < nextIdx; i++) {
      time += segments[i].duration;
    }

    setCurrentTime(time);
    pausedAtRef.current = time;
    drawFrame(time);

    if (isPlaying) {
      startTimeRef.current = performance.now() - time * 1000;
    }
  }, [currentTime, segments, getSegmentAtTime, drawFrame, isPlaying]);

  const handleSeek = useCallback(
    (_event: Event, value: number | number[]): void => {
      const time: number = value as number;
      setCurrentTime(time);
      pausedAtRef.current = time;
      drawFrame(time);
      if (isPlaying) {
        startTimeRef.current = performance.now() - time * 1000;
      }
    },
    [drawFrame, isPlaying],
  );

  const handleCanvasClick = useCallback((): void => {
    if (currentSegmentIdx >= 0 && currentSegmentIdx < segments.length) {
      selectSegment(segments[currentSegmentIdx].id);
    }
  }, [currentSegmentIdx, segments, selectSegment]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom fontWeight={600} sx={{ mb: 1 }}>
        模板预览
      </Typography>

      {/* Canvas */}
      <Box
        sx={{
          width: '100%',
          aspectRatio: '16/9',
          maxWidth: CANVAS_WIDTH,
          mx: 'auto',
          bgcolor: '#1a1a2e',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_WIDTH}
          height={CANVAS_HEIGHT}
          onClick={handleCanvasClick}
          style={{
            width: '100%',
            height: '100%',
            cursor: 'pointer',
            display: 'block',
          }}
        />
      </Box>

      {/* Current segment info */}
      {currentSegmentIdx >= 0 && currentSegmentIdx < segments.length && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, justifyContent: 'center' }}>
          <Chip
            label={`片段 #${currentSegmentIdx + 1}`}
            size="small"
            color={
              selectedSegmentId === segments[currentSegmentIdx]?.id
                ? 'primary'
                : 'default'
            }
            variant="outlined"
          />
          <Typography variant="caption" color="text.secondary">
            {segments[currentSegmentIdx]?.materialId
              ? '已关联素材'
              : '未关联素材'}
          </Typography>
        </Box>
      )}

      {/* Progress slider */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
        <Typography variant="caption" sx={{ minWidth: 36, fontSize: 11 }}>
          {formatDuration(currentTime)}
        </Typography>
        <Slider
          value={currentTime}
          onChange={handleSeek}
          min={0}
          max={totalDuration || 1}
          step={0.1}
          size="small"
          sx={{ flex: 1 }}
        />
        <Typography variant="caption" sx={{ minWidth: 36, textAlign: 'right', fontSize: 11 }}>
          {formatDuration(totalDuration)}
        </Typography>
      </Box>

      {/* Controls */}
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
        <IconButton size="small" onClick={handleSkipPrev} disabled={segments.length === 0}>
          <SkipPreviousIcon fontSize="small" />
        </IconButton>
        {isPlaying ? (
          <IconButton size="medium" onClick={handlePause} color="primary" disabled={segments.length === 0}>
            <PauseIcon />
          </IconButton>
        ) : (
          <IconButton size="medium" onClick={handlePlay} color="primary" disabled={segments.length === 0}>
            <PlayArrowIcon />
          </IconButton>
        )}
        <IconButton size="small" onClick={handleStop} disabled={segments.length === 0}>
          <StopIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" onClick={handleSkipNext} disabled={segments.length === 0}>
          <SkipNextIcon fontSize="small" />
        </IconButton>
      </Box>
    </Paper>
  );
};

export default TemplatePreview;
