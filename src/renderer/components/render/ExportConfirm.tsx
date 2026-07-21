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
  Chip,
  LinearProgress,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MovieIcon from '@mui/icons-material/Movie';
import AspectRatioIcon from '@mui/icons-material/AspectRatio';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import HighQualityIcon from '@mui/icons-material/HighQuality';

import { useEditingStore, TimelineSegment, computeOutputDims } from '@/renderer/store/editing-store';
import { getBackendBaseUrl } from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { computeCoverFit, measureTextWidth } from '@/renderer/utils/coverFit';

/**
 * 画幅 → 显示标签。
 */
const ASPECT_LABELS: Record<string, string> = {
  '9:16': '9:16 (竖屏)',
  '3:4':  '3:4 (社交)',
};

/**
 * 分辨率与画幅是两个正交维度：
 *  - 画幅(videoAspect) 决定形状：9:16 或 3:4
 *  - 分辨率(videoResolution) 决定像素量：1080p=宽1080, 2K=宽1440
 * 输出高度 = 宽度 × 画幅高宽比，由 computeOutputDims() 计算（见 editing-store.ts）。
 * 例如 9:16 → 1080×1920 / 1440×2560；3:4 → 1080×1440 / 1440×1920。
 *
 * 封面渲染高度跟随成片分辨率（不再固定 1920）：COVER_SCALE = 当前成片高 / 320，
 * 与步骤3封面预览的 320px 框保持同比例，故预览↔导出封面字号严格一致(WYSIWYG)。
 * 后端 ai_editing.py 的 cover 渲染同样改用传入的 target_width/target_height。
 */

const Api = {
  post: async (path: string, body: Record<string, unknown>): Promise<{ code: number; message: string; data?: Record<string, unknown> }> => {
    const baseUrl: string = await getBackendBaseUrl();
    const resp = await fetch(`${baseUrl}${path}`, {
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
  const ttsApiKeys = useEditingStore((s) => s.ttsApiKeys);
  const ttsProvider = useEditingStore((s) => s.ttsProvider);
  const ttsAudioPath = useEditingStore((s) => s.audioPath);
  const speechSpeed = useEditingStore((s) => s.speechSpeed);
  const bgmName = useEditingStore((s) => s.bgmName);
  const bgmVolume = useEditingStore((s) => s.bgmVolume);
  const voiceVolume = useEditingStore((s) => s.voiceVolume);
  const subtitleFont = useEditingStore((s) => s.subtitleFont);
  const subtitleFontPath = useEditingStore((s) => s.subtitleFontPath);
  const subtitleColor = useEditingStore((s) => s.subtitleColor);
  const subtitleSize = useEditingStore((s) => s.subtitleSize);
  const subtitleStrokeColor = useEditingStore((s) => s.subtitleStrokeColor);
  const subtitleStrokeWidth = useEditingStore((s) => s.subtitleStrokeWidth);
  const subtitleOverrides = useEditingStore((s) => s.subtitleOverrides);
  const coverVideoPath = useEditingStore((s) => s.coverVideoPath);
  const coverTime = useEditingStore((s) => s.coverTime);
  const coverTitle = useEditingStore((s) => s.coverTitle);
  const coverSubtitle = useEditingStore((s) => s.coverSubtitle);
  const coverTitleX = useEditingStore((s) => s.coverTitleX);
  const coverTitleY = useEditingStore((s) => s.coverTitleY);
  const coverSubX = useEditingStore((s) => s.coverSubX);
  const coverSubY = useEditingStore((s) => s.coverSubY);
  const coverTitleSize = useEditingStore((s) => s.coverTitleSize);
  const coverSubSize = useEditingStore((s) => s.coverSubSize);
  const coverTitleColor = useEditingStore((s) => s.coverTitleColor);
  const coverSubColor = useEditingStore((s) => s.coverSubColor);
  const coverTitleStrokeColor = useEditingStore((s) => s.coverTitleStrokeColor);
  const coverTitleStrokeWidth = useEditingStore((s) => s.coverTitleStrokeWidth);
  const coverSubStrokeColor = useEditingStore((s) => s.coverSubStrokeColor);
  const coverSubStrokeWidth = useEditingStore((s) => s.coverSubStrokeWidth);
  const coverTitleItalic = useEditingStore((s) => s.coverTitleItalic);
  const coverSubItalic = useEditingStore((s) => s.coverSubItalic);
  const videoAspect = useEditingStore((s) => s.videoAspect);
  const setVideoAspect = useEditingStore((s) => s.setVideoAspect);
  const videoResolution = useEditingStore((s) => s.videoResolution);
  const setVideoResolution = useEditingStore((s) => s.setVideoResolution);
  const coverZoom = useEditingStore((s) => s.coverZoom);
  const coverOffsetX = useEditingStore((s) => s.coverOffsetX);
  const coverOffsetY = useEditingStore((s) => s.coverOffsetY);
  const coverFont = useEditingStore((s) => s.coverFont);
  const coverFontPath = useEditingStore((s) => s.coverFontPath);

  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const backendUrl: string = useBackendUrl();

  const hasTimeline = timeline.length > 0;
  const resolution = computeOutputDims(videoAspect, videoResolution);
  // 封面高度跟随成片分辨率：COVER_SCALE = 成片高 / 320，与步骤3封面预览 320px 框同比。
  const coverHeight = resolution.height;
  const COVER_SCALE = coverHeight / 320;
  const resLabel = `${videoResolution} · ${resolution.width}×${resolution.height}`;

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
        subtitle_x: subtitleOverrides[i]?.x,
        subtitle_y: subtitleOverrides[i]?.y,
      }));

      // ── Cover WYSIWYG + anti-crop (Plan B+) ──
      // Defensive: ensure the preview/cover font is registered + loaded so
      // measureTextWidth reads the real glyph metrics. At export time the font
      // is usually already loaded (the user visited the cover editor), but we
      // guard anyway. The hidden <span> measurement matches the browser preview.
      try {
        await document.fonts.load(`10px 'coverPreviewFont'`);
      } catch {
        /* font may already be cached / not yet registered — fall through */
      }
      await document.fonts.ready;
      // 封面渲染尺寸 = 成片尺寸（resolution），后端 ai_editing.py 用传入的
      // target_width/target_height 渲染封面。此处以 EXPORT px（size * COVER_SCALE，
      // COVER_SCALE = 成片高/320）测量，使安全边距检查使用导出度量；收缩系数基于
      // PREVIEW 基础字号(fontSize)计算，title_size = effective * COVER_SCALE。
      const coverCanvas = { w: resolution.width, h: resolution.height };
            const measureCover = (text: string, size: number, italic: boolean, weight: number): number =>
        measureTextWidth(text, {
          fontSize: size * COVER_SCALE,
          fontFamily: `'coverPreviewFont', '${coverFont}', sans-serif`,
          fontWeight: weight,
          fontStyle: italic ? 'italic' : 'normal',
        });
      const titleFit = coverTitle
        ? computeCoverFit({
            measuredWidth: measureCover(coverTitle, coverTitleSize, coverTitleItalic, 800),
            measuredHeight: coverTitleSize * COVER_SCALE * 1.2,
            fontSize: coverTitleSize,
            titleX: coverTitleX, titleY: coverTitleY,
            canvasW: coverCanvas.w, canvasH: coverCanvas.h, safeMargin: 0.04,
            // Match ffmpeg's borderw (stroke) which adds this many px per side.
            strokeWidth: coverTitleStrokeWidth * COVER_SCALE * 0.5,
          })
        : null;
      const subFit = coverSubtitle
        ? computeCoverFit({
            measuredWidth: measureCover(coverSubtitle, coverSubSize, coverSubItalic, 600),
            measuredHeight: coverSubSize * COVER_SCALE * 1.2,
            fontSize: coverSubSize,
            titleX: coverSubX, titleY: coverSubY,
            canvasW: coverCanvas.w, canvasH: coverCanvas.h, safeMargin: 0.04,
            strokeWidth: coverSubStrokeWidth * COVER_SCALE * 0.5,
          })
        : null;

      const resp = await Api.post('/api/ai-editing/composite', {
        segments,
        script: script.trim(),
        voice,
        output_name: outputName,
        width: resolution.width,
        height: resolution.height,
        api_key: ttsApiKeys[ttsProvider] ?? '',
        provider: ttsProvider,
        audio_path: ttsAudioPath || '',
        speed: speechSpeed,
        subtitle_style: {
          font: subtitleFont,
          font_path: subtitleFontPath,
          color: subtitleColor,
          // subtitleSize 现为「画面宽度%」。预览按 %×320px、导出按 %×导出宽，
          // 比例恒等于 320/导出宽（=视频缩放比），故预览与成片字幕严格等比一致(WYSIWYG)。
          size: Math.round(subtitleSize / 100 * resolution.width),
          stroke_color: subtitleStrokeColor,
          // 字幕描边必须与字号同步缩放：步骤3预览用4方向 text-shadow 模拟描边，
          // 其可见描边厚度≈ strokeWidth(在 preview 框里字号=subtitleSize)；导出时
          // 字号已 ×(导出宽/360)，描边若不跟着缩放，导出后描边相对字形的比例就会
          // 变成预览的 360/导出宽（如3:4/1080p 下仅 1/3），导致「描边与调节值不一致」。
          // 故 stroke_width 同样 ×(导出宽/360)。注意：这里不乘0.5——0.5补偿只针对封面
          // 的 -webkit-text-stroke(居中+ paint-order:stroke fill 内侧一半被覆盖)；
          // 字幕是 text-shadow 偏移描边，整圈在字形外侧，与 ffmpeg borderw 语义一致，
          // 实测二者厚度≈1:1(见 verify 脚本)，无需 0.5。
          // 描边必须随字号同步缩放：预览在 320px 框里用 strokeWidth px 的 4 方向
          // text-shadow（整圈在字形外侧），导出用 ffmpeg borderw 同样整圈外侧，
          // 二者厚度≈1:1。故描边按 导出宽/320 缩放（注意：封面才需 ×0.5 补偿，字幕不需要）。
          stroke_width: Math.round(subtitleStrokeWidth * resolution.width / 320),
        },
        cover: (coverTitle || coverSubtitle) ? {
          video_path: coverVideoPath || timeline[0]?.video_path || '',
          time: coverTime,
          title: coverTitle,
          subtitle: coverSubtitle,
          title_x: titleFit ? titleFit.titleX : coverTitleX,
          title_y: titleFit ? titleFit.titleY : coverTitleY,
          sub_x: subFit ? subFit.titleX : coverSubX,
          sub_y: subFit ? subFit.titleY : coverSubY,
          title_size: Math.round((titleFit ? titleFit.fontSize : coverTitleSize) * COVER_SCALE),
          sub_size: Math.round((subFit ? subFit.fontSize : coverSubSize) * COVER_SCALE),
          title_color: coverTitleColor,
          sub_color: coverSubColor,
          title_stroke_color: coverTitleStrokeColor,
          // 描边 ×0.5 补偿：ffmpeg borderw 整圈画在字形外侧(全可见)，而 CSS -webkit-text-stroke 居中且 paint-order:stroke fill 使内侧一半被填充覆盖，故导出可见外侧描边≈预览的2倍；乘0.5使其与步骤3预览视觉一致。
          title_stroke_width: Math.round(coverTitleStrokeWidth * COVER_SCALE * 0.5),
          sub_stroke_color: coverSubStrokeColor,
          sub_stroke_width: Math.round(coverSubStrokeWidth * COVER_SCALE * 0.5),
          title_italic: coverTitleItalic,
          sub_italic: coverSubItalic,
          aspect: videoAspect,
          zoom: coverZoom,
          // Cover pan offset: the store keeps coverOffsetX/Y in *preview-box*
          // pixels (the step-3 box is 180px / 240px wide, i.e. export / COVER_SCALE).
          // The backend crop formula uses offset_x/offset_y in *export* pixels
          // (W = 1080 / 1440). Convert here at the API boundary. The sign is
          // negated because a positive preview offset shifts the frame content
          // RIGHT, whereas a positive backend offset shifts the crop window RIGHT
          // (== content LEFT); negating keeps preview and export panning in the
          // same visual direction (this was the "export shifted right" bug).
          offset_x: Math.round(-coverOffsetX * COVER_SCALE),
          offset_y: Math.round(-coverOffsetY * COVER_SCALE),
          font: coverFont,
          font_path: coverFontPath,
        } : null,
        bgm_name: bgmName,
        bgm_volume: bgmVolume,
        voice_volume: voiceVolume,
      });

      if (resp.code !== 0) {
        setError(`导出失败: ${resp.message}`);
        setRendering(false);
        setProgress('');
        return;
      }

      // Debug: log actual cover data sent
      if (process.env.NODE_ENV !== 'production') {
        console.log('[ExportConfirm] cover data:', JSON.stringify({
          video_path: coverVideoPath,
          title: coverTitle?.substring(0, 30),
          subtitle: coverSubtitle?.substring(0, 30),
          title_stroke_color: coverTitleStrokeColor,
          title_stroke_width: coverTitleStrokeWidth,
          sub_stroke_color: coverSubStrokeColor,
          sub_stroke_width: coverSubStrokeWidth,
          font: coverFont,
          font_path: coverFontPath,
        }));
      }

      const outPath = (resp.data as Record<string, unknown>)?.output_path as string;
      const subApplied = !!(resp.data as Record<string, unknown>)?.subtitle_applied;
      const coverApplied = !!(resp.data as Record<string, unknown>)?.cover_applied;
      const diag = (resp.data as Record<string, unknown>)?._diag as Record<string, unknown> | undefined;
      setOutputPath(outPath);
      setProgress('');
      const extra = [subApplied ? '字幕' : '', coverApplied ? '封面' : (coverTitle || coverSubtitle) ? `封面失败⚠️${diag?.cover_error ? ':' + diag.cover_error : ''}` : ''].filter(Boolean).join('+');
      const diagMsg = diag
        ? ` | 诊断: ${diag.n_segs}段, 有文字=${diag.has_text}, 字幕样式=${diag.has_subtitle_style}${diag.cover_condition !== undefined ? ', 封面条件=' + diag.cover_condition + (diag.cover_error ? ' 错误=' + diag.cover_error : '') : ''} | 字体=${subtitleFont} 大小=${subtitleSize}% 颜色=${subtitleColor}`
        : '';
      setSuccess(`视频已导出: ${outPath.split(/[\\/]/).pop()} ${extra ? '(' + extra + ')' : ''}${diagMsg}`);

      // Auto-play audio preview
      if (ttsAudioPath && audioRef.current) {
        const baseUrl: string = await getBackendBaseUrl();
        audioRef.current.src = `${baseUrl}/api/ai-editing/audio?path=${encodeURIComponent(ttsAudioPath)}`;
        audioRef.current.load();
      }
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`);
      setProgress('');
    } finally {
      setRendering(false);
    }
  }, [hasTimeline, script, timeline, voice, videoAspect, videoResolution, resolution, setOutputPath,
    ttsApiKeys, ttsProvider, ttsAudioPath, speechSpeed, subtitleFont, subtitleFontPath, subtitleColor,
    subtitleSize, subtitleStrokeColor, subtitleStrokeWidth, subtitleOverrides, videoAspect,
    coverVideoPath, coverTime, coverTitle, coverSubtitle, coverTitleX, coverTitleY, coverSubX, coverSubY,
    coverTitleSize, coverSubSize, coverTitleColor, coverSubColor,
    coverTitleStrokeColor, coverTitleStrokeWidth, coverSubStrokeColor, coverSubStrokeWidth,
    coverTitleItalic, coverSubItalic, coverZoom, coverOffsetX, coverOffsetY,
    coverFont, coverFontPath]);

  return (
    <Box>
      {/* Summary banner */}
      <Paper
        elevation={0}
        sx={{
          p: 2, mb: 3,
          bgcolor: hasTimeline ? 'rgba(52,199,89,0.16)' : 'background.paperAlt',
          border: 1,
          borderColor: hasTimeline ? 'success.main' : 'divider',
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
        {hasTimeline && (
          <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            <Chip size="small" variant="outlined" label={`画幅 ${videoAspect} · ${videoResolution} · ${resolution.width}×${resolution.height}`} />
            <Chip size="small" variant="outlined" label={`字幕 ${subtitleSize}% · ${subtitleFont}`} />
            <Chip size="small" variant="outlined" label={`BGM ${bgmName || '无'} · ${bgmVolume}%`} />
            <Chip size="small" variant="outlined" label={`口播 ${voiceVolume}%`} />
          </Box>
        )}
      </Paper>

      {/* Aspect ratio + Resolution */}
      <Paper elevation={0} sx={{ p: 2, mb: 3, bgcolor: 'background.paperAlt' }}>
        <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <AspectRatioIcon fontSize="small" /> 画面比例
        </Typography>
        <ToggleButtonGroup
          value={videoAspect}
          exclusive
          onChange={(_: React.MouseEvent<HTMLElement>, val: string | null) => {
            if (val) setVideoAspect(val as '9:16' | '3:4');
          }}
          size="small"
        >
          {Object.entries(ASPECT_LABELS).map(([key, label]) => (
            <ToggleButton key={key} value={key}>
              {label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <Box sx={{ mt: 2 }}>
          <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <HighQualityIcon fontSize="small" /> 输出分辨率: {resLabel}
          </Typography>
          <ToggleButtonGroup
            value={videoResolution}
            exclusive
            onChange={(_: React.MouseEvent<HTMLElement>, val: string | null) => {
              if (val) setVideoResolution(val as '1080p' | '2K');
            }}
            size="small"
          >
            <ToggleButton value="1080p">1080p</ToggleButton>
            <ToggleButton value="2K">2K</ToggleButton>
          </ToggleButtonGroup>
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
            <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
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
              src={`${backendUrl}/api/ai-editing/video?path=${encodeURIComponent(outputPath)}`}
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
