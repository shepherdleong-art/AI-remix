/**
 * ExportConfirm — Step 4: Export & Render.
 *
 * Uses the AI-generated timeline from editing-store instead of the old template system.
 * Adds aspect ratio selection (3:4 / 9:16) and triggers composite rendering.
 */
import React, { useCallback, useState, useRef } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Divider,
  Alert,
  ToggleButtonGroup,
  ToggleButton,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MovieIcon from '@mui/icons-material/Movie';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import HighQualityIcon from '@mui/icons-material/HighQuality';

import { useEditingStore, TimelineSegment } from '@/renderer/store/editing-store';

/**
 * Supported aspect ratios with corresponding target resolutions.
 */
const ASPECT_RATIOS: Record<string, { label: string; width: number; height: number }> = {
  '9:16': { label: '9:16 (竖屏)', width: 1080, height: 1920 },
  '3:4':  { label: '3:4 (社交)',  width: 1080, height: 1440 },
};

const Api = {
  post: async (path: string, body: Record<string, unknown>): Promise<{ code: number; message: string; data?: Record<string, unknown> }> => {
    const resp = await fetch(`http://127.0.0.1:18000${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  },
};

const ExportConfirm: React.FC = () => {
  const timeline = useEditingStore((s) => s.timeline);
  const script = useEditingStore((s) => s.script);
  const voice = useEditingStore((s) => s.voice);
  const outputPath = useEditingStore((s) => s.outputPath);
  const setOutputPath = useEditingStore((s) => s.setOutputPath);
  const apiKey = useEditingStore((s) => s.apiKey);
  const ttsAudioPath = useEditingStore((s) => s.audioPath);
  const subtitleFont = useEditingStore((s) => s.subtitleFont);
  const subtitleFontPath = useEditingStore((s) => s.subtitleFontPath);
  const subtitleColor = useEditingStore((s) => s.subtitleColor);
  const subtitleSize = useEditingStore((s) => s.subtitleSize);
  const subtitleStrokeColor = useEditingStore((s) => s.subtitleStrokeColor);
  const subtitleStrokeWidth = useEditingStore((s) => s.subtitleStrokeWidth);
  const subtitleOverrides = useEditingStore((s) => s.subtitleOverrides);

  const [aspectRatio, setAspectRatio] = useState<string>('9:16');
  const [resolutionScale, setResolutionScale] = useState<number>(1.0);
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const hasTimeline = timeline.length > 0;
  const baseRes = ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['9:16'];
  const resolution = {
    width: Math.round(baseRes.width * resolutionScale),
    height: Math.round(baseRes.height * resolutionScale),
  };
  const resLabel = resolutionScale === 1.0 ? `${resolution.width}×${resolution.height} (1080p)` :
                   resolutionScale === 2.0 ? `${resolution.width}×${resolution.height} (2K)` :
                   `${resolution.width}×${resolution.height} (${Math.round(resolutionScale * 720)}p)`;

  const handleExport = useCallback(async (): Promise<void> => {
    if (!hasTimeline || !script) {
      setError('请先在步骤 2 中完成 AI 智能创作');
      return;
    }

    setRendering(true);
    setError(null);
    setSuccess(null);
    setOutputPath(null);
    setProgress('正在生成口播音轨...');

    try {
      const outputName = `ai_edit_${Date.now()}`;

      // Build segments with video_path + timestamps
      const segments = timeline.map((seg: TimelineSegment, i: number) => ({
        video_path: seg.video_path,
        start_time: seg.start_time,
        duration: seg.duration,
        segment_text: (subtitleOverrides[i]?.text) ?? seg.segment_text,
      }));

      const resp = await Api.post('/api/ai-editing/composite', {
        segments,
        script: script.trim(),
        voice,
        output_name: outputName,
        width: resolution.width,
        height: resolution.height,
        api_key: apiKey,
        audio_path: ttsAudioPath || '',
        subtitle_style: {
          font: subtitleFont,
          font_path: subtitleFontPath,
          color: subtitleColor,
          size: subtitleSize,
          stroke_color: subtitleStrokeColor,
          stroke_width: subtitleStrokeWidth,
        },
      });

      if (resp.code !== 0) {
        setError(`导出失败: ${resp.message}`);
        setRendering(false);
        setProgress('');
        return;
      }

      const outPath = (resp.data as Record<string, unknown>)?.output_path as string;
      const audioPath = (resp.data as Record<string, unknown>)?.audio_path as string;
      setOutputPath(outPath);
      // Set preview URL (browser can play local files via file:// or http)
      setPreviewUrl(outPath);
      setProgress('');
      setSuccess(`视频已导出: ${outPath.split(/[\\/]/).pop()}`);

      // Auto-play audio preview
      if (audioPath && audioRef.current) {
        audioRef.current.src = `http://127.0.0.1:18000/api/ai-editing/audio?path=${encodeURIComponent(audioPath)}`;
        audioRef.current.load();
      }
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`);
      setProgress('');
    } finally {
      setRendering(false);
    }
  }, [hasTimeline, script, timeline, voice, aspectRatio, resolution, setOutputPath]);

  return (
    <Box>
      {/* Summary banner */}
      <Paper
        elevation={0}
        sx={{
          p: 2, mb: 3,
          bgcolor: hasTimeline ? 'success.50' : 'grey.50',
          border: 1,
          borderColor: hasTimeline ? 'success.main' : 'grey.300',
          borderRadius: 1,
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          {hasTimeline ? 'AI 时间线已就绪' : '等待 AI 创作'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {hasTimeline
            ? `${timeline.length} 个片段 · 约 ${timeline.reduce((a, s) => a + (s.duration || 0), 0).toFixed(0)} 秒 · 音色: ${voice}`
            : '请返回步骤 2 完成 AI 智能创作'}
        </Typography>
      </Paper>

      {/* Aspect ratio + Resolution */}
      <Paper elevation={0} sx={{ p: 2, mb: 3, bgcolor: 'grey.50' }}>
        <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <AspectRatioIcon fontSize="small" /> 画面比例
        </Typography>
        <ToggleButtonGroup
          value={aspectRatio}
          exclusive
          onChange={(_: React.MouseEvent<HTMLElement>, val: string | null) => {
            if (val) setAspectRatio(val);
          }}
          size="small"
        >
          {Object.entries(ASPECT_RATIOS).map(([key, info]) => (
            <ToggleButton key={key} value={key}>
              {info.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <HighQualityIcon fontSize="small" /> 输出分辨率: {resLabel}
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, maxWidth: 400 }}>
            <Typography variant="caption">720p</Typography>
            <Slider
              size="small"
              value={resolutionScale}
              min={0.67}
              max={2.0}
              step={0.33}
              onChange={(_e, val) => setResolutionScale(val as number)}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v.toFixed(1)}x`}
              marks={[
                { value: 0.67, label: '720p' },
                { value: 1.0, label: '1080p' },
                { value: 1.33, label: '1.3x' },
                { value: 1.67, label: '1.7x' },
                { value: 2.0, label: '2K' },
              ]}
              sx={{ flex: 1 }}
            />
            <Typography variant="caption">2K</Typography>
          </Box>
        </Box>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          输出: {resolution.width}×{resolution.height} · 自动裁切填满，无黑边不拉伸
        </Typography>
      </Paper>

      {/* Timeline preview */}
      {hasTimeline && (
        <Paper elevation={0} sx={{ p: 2, mb: 3 }}>
          <Typography variant="subtitle2" gutterBottom>
            时间线片段 ({timeline.length})
          </Typography>
          {timeline.map((seg: TimelineSegment, i: number) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'grey.100' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 36 }}>
                #{i + 1}
              </Typography>
              <Box sx={{ flex: 1 }}>
                <Typography variant="body2" noWrap>{seg.segment_text}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {seg.video_path?.split(/[\\/]/).pop()} · {seg.start_time?.toFixed(1)}s起 · {seg.duration?.toFixed(1)}s
                </Typography>
              </Box>
            </Box>
          ))}
        </Paper>
      )}

      <Divider sx={{ my: 2 }} />

      {/* Export button */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2, mb: 2 }}>
        <Button
          variant="contained"
          color="primary"
          size="large"
          startIcon={rendering ? undefined : <PlayArrowIcon />}
          onClick={handleExport}
          disabled={rendering || !hasTimeline}
          sx={{ px: 4, py: 1.5 }}
        >
          {rendering ? '导出中...' : '开始导出'}
        </Button>

        {outputPath && !rendering && (
          <Button
            variant="outlined"
            startIcon={<OpenInNewIcon />}
            onClick={() => {
              // Show the path in an alert since we can't open folder in browser
              setSuccess(`文件路径: ${outputPath}`);
            }}
          >
            查看文件
          </Button>
        )}
      </Box>

      {/* Progress */}
      {rendering && (
        <Box sx={{ mb: 2 }}>
          <LinearProgress />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block', textAlign: 'center' }}>
            {progress}
          </Typography>
        </Box>
      )}

      {/* Alerts */}
      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert>}
      {success && (
        <Alert severity="success" icon={<MovieIcon />} sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      {/* Video Preview */}
      {outputPath && (
        <Paper elevation={1} sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" gutterBottom>
            视频预览
          </Typography>
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <video
              ref={videoRef}
              src={`http://127.0.0.1:18000/api/ai-editing/video?path=${encodeURIComponent(outputPath)}`}
              controls
              style={{ width: '100%', maxWidth: 400, borderRadius: 8 }}
            />
          </Box>
        </Paper>
      )}
      {outputPath && (
        <Box sx={{ mt: 1 }}>
          <audio ref={audioRef} controls style={{ width: '100%', maxWidth: 400 }}>
            您的浏览器不支持音频播放
          </audio>
        </Box>
      )}
    </Box>
  );
};

export default ExportConfirm;
