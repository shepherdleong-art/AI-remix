/**
 * AI Script Editor component.
 *
 * Replaces the "智能分析" step. User inputs narration text,
 * selects TTS voice, and triggers the AI editing pipeline:
 * text → voice → scene match → composite → output.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Autocomplete,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ReplayIcon from '@mui/icons-material/Replay';
import SendIcon from '@mui/icons-material/Send';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import MovieIcon from '@mui/icons-material/Movie';
import ErrorIcon from '@mui/icons-material/Error';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import { useEditingStore, TimelineSegment, TtsProvider, computePreviewDims } from '@/renderer/store/editing-store';
import type { AnyMaterial } from '@/renderer/types/material';
import api, { getBackendBaseUrl } from '@/renderer/api/backend-client';

/**
 * 当 split-tts 失败（如 TTS Key 错误 / 网络问题）时，依据口播文案长度估算每段时长，
 * 让匹配环节仍可继续（音频缺失时成片无配音，但画面匹配不中断）。
 * 经验值：约 0.22s / 字，下限 1.0s，四舍五入到 0.1s。
 */
function estimateSegDurations(segs: Array<Record<string, unknown>>): number[] {
  return segs.map((s) => {
    const t = ((s.text as string) || (s.segment_text as string) || '').trim();
    const chars = Math.max(1, t.length);
    return Math.max(1.0, Math.round(chars * 0.22 * 10) / 10);
  });
}

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

/** 音色项（字段与后端 /voices 返回一致：{id, name, gender?}）。 */
interface VoiceOption { id: string; name: string; gender?: string; }
// 后端不可达时的兜底音色（仅 qwen）；正常情况由 useEffect 从 /voices 动态加载
const FALLBACK_VOICES: VoiceOption[] = VOICES.map((v) => ({ id: v.id, name: v.label }));

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
    analysisModel, setAnalysisModel,
    analysisApiKey, setAnalysisApiKey,
    ttsProvider, setTtsProvider,
    ttsApiKeys, setTtsApiKey,
    script, setScript,
    voice, setVoice,
    timeline, setTimeline,
    outputPath, setOutputPath,
    running, setRunning,
    audioDuration, setAudioDuration,
    audioPath, setAudioPath,
    speechSpeed, setSpeechSpeed,
    bumpAudioVersion,
    videoAspect,
    subtitleFont, subtitleFontPath, subtitleColor, subtitleSize,
    subtitleStrokeColor, subtitleStrokeWidth,
    subtitleOverrides,
  } = useEditingStore();

  // Local-only state (UI progress/results, not shared across steps)
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewingVoice, setPreviewingVoice] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 空 key 软校验：点动作时若对应 key 为空 → 红字提示 + 滚动到该输入区（状态在 store，由右栏 ApiKeyConfigPanel 渲染）
  const analysisKeyError = useEditingStore((s) => s.analysisKeyError);
  const ttsKeyError = useEditingStore((s) => s.ttsKeyError);
  const setAnalysisKeyError = useEditingStore((s) => s.setAnalysisKeyError);
  const setTtsKeyError = useEditingStore((s) => s.setTtsKeyError);

  // #1 取消：持有 AbortController 与已取消标志
  const abortRef = useRef<AbortController | null>(null);
  const abortedRef = useRef<boolean>(false);
  const [cancelled, setCancelled] = useState<boolean>(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // #5 进度：基于已完成阶段数算 determinate 进度条
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const hasRunning = steps.some((s) => s.status === 'running');
  const progressValue =
    steps.length === 0
      ? 0
      : Math.min(100, Math.round((doneCount / steps.length) * 100 + (hasRunning ? (100 / steps.length) * 0.5 : 0)));
  const currentStepMessage = steps.find((s) => s.status === 'running')?.message ?? '';

  // 动态音色列表（按服务商从后端 /voices 加载；兜底为 qwen 静态列表）
  const [voices, setVoices] = useState<VoiceOption[]>(FALLBACK_VOICES);
  const [voicesLoading, setVoicesLoading] = useState<boolean>(false);

  /** 按服务商动态加载音色；切换服务商时若当前音色不在新列表则重置为首个。 */
  const loadVoices = useCallback(async (provider: string): Promise<void> => {
    setVoicesLoading(true);
    try {
      const baseUrl: string = await getBackendBaseUrl();
      const resp = await fetch(`${baseUrl}/api/ai-editing/voices?provider=${encodeURIComponent(provider)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      const vs = ((data?.data?.voices) || data?.voices || []) as VoiceOption[];
      if (vs.length) {
        setVoices(vs);
        const cur = useEditingStore.getState().voice;
        // 豆包音色列表已含 2.0 全部音色（默认首位 Uranus 为实测可用项）。
        // 若当前选中音色不在新列表（如旧版 localStorage 残留的经典音色），
        // 重置为列表首位（Uranus），避免卡在不可用音色上。
        const DOUBAO_DEFAULT = 'zh_female_vv_uranus_bigtts';
        if (!vs.some((v) => v.id === cur)) {
          setVoice(vs[0]?.id ?? DOUBAO_DEFAULT);
        }
      }
    } catch {
      /* 后端不可达则保持兜底列表 */
    } finally {
      setVoicesLoading(false);
    }
  }, [setVoice]);

  // 服务商变化时刷新音色（含首次挂载加载 qwen）
  useEffect(() => { loadVoices(ttsProvider); }, [ttsProvider, loadVoices]);

  // ── 音色展示：两行精选常驻 + 下拉（全部，可搜索 / 按性别筛选） ──
  const [voiceGender, setVoiceGender] = useState<'all' | 'female' | 'male'>('all');
  const [voiceQuery, setVoiceQuery] = useState('');
  // 按名字关键词挑常用音色（不硬编码 ID，避免与后端目录对不上）；不足 12 则用剩余补齐
  const RECOMMENDED_KEYWORDS = [
    'Uranus', 'Vivi', '小何', '云舟', '甜美桃子', '擎苍', '猴哥', '清新',
    '小美', '云希', '米朵', '云健', 'Cherry', 'Katerina', 'Ryan', 'Jada', 'Sunny',
  ];
  const recommended = useMemo(() => {
    const hit = voices.filter((v) => RECOMMENDED_KEYWORDS.some((k) => v.name.includes(k)));
    const rest = voices.filter((v) => !hit.includes(v));
    return [...hit, ...rest].slice(0, 12);
  }, [voices]);
  // 性别筛选只作用于下拉框（两行精选始终可见）
  const genderFiltered = useMemo(
    () => voices.filter((v) => voiceGender === 'all' || v.gender === voiceGender),
    [voices, voiceGender]
  );
  const currentVoice = voices.find((v) => v.id === voice) || null;

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
    // 软校验：语音 key 为空 → 提示（store 状态 → 右栏红框）
    if (!(ttsApiKeys[ttsProvider] || '').trim()) {
      setTtsKeyError(true);
      return;
    }
    setPreviewingVoice(voiceId);
    try {
      const baseUrl: string = await getBackendBaseUrl();
      const resp = await fetch(`${baseUrl}/api/ai-editing/preview-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: voiceId, api_key: ttsApiKeys[ttsProvider], speed: speechSpeed, provider: ttsProvider }),
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
  }, [previewingVoice, ttsProvider, ttsApiKeys, speechSpeed, setTtsKeyError]);

  const handleRun = useCallback(async (): Promise<void> => {
    if (!script.trim()) return;
    if (readyMaterials.length === 0) {
      setError('请先在步骤1中导入视频素材');
      return;
    }

    // 软校验：key 为空 → 红字提示（store 状态 → 右栏 ApiKeyConfigPanel 渲染红框）
    if (!analysisApiKey.trim()) {
      setAnalysisKeyError(true);
      setError('请先填写「画面分析」的 API Key');
      return;
    }
    if (!(ttsApiKeys[ttsProvider] || '').trim()) {
      setTtsKeyError(true);
      setError('请先填写「语音合成」的 API Key');
      return;
    }

    setRunning(true);
    setError(null);
    setOutputPath(null);
    setTimeline([]);
    abortedRef.current = false;
    setCancelled(false);
    setElapsed(0);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    setSteps([
      { step: 'script_analysis', status: 'running', message: 'AI分析文案...' },
      { step: 'video_analysis', status: 'waiting', message: '分析视频画面...' },
      { step: 'tts', status: 'waiting', message: '逐段生成口播音轨...' },
      { step: 'scene_matching', status: 'waiting', message: '基于真实口播时长智能匹配...' },
    ]);

    const updateStep = (stepName: string, status: PipelineStep['status'], message: string) => {
      setSteps((prev) =>
        prev.map((s) => (s.step === stepName ? { ...s, status, message } : s))
      );
    };

    // LLM-intensive API calls can easily exceed the default 30 s timeout;
    // use a generous 120 s to avoid false-positive "signal is aborted" errors.
    const LLM_TIMEOUT = { timeout: 120_000 };

    // Helper: run async tasks in concurrent batches.
    const runBatched = async <T, R>(
      items: T[], fn: (item: T, idx: number) => Promise<R>, concurrency: number,
    ): Promise<R[]> => {
      const results: R[] = [];
      for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          batch.map((item, bi) => fn(item, i + bi)),
        );
        results.push(...batchResults);
      }
      return results;
    };

    const cancelCleanup = (): void => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRunning(false);
      setCancelled(true);
      setError(null);
      setSteps((prev) =>
        prev.map((s) => (s.status === 'running' ? { ...s, status: 'waiting' as const } : s)),
      );
    };

    try {
      // ── Phase 1: 文案分析 + 画面分析 同时启动（互不依赖） ──
      updateStep('script_analysis', 'running', '正在用AI分析文案...');
      updateStep('video_analysis', 'running', '正在用AI分析视频画面...');

      const videoPaths = readyMaterials.map((m: AnyMaterial) => m.filePath).filter(Boolean) as string[];

      // Script analysis (independent, runs in parallel with video analysis)
      const scriptPromise = api.post('/api/ai-editing/analyze-script', {
        script: script.trim(),
        api_key: analysisApiKey,
        model: analysisModel,
      }, { ...LLM_TIMEOUT, signal: ctrl.signal });

      // Video analysis — concurrent batches of 5 (no rate limits on api.v3.cm)
      const videoPromise = runBatched(
        videoPaths, async (vp: string, idx: number) => {
          updateStep('video_analysis', 'running', `分析视频 ${idx + 1}/${videoPaths.length}...`);
          const vidResp = await api.post('/api/ai-editing/analyze-video', {
            file_path: vp,
            api_key: analysisApiKey,
            model: analysisModel,
          }, { ...LLM_TIMEOUT, signal: ctrl.signal });
          if (vidResp.code === 0 && vidResp.data) {
            const d = vidResp.data as Record<string, unknown>;
            const scenes = (d.scenes || []) as Array<Record<string, unknown>>;
            const descriptions = (d.descriptions || []) as string[];
            const videoPath = (d.video_path as string) || vp;
            const collected: SceneInfo[] = [];
            for (let si = 0; si < scenes.length; si++) {
              const sc = scenes[si];
              collected.push({
                description: descriptions[si] || `场景${si + 1}`,
                video_path: videoPath,
                start: (sc.start as number) || 0,
                end: (sc.end as number) || 5,
                duration: (sc.duration as number) || 5,
              });
            }
            return collected;
          }
          return [] as SceneInfo[];
        }, 5,  // 5 concurrent videos per batch
      );

      // Wait for both: script segments + all video scenes
      const [scriptResp, allScenesNested] = await Promise.all([scriptPromise, videoPromise]);
      const allScenes: SceneInfo[] = allScenesNested.flat();

      if (abortedRef.current) { cancelCleanup(); return; }
      if (scriptResp.code !== 0) {
        updateStep('script_analysis', 'error', scriptResp.message);
        setError(scriptResp.message);
        setRunning(false);
        return;
      }
      const segments = (scriptResp.data as Record<string, unknown>)?.segments as Array<Record<string, unknown>>;
      updateStep('script_analysis', 'done', `已拆分为 ${segments?.length || 0} 个片段`);
      updateStep('video_analysis', 'done', `分析了 ${videoPaths.length} 个视频，共 ${allScenes.length} 个场景`);

      if (abortedRef.current) { cancelCleanup(); return; }
      if (allScenes.length === 0) {
        updateStep('video_analysis', 'error', '未能提取有效场景');
        setError('视频分析失败：未能提取有效的视频场景');
        setRunning(false);
        return;
      }

      // ── Phase 2: 口播TTS（依赖 segments，与 Phase 1 无重叠所以紧随其后） ──
      updateStep('tts', 'running', '正在逐段生成口播音轨（前置）...');
      const ttsResp = await api.post('/api/ai-editing/split-tts', {
        segments: segments.map((s: Record<string, unknown>) => ({
          text: (s.text as string) || (s.segment_text as string) || '',
        })),
        voice,
        api_key: ttsApiKeys[ttsProvider],
        speed: speechSpeed,
        provider: ttsProvider,
      }, { timeout: 120_000, signal: ctrl.signal });

      // 透传 split-tts 的真实时长与音频路径给后续匹配 / 合成
      let segDurations: number[] = [];
      let audioPathVal: string | null = null;
      if (ttsResp.code === 0 && ttsResp.data) {
        const ttsData = ttsResp.data as Record<string, unknown>;
        segDurations = (ttsData.seg_durations || []) as number[];
        audioPathVal = (ttsData.audio_path as string) || null;
        setAudioDuration((ttsData.total_duration as number) || 15);
        setAudioPath(audioPathVal);
        // 口播音频已更新：自增版本号，强制步骤3丢弃旧语音缓存（后端同路径覆盖时前端无感知）
        bumpAudioVersion();
        updateStep('tts', 'done', `口播总时长 ${(ttsData.total_duration as number || 0).toFixed(1)}s`);
      } else {
        const reason = (ttsResp.message as string) || '未知错误';
        segDurations = estimateSegDurations(segments);
        audioPathVal = null;
        setAudioPath(null);
        const estTotal = segDurations.reduce((a, b) => a + b, 0);
        setAudioDuration(estTotal || 15);
        updateStep('tts', 'done', 'TTS 生成失败，已用估算时长继续（成片无配音）');
        setError(`语音合成失败，已用估算时长继续匹配（成片将无配音）。请检查「语音合成」API Key 是否正确。原因：${reason}`);
      }

      // ── Phase 3: 节拍检测 + 语义匹配 同时启动 ──
      let beatPoints: number[] | null = null;
      const beatPromise = (async () => {
        if (!audioPathVal) return null;
        try {
          const beatResp = await api.post('/api/ai-editing/detect-beats', { audio_path: audioPathVal });
          if (beatResp.code === 0 && beatResp.data) {
            const bd = beatResp.data as { fallback?: boolean; beats?: Array<{ time: number }> };
            if (!bd.fallback) {
              beatPoints = (bd.beats || []).map((b) => b.time);
              return beatPoints;
            }
          }
        } catch {
          // non-critical, silently fall back
        }
        return null;
      })();

      updateStep('scene_matching', 'running', '正在基于真实口播时长智能匹配...');
      const matchResp = await api.post('/api/ai-editing/match-scenes-v2', {
        segments,
        seg_durations: segDurations,
        scenes: allScenes,
        api_key: analysisApiKey,
        model: analysisModel,
        beat_points: beatPoints,
      }, { ...LLM_TIMEOUT, signal: ctrl.signal });

      // Harvest beat result (non-blocking — it already ran concurrently)
      await beatPromise;

      if (abortedRef.current) { cancelCleanup(); return; }
      if (matchResp.code !== 0) {
        updateStep('scene_matching', 'error', matchResp.message);
        setError(matchResp.message);
        setRunning(false);
        return;
      }

      const matchedTimeline = ((matchResp.data as Record<string, unknown>)?.timeline || []) as TimelineSegment[];
      setTimeline(matchedTimeline);
      // 步骤3预览预加热：后台提前触发 assemble（与 TimelineEditor 同一缓存 key），
      // 用户进入步骤3时直接命中缓存秒开。失败无妨，步骤3挂载时会自行再触发。
      void api.post('/api/preview/assemble', {
        timeline: matchedTimeline.map((s) => ({ video_path: s.video_path, start_time: s.start_time, duration: s.duration })),
        ...computePreviewDims(videoAspect), aspect: videoAspect,
      }, { timeout: 180_000 }).catch(() => {});
      const dbg = (matchResp.data as Record<string, unknown>)?.debug as Record<string, unknown> | undefined;
      const usedMsg = dbg ? `（已使用 ${dbg.used_materials}/${dbg.total_materials} 个素材）` : '';
      updateStep('scene_matching', 'done', `已基于真实口播时长匹配 ${matchedTimeline.length} 个片段${usedMsg}`);

      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setRunning(false);
    } catch (err) {
      if (abortedRef.current) { cancelCleanup(); return; }
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
  }, [script, voice, readyMaterials, ttsProvider, analysisApiKey, ttsApiKeys, speechSpeed, bumpAudioVersion, videoAspect, setAnalysisKeyError, setTtsKeyError]);

  const handleCancel = useCallback((): void => {
    abortedRef.current = true;
    abortRef.current?.abort();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRunning(false);
    setCancelled(true);
    setSteps((prev) =>
      prev.map((s) => (s.status === 'running' ? { ...s, status: 'waiting' as const } : s)),
    );
  }, [setRunning]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {/* Script Input — API Key 配置已移至右侧参数栏 */}
      <Paper elevation={0} sx={{ p: 3, bgcolor: 'background.paperAlt' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <RecordVoiceOverIcon fontSize="small" color="primary" />
            口播文案（15秒约150-200字）
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.7, letterSpacing: 0.3 }}>
            输入文案 → 选音色 → AI 匹配画面 → 出片
          </Typography>
        </Box>
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
      <Paper elevation={0} sx={{ p: 3, bgcolor: 'background.paperAlt' }}>
        <Typography variant="subtitle2" gutterBottom>
          选择朗读音色
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          当前服务商：{ttsProvider === 'doubao' ? '豆包 Doubao' : '千问 Qwen'}
          {voicesLoading ? '（音色加载中…）' : ''}
        </Typography>
        {ttsProvider === 'doubao' && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            豆包 2.0 共 {voices.length} 种音色（全部已验证可用，任选即可）。
          </Typography>
        )}
        {/* Speed slider */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 0.5, px: 1 }}>
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
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, px: 1 }}>
          语速越快，每段口播时长越短、匹配所需素材也越少；过快可能影响听感，建议保持在 0.9–1.1x。
        </Typography>
        {/* 精选常用：两行常驻卡片（保留试听 / 选中高亮） */}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          精选常用（点击卡片试听 / 选择）
        </Typography>
        <Grid container spacing={1.5}>
          {recommended.map((v) => (
            <Grid item xs={6} sm={4} md={2} key={v.id}>
              <Card
                sx={{
                  cursor: 'pointer',
                  border: voice === v.id ? 2 : 1,
                  borderColor: voice === v.id ? 'primary.main' : 'divider',
                  bgcolor: voice === v.id ? 'action.selected' : 'background.paper',
                }}
                onClick={() => setVoice(v.id)}
              >
                <CardContent sx={{ p: 1.5, textAlign: 'center', '&:last-child': { pb: 1.5 } }}>
                  <RecordVoiceOverIcon
                    color={voice === v.id ? 'primary' : 'action'}
                    fontSize="small"
                  />
                  <Typography variant="body2" fontWeight={voice === v.id ? 700 : 400}>
                    {v.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    {v.gender === 'female' ? '女声' : v.gender === 'male' ? '男声' : '音色'}
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

        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2, mb: 1 }}>
          更多音色：用「性别分类」仅筛选下方搜索框，上方精选卡片始终常驻；可输入关键词搜索全部音色。
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="voice-gender-label">性别分类</InputLabel>
            <Select
              labelId="voice-gender-label"
              value={voiceGender}
              label="性别分类"
              onChange={(e) => setVoiceGender(e.target.value as 'all' | 'female' | 'male')}
            >
              <MenuItem value="all">全部</MenuItem>
              <MenuItem value="female">女声</MenuItem>
              <MenuItem value="male">男声</MenuItem>
            </Select>
          </FormControl>
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <Autocomplete
              options={genderFiltered}
              value={currentVoice ?? null}
              inputValue={voiceQuery}
              onInputChange={(_e, v) => setVoiceQuery(v ?? '')}
              getOptionLabel={(v) => v.name}
              // 关键：输入框默认显示当前选中音色名，打开下拉时不应按它过滤——
              // 只有当用户主动输入了与选中名不同的内容才做筛选，否则展示全部（可滚动浏览）。
              filterOptions={(opts, state) => {
                const q = state.inputValue.trim().toLowerCase();
                const selLabel = (currentVoice?.name ?? '').toLowerCase();
                if (!q || q === selLabel) return opts;
                return opts.filter((o) => o.name.toLowerCase().includes(q));
              }}
              onChange={(_e, v) => { if (v) { setVoice(v.id); setVoiceQuery(v.name); } }}
              isOptionEqualToValue={(o, val) => (val ? o.id === val.id : false)}
              ListboxProps={{ style: { maxHeight: 260 } }}
              renderInput={(params) => (
                <TextField {...params} size="small" placeholder="搜索更多音色（可滚动）" />
              )}
              renderOption={(props, v) => (
                <li {...props} key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RecordVoiceOverIcon fontSize="small" style={{ opacity: 0.55 }} />
                  <span style={{ flex: 1 }}>{v.name}</span>
                  <Typography variant="caption" color="text.secondary">
                    {v.gender === 'female' ? '女声' : v.gender === 'male' ? '男声' : ''}
                  </Typography>
                </li>
              )}
              noOptionsText="无匹配音色"
            />
          </Box>
          <Button
            size="small"
            variant="outlined"
            startIcon={<VolumeUpIcon />}
            onClick={() => handlePreviewVoice(voice)}
            disabled={previewingVoice === voice}
          >
            {previewingVoice === voice ? '加载中' : '试听当前'}
          </Button>
        </Box>
        {currentVoice && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            当前选中：{currentVoice.name}（{currentVoice.gender === 'female' ? '女声' : currentVoice.gender === 'male' ? '男声' : '音色'}）
          </Typography>
        )}
      </Paper>

      {/* Action */}
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
        {running ? (
          <Button
            variant="outlined"
            color="inherit"
            size="large"
            startIcon={<CancelIcon />}
            onClick={handleCancel}
            sx={{ px: 4, py: 1.5 }}
          >
            取消生成
          </Button>
        ) : (
          <Button
            variant="contained"
            size="large"
            startIcon={cancelled ? <ReplayIcon /> : <AutoAwesomeIcon />}
            onClick={handleRun}
            disabled={!script.trim() || readyMaterials.length === 0}
            sx={{ px: 4, py: 1.5 }}
          >
            {cancelled ? '重新生成' : '开始 AI 剪辑'}
          </Button>
        )}
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

      {/* Progress (#5 determinate bar + #1 cancel banner + A1 icon fix) */}
      {steps.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, bgcolor: 'background.paperAlt', borderRadius: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Typography variant="subtitle2">处理进度</Typography>
            {running && (
              <Typography variant="caption" color="text.secondary">
                {currentStepMessage} · 已用时 {elapsed}s
              </Typography>
            )}
          </Box>
          <LinearProgress
            variant="determinate"
            value={progressValue}
            sx={{ mb: 1.5, borderRadius: 999, height: 6, '& .MuiLinearProgress-bar': { borderRadius: 999 } }}
          />
          {steps.map((s) => (
            <Box key={s.step} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}>
              {s.status === 'done' ? (
                <CheckCircleIcon color="success" fontSize="small" />
              ) : s.status === 'running' ? (
                <PlayArrowIcon color="primary" fontSize="small" />
              ) : s.status === 'error' ? (
                <ErrorIcon color="error" fontSize="small" />
              ) : (
                <CheckCircleIcon color="disabled" fontSize="small" />
              )}
              <Typography
                variant="body2"
                color={s.status === 'running' ? 'primary' : s.status === 'error' ? 'error.main' : 'text.secondary'}
              >
                {s.message}
              </Typography>
            </Box>
          ))}
          {cancelled && !running && (
            <Alert severity="info" sx={{ mt: 1 }} onClose={() => setCancelled(false)}>
              已取消生成，可重新点击「开始 AI 剪辑」。
            </Alert>
          )}
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
        <Paper elevation={0} sx={{ p: 3, bgcolor: 'rgba(52,199,89,0.10)', border: 1, borderColor: 'success.main' }}>
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
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
            <Alert severity="info" sx={{ maxWidth: 500 }}>
              画面匹配完成！请点击下方「下一步」进入<strong>步骤 3「预览调整」</strong>编辑字幕样式，再前往步骤 4 导出成片。
            </Alert>
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
