/**
 * TimelinePreview — Step 3 content with basic timeline editing.
 *
 * Allows: reorder (up/down), material replacement per segment, duration adjust.
 */
import React, { useCallback } from 'react';
import {
  Box, Typography, Paper, Button, IconButton, Tooltip,
  Select, MenuItem, FormControl, InputLabel, Slider,
} from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import { useEditingStore, TimelineSegment } from '@/renderer/store/editing-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { AnyMaterial } from '@/renderer/types/material';

const TimelinePreview: React.FC = () => {
  const timeline = useEditingStore((s) => s.timeline);
  const setTimeline = useEditingStore((s) => s.setTimeline);
  const materials = useMaterialsStore((s) => s.materials);
  const videoMaterials = materials.filter((m: AnyMaterial) => m.type === 'video');

  const handleMoveUp = useCallback((index: number) => {
    if (index <= 0) return;
    const next = [...timeline];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    setTimeline(next);
  }, [timeline, setTimeline]);

  const handleMoveDown = useCallback((index: number) => {
    if (index >= timeline.length - 1) return;
    const next = [...timeline];
    [next[index], next[index + 1]] = [next[index + 1], next[index]];
    setTimeline(next);
  }, [timeline, setTimeline]);

  const handleReplaceMaterial = useCallback((index: number, newPath: string) => {
    const next = timeline.map((seg, i) => {
      if (i !== index) return seg;
      return { ...seg, video_path: newPath, start_time: 0 };
    });
    setTimeline(next);
  }, [timeline, setTimeline]);

  const handleDurationChange = useCallback((index: number, newDuration: number) => {
    const next = timeline.map((seg, i) => {
      if (i !== index) return seg;
      return { ...seg, duration: Math.max(0.5, Math.min(15, newDuration)) };
    });
    setTimeline(next);
  }, [timeline, setTimeline]);

  if (timeline.length === 0) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 280 }}>
        <Typography variant="h6" color="text.secondary" gutterBottom>
          预览调整
        </Typography>
        <Typography variant="body2" color="text.secondary">
          请先在步骤 2「AI智能创作」中生成时间线
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        时间线编辑 ({timeline.length} 个片段)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        调整顺序、替换素材、修改时长 — 修改后前往步骤4导出
      </Typography>

      {timeline.map((seg: TimelineSegment, i: number) => (
        <Paper key={i} elevation={1} sx={{ p: 2, mb: 1.5 }}>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
            {/* Order controls */}
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 40 }}>
              <Typography variant="h6" color="primary.main" fontWeight={700}>
                {i + 1}
              </Typography>
              <Tooltip title="上移">
                <span>
                  <IconButton size="small" onClick={() => handleMoveUp(i)} disabled={i === 0}>
                    <ArrowUpwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="下移">
                <span>
                  <IconButton size="small" onClick={() => handleMoveDown(i)} disabled={i >= timeline.length - 1}>
                    <ArrowDownwardIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>

            {/* Segment content */}
            <Box sx={{ flex: 1 }}>
              <Typography variant="body2" fontWeight={600} gutterBottom>
                {seg.segment_text}
              </Typography>

              {/* Material replacement */}
              <FormControl size="small" sx={{ minWidth: 200, mb: 1 }}>
                <InputLabel>素材替换</InputLabel>
                <Select
                  value={seg.video_path}
                  label="素材替换"
                  onChange={(e) => handleReplaceMaterial(i, e.target.value as string)}
                  startAdornment={<SwapHorizIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />}
                >
                  {videoMaterials.map((m: AnyMaterial) => (
                    <MenuItem key={m.filePath || m.id} value={m.filePath || ''}>
                      {m.fileName || m.filePath?.split(/[\\/]/).pop() || m.id}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>

              {/* Duration slider */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40 }}>
                  时长
                </Typography>
                <Slider
                  size="small"
                  value={seg.duration}
                  min={0.5}
                  max={10}
                  step={0.5}
                  onChange={(_e, val) => handleDurationChange(i, val as number)}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => `${v}s`}
                  sx={{ maxWidth: 200 }}
                />
                <Typography variant="caption" fontWeight={600}>
                  {seg.duration?.toFixed(1)}s
                </Typography>
              </Box>

              {/* Source info */}
              <Typography variant="caption" color="text.secondary">
                素材: {seg.video_path?.split(/[\\/]/).pop()} · 从 {seg.start_time?.toFixed(1)}s 起
              </Typography>
            </Box>
          </Box>
        </Paper>
      ))}

      <Box sx={{ mt: 2, p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
        <Typography variant="body2" color="text.secondary">
          总时长: {timeline.reduce((a, s) => a + (s.duration || 0), 0).toFixed(1)}s · 
          修改完成后前往步骤4导出
        </Typography>
      </Box>
    </Box>
  );
};

export default TimelinePreview;
