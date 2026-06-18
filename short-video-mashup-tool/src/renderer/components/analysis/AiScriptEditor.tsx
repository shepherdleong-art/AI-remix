/**
 * AI Script Editor component.
 *
 * Replaces the "智能分析" step. User inputs narration text,
 * selects TTS voice, and triggers the AI editing pipeline:
 * text → voice → scene match → composite → output.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  LinearProgress,
  Alert,
  Paper,
  IconButton,
  Tooltip,
  Grid,
  Slider,
  Card,
  CardContent,
} from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import MovieIcon from '@mui/icons-material/Movie';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import { useEditingStore, TimelineSegment } from '@/renderer/store/editing-store';
import type { AnyMaterial } from '@/renderer/types/material';
import api from '@/renderer/api/backend-client';

const VOICES = [
  { id: 'Cherry',   label: 'Cherry 芊悦',     desc: '阳光亲切小姐姐' },
  { id: 'Ethan',    label: 'Ethan 晨煦',       desc: '阳光温暖男声' },
  { id: 'Nofish',   label: 'Nofish 不吃鱼',    desc: '设计师感' },
  { id: 'Jennifer', label: 'Jennifer 詹妮弗',  desc: '电影级美语女声' },
  { id: 'Ryan',     label: 'Ryan 甜茶',        desc: '戏感炸裂' },
  { id: 'Katerina', label: 'Katerina 卡捷琳娜',desc: '御姐音色' },
  { id: 'Elias',    label: 'Elias 墨讲师',     desc: '知识讲解' },
  { id: 'Jada',     label: 'Jada 上海-阿珍',   desc: '沪上阿姐' },
  { id: 'Dylan',    label: 'Dylan 北京-晓东',  desc: '胡同少年' },
  { id: 'Sunny',    label: 'Sunny 四川-晴儿',  desc: '甜心川妹子' },
  { id: 'Eric',     label: 'Eric 四川-程川',   desc: '成都男子' },
  { id: 'Peter',    label: 'Peter 天津-李彼得',desc: '相声捧人' },
  { id: 'Marcus',   label: 'Marcus 陕西-秦川', desc: '老陕' },
  { id: 'Roy',      label: 'Roy 闽南-阿杰',    desc: '台湾哥仔' },
  { id: 'Rocky',    label: 'Rocky 粤语-阿强',  desc: '幽默风趣' },
  { id: 'Kiki',     label: 'Kiki 粤语-阿清',   desc: '港妹闺蜜' },
  { id: 'li',       label: 'li 南京-老李',     desc: '瑜伽老师' },
];

interface PipelineStep {
  step: string;
  status: 'waiting' | 'running' | 'done' | 'error';
  message: string;
}

const AiScriptEditor: React.FC = () => {
  const materials = useMaterialsStore((s) => s.materials);
  const readyMaterials = materials.filter(
    (m: AnyMaterial) => m.type === 'video' && m.status === 'ready'
  );

  // Shared editing state
  const {
    apiKey, setApiKey,
    script, setScript,
    voice, setVoice,
    timeline, setTimeline,
    outputPath, setOutputPath,
    running, setRunning,
    audioDuration, setAudioDuration,
    audioPath, setAudioPath,
    speechSpeed, setSpeechSpeed,
    subtitleFont, subtitleFontPath, subtitleColor, subtitleSize,
    subtitleStrokeColor, subtitleStrokeWidth,
    subtitleOverrides,
  } = useEditingStore();

  // Local-only state (UI progress/results, not shared across steps)
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /** Scene data collected from video analysis */
  interface SceneInfo {
    description: string;
    video_path: string;
    start: number;
    end: number;
    duration: number;
  }

  /** Preview a voice by generating a short TTS sample */
  const handlePreviewVoice = useCallback(async (voiceId: string): Promise<void> => {
    if (previewingVoice) return;
    setPreviewingVoice(voiceId);
    try {
      const resp = await fetch('http://127.0.0.1:18000/api/ai-editing/preview-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: voiceId, api_key: apiKey, speed: speechSpeed }),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(errText || `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      if (audioRef.current) {
        audioRef.current.src = url;
        audioRef.current.play();
      }
    } catch (err) {
      console.error('Preview error:', err);
    } finally {
      setPreviewingVoice(null);
    }
  }, [previewingVoice]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!script.trim()) return;
    if (readyMaterials.length === 0) {
      setError('请先在步骤1中导入视频素材');
      return;
    }

    setRunning(true);
    setError(null);
    setOutputPath(null);
    setTimeline([]);
    setSteps([
      { step: 'script_analysis', status: 'running', message: 'AI分析文案...' },
      { step: 'video_analysis', status: 'waiting', message: '分析视频画面...' },
      { step: 'scene_matching', status: 'waiting', message: 'AI匹配画面...' },
    ]);

    const updateStep = (stepName: string, status: PipelineStep['status'], message: string) => {
      setSteps((prev) =>
        prev.map((s) => (s.step === stepName ? { ...s, status, message } : s))
      );
    };

    try {
      // ── Step 1: Analyze script ──
      updateStep('script_analysis', 'running', '正在用AI分析文案...');
      const scriptResp = await api.post('/api/ai-editing/analyze-script', {
        script: script.trim(),
        api_key: apiKey,
      });
      if (scriptResp.code !== 0) {
        updateStep('script_analysis', 'error', scriptResp.message);
        setError(scriptResp.message);
        setRunning(false);
        return;
      }
      const segments = (scriptResp.data as Record<string, unknown>)?.segments as Array<Record<string, unknown>>;
      updateStep('script_analysis', 'done', `已拆分为 ${segments?.length || 0} 个片段`);

      // ── Step 2: Analyze videos → collect full scene data ──
      updateStep('video_analysis', 'running', '正在用AI分析视频画面...');
      const videoPaths = readyMaterials.map((m: AnyMaterial) => m.filePath).filter(Boolean) as string[];
      const allScenes: SceneInfo[] = [];

      for (let vi = 0; vi < videoPaths.length; vi++) {
        const vp = videoPaths[vi];
        updateStep('video_analysis', 'running', `分析视频 ${vi + 1}/${videoPaths.length}...`);
        const vidResp = await api.post('/api/ai-editing/analyze-video', {
          file_path: vp,
          api_key: apiKey,
        });
        if (vidResp.code === 0 && vidResp.data) {
          const d = vidResp.data as Record<string, unknown>;
          const scenes = (d.scenes || []) as Array<Record<string, unknown>>;
          const descriptions = (d.descriptions || []) as string[];
          const videoPath = (d.video_path as string) || vp;

          for (let si = 0; si < scenes.length; si++) {
            const sc = scenes[si];
            allScenes.push({
              description: descriptions[si] || `场景${si + 1}`,
              video_path: videoPath,
              start: (sc.start as number) || 0,
              end: (sc.end as number) || 5,
              duration: (sc.duration as number) || 5,
            });
          }
        }
      }
      updateStep('video_analysis', 'done', `分析了 ${videoPaths.length} 个视频，共 ${allScenes.length} 个场景`);

      if (allScenes.length === 0) {
        updateStep('video_analysis', 'error', '未能提取有效场景');
        setError('视频分析失败：未能提取有效的视频场景');
        setRunning(false);
        return;
      }

      // ── Step 3: Match scenes with full scene data ──
      updateStep('scene_matching', 'running', '正在用AI匹配画面...');
      const matchResp = await api.post('/api/ai-editing/match-scenes', {
        segments,
        scenes: allScenes,
        api_key: apiKey,
      });
      if (matchResp.code !== 0) {
        updateStep('scene_matching', 'error', matchResp.message);
        setError(matchResp.message);
        setRunning(false);
        return;
      }

      const matchedTimeline = ((matchResp.data as Record<string, unknown>)?.timeline || []) as TimelineSegment[];
      setTimeline(matchedTimeline);
      updateStep('scene_matching', 'done', `已匹配 ${matchedTimeline.length} 个画面片段`);

      // ── Step 4: Generate TTS and sync durations ──
      updateStep('scene_matching', 'running', '正在生成口播音轨...');
      try {
        const ttsResp = await api.post('/api/ai-editing/generate-tts', {
          script: script.trim(),
          voice,
          api_key: apiKey,
          speed: speechSpeed,
        });
        if (ttsResp.code === 0 && ttsResp.data) {
          const ttsData = ttsResp.data as Record<string, unknown>;
          const ttsDuration = (ttsData.duration as number) || 15;
          setAudioDuration(ttsDuration);
          setAudioPath((ttsData.audio_path as string) || null);

          // Scale all segment durations to match TTS audio length
          const totalTLDur = matchedTimeline.reduce(
            (a: number, s: TimelineSegment) => a + (s.duration || 0), 0
          );
          if (totalTLDur > 0) {
            const scale = ttsDuration / totalTLDur;
            const scaledTimeline = matchedTimeline.map((s: TimelineSegment) => ({
              ...s,
              duration: Math.max(0.5, parseFloat((s.duration * scale).toFixed(1))),
            }));
            setTimeline(scaledTimeline);
          }
          updateStep('scene_matching', 'done',
            `已匹配 ${matchedTimeline.length} 个片段，口播时长 ${ttsDuration.toFixed(1)}s`
          );
        } else {
          updateStep('scene_matching', 'done',
            `已匹配 ${matchedTimeline.length} 个片段（TTS 生成失败，使用估算时长）`
          );
        }
      } catch {
        updateStep('scene_matching', 'done',
          `已匹配 ${matchedTimeline.length} 个片段（TTS 生成失败，使用估算时长）`
        );
      }

      setRunning(false);
    } catch (err) {
      const msg = `执行失败: ${(err as Error).message}`;
      setError(msg);
      setSteps((prev) =>
        prev.map((s) => ({
          ...s,
          status: s.status === 'running' ? ('error' as const) : s.status,
          message: s.status === 'running' ? msg.substring(0, 50) : s.message,
        }))
      );
      setRunning(false);
    }
  }, [script, voice, readyMaterials]);

  /** Render the final video from the generated timeline */
  const handleRender = useCallback(async (): Promise<void> => {
    if (timeline.length === 0) {
      setError('没有可导出的时间线，请先运行 AI 创作');
      return;
    }

    setRunning(true);
    setError(null);
    setOutputPath(null);
    setSteps([
      { step: 'tts', status: 'running', message: '生成口播音轨...' },
      { step: 'composite', status: 'waiting', message: '合成视频...' },
    ]);

    const updateStep = (stepName: string, status: PipelineStep['status'], message: string) => {
      setSteps((prev) =>
        prev.map((s) => (s.step === stepName ? { ...s, status, message } : s))
      );
    };

    try {
      updateStep('tts', 'running', '正在生成口播音轨...');
      const outputName = `ai_edit_${Date.now()}`;
      const compResp = await api.post('/api/ai-editing/composite', {
        segments: timeline.map((t: TimelineSegment, i: number) => ({
          video_path: t.video_path,
          start_time: t.start_time,
          duration: t.duration,
          segment_text: (subtitleOverrides[i]?.text) ?? t.segment_text,
          subtitle_x: subtitleOverrides[i]?.x,
          subtitle_y: subtitleOverrides[i]?.y,
        })),
        script: script.trim(),
        voice,
        output_name: outputName,
        api_key: apiKey,
        audio_path: audioPath || '',
        speed: speechSpeed,
        subtitle_style: {
          font: subtitleFont,
          font_path: subtitleFontPath,
          color: subtitleColor,
          size: subtitleSize,
          stroke_color: subtitleStrokeColor,
          stroke_width: subtitleStrokeWidth,
        },
      });

      if (compResp.code !== 0) {
        updateStep('composite', 'error', compResp.message);
        setError(compResp.message);
        setRunning(false);
        return;
      }

      const outputPathVal = (compResp.data as Record<string, unknown>)?.output_path as string;
      updateStep('tts', 'done', '口播音轨已生成');
      updateStep('composite', 'done', '视频合成完成');
      setOutputPath(outputPathVal);
      setRunning(false);
    } catch (err) {
      setError(`导出失败: ${(err as Error).message}`);
      setRunning(false);
    }
  }, [timeline, script, voice]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Header */}
      <Box sx={{ textAlign: 'center' }}>
        <AutoAwesomeIcon sx={{ fontSize: 40, color: 'primary.main', mb: 1 }} />
        <Typography variant="h6" gutterBottom>
          AI 口播剪辑
        </Typography>
        <Typography variant="body2" color="text.secondary">
          输入文案 → 选择音色 → AI 自动匹配画面 → 一键出片
        </Typography>
      </Box>

      {/* API Key */}
      <Paper elevation={0} sx={{ p: 2, bgcolor: 'warning.50', border: 1, borderColor: 'warning.200' }}>
        <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <VpnKeyIcon fontSize="small" color="warning" /> API 配置
        </Typography>
        <TextField
          size="small"
          fullWidth
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="输入你的 API Key（如 geekai.co 的 Key）"
          disabled={running}
          helperText="当前模型: gpt-5.5 / gpt-4o-mini-tts · 留空则使用后端环境变量中的 Key"
          inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
        />
      </Paper>

      {/* Script Input */}
      <Paper elevation={0} sx={{ p: 3, bgcolor: 'grey.50' }}>
        <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <RecordVoiceOverIcon fontSize="small" color="primary" />
          口播文案（15秒约150-200字）
        </Typography>
        <TextField
          multiline
          rows={4}
          fullWidth
          placeholder="输入你的口播文案，例如：&#10;&#10;大家好，今天给大家介绍这款新产品的三大亮点。首先，它的外观设计非常惊艳，采用了全新的材质和工艺。其次，性能方面有了大幅提升，搭载了最新一代处理器。最后，续航能力也突破性增长，让你一整天不用充电。快来体验吧！"
          value={script}
          onChange={(e) => setScript(e.target.value)}
          disabled={running}
          sx={{ mb: 2 }}
          inputProps={{ maxLength: 500 }}
        />
        <Typography variant="caption" color="text.secondary">
          {script.length}/500 字（约 {Math.round(script.length / 5)} 秒口播）
        </Typography>
      </Paper>

      {/* Voice Selection */}
      <Paper elevation={0} sx={{ p: 3, bgcolor: 'grey.50' }}>
        <Typography variant="subtitle2" gutterBottom>
          选择朗读音色
        </Typography>
        {/* Speed slider */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2, px: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40 }}>
            语速
          </Typography>
          <Slider
            size="small"
            value={speechSpeed}
            min={0.5}
            max={2.0}
            step={0.1}
            marks={[
              { value: 0.5, label: '0.5x' },
              { value: 1.0, label: '1x' },
              { value: 1.5, label: '1.5x' },
              { value: 2.0, label: '2x' },
            ]}
            onChange={(_e, v) => setSpeechSpeed(v as number)}
            sx={{ flex: 1, maxWidth: 300 }}
          />
          <Chip label={`${speechSpeed.toFixed(1)}x`} size="small" />
        </Box>
        <Grid container spacing={1.5}>
          {VOICES.map((v) => (
            <Grid item xs={6} sm={4} md={2} key={v.id}>
              <Card
                sx={{
                  cursor: 'pointer',
                  border: voice === v.id ? 2 : 1,
                  borderColor: voice === v.id ? 'primary.main' : 'grey.200',
                  bgcolor: voice === v.id ? 'primary.50' : 'white',
                }}
                onClick={() => setVoice(v.id)}
              >
                <CardContent sx={{ p: 1.5, textAlign: 'center', '&:last-child': { pb: 1.5 } }}>
                  <RecordVoiceOverIcon
                    color={voice === v.id ? 'primary' : 'action'}
                    fontSize="small"
                  />
                  <Typography variant="body2" fontWeight={voice === v.id ? 700 : 400}>
                    {v.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {v.desc}
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<VolumeUpIcon fontSize="small" />}
                    onClick={(e) => { e.stopPropagation(); handlePreviewVoice(v.id); }}
                    disabled={previewingVoice === v.id}
                    sx={{ mt: 0.5, minWidth: 0, fontSize: '0.7rem' }}
                  >
                    {previewingVoice === v.id ? '加载中' : '试听'}
                  </Button>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Paper>

      {/* Action */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
        <Button
          variant="contained"
          size="large"
          startIcon={running ? undefined : <AutoAwesomeIcon />}
          onClick={handleRun}
          disabled={running || !script.trim() || readyMaterials.length === 0}
          sx={{ px: 4, py: 1.5 }}
        >
          {running ? 'AI 剪辑中...' : '开始 AI 剪辑'}
        </Button>
      </Box>

      {/* Available materials hint */}
      <Box sx={{ textAlign: 'center' }}>
        <Chip
          icon={<VideoLibraryIcon />}
          label={`可用视频素材: ${readyMaterials.length} 个`}
          variant="outlined"
          color={readyMaterials.length > 0 ? 'success' : 'default'}
          size="small"
        />
      </Box>

      {/* Progress */}
      {steps.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, bgcolor: 'grey.50' }}>
          <Typography variant="subtitle2" gutterBottom>
            处理进度
          </Typography>
          {steps.map((s) => (
            <Box key={s.step} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              {s.status === 'done' ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : s.status === 'running' ? (
                <PlayArrowIcon color="primary" fontSize="small" />
              ) : s.status === 'error' ? (
                <CheckCircleIcon color="error" fontSize="small" />
              ) : (
                <CheckCircleIcon color="disabled" fontSize="small" />
              )}
              <Typography variant="body2" color={s.status === 'running' ? 'primary' : 'text.secondary'}>
                {s.message}
              </Typography>
            </Box>
          ))}
          {running && <LinearProgress sx={{ mt: 1 }} />}
        </Paper>
      )}

      {/* Error */}
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Timeline Preview (after AI matching) */}
      {timeline.length > 0 && !outputPath && (
        <Paper elevation={0} sx={{ p: 3, bgcolor: 'success.50', border: 1, borderColor: 'success.main' }}>
          <Typography variant="subtitle1" gutterBottom color="success.main" fontWeight={700}>
            时间线已生成 {timeline.length} 个片段，可前往步骤 3 预览调整
          </Typography>
          {timeline.map((seg: TimelineSegment, i: number) => (
            <Box key={i} sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'flex-start' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 40 }}>
                #{i + 1}
              </Typography>
              <Box>
                <Typography variant="body2">{seg.segment_text}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {seg.video_path.split(/[\\/]/).pop()} · {seg.duration.toFixed(1)}s · {seg.reason}
                </Typography>
              </Box>
            </Box>
          ))}
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2, gap: 2 }}>
            <Button
              variant="contained"
              color="success"
              size="large"
              startIcon={running ? undefined : <MovieIcon />}
              onClick={handleRender}
              disabled={running}
              sx={{ px: 4, py: 1.5 }}
            >
              {running ? '导出中...' : '导出视频'}
            </Button>
          </Box>
        </Paper>
      )}

      {/* Output */}
      {outputPath && (
        <Alert severity="success" icon={<MovieIcon />}>
          视频已生成！可在步骤 4「导出渲染」中查看和下载
        </Alert>
      )}
      {/* Hidden audio element for voice preview */}
      <audio ref={audioRef} style={{ display: 'none' }} />
    </Box>
  );
};

export default AiScriptEditor;
