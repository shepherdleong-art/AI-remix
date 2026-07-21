import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box, Typography, Chip, Divider, Stack,
  TextField, FormControl, InputLabel, Select, MenuItem,
  Button, CircularProgress, Slider, Paper, IconButton,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import SubtitlesIcon from '@mui/icons-material/Subtitles';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import MovieIcon from '@mui/icons-material/Movie';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import ImageIcon from '@mui/icons-material/Image';
import { useTheme } from '@mui/material';
import { Panel } from './Panel';
import { useEditingStore, TtsProvider } from '@/renderer/store/editing-store';
import { getBackendBaseUrl } from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import FontSelect from '@/renderer/components/common/FontSelect';
import CoverDrawer from '@/renderer/components/analysis/CoverDrawer';
import type { CoverDraft } from '@/renderer/components/analysis/TimelineEditor';

/** 画面分析可选模型（下拉预设） */
const PRESET_ANALYSIS_MODELS = ['gpt-5.5', 'gpt-4o', 'gpt-4o-mini'];

/* ── Step 1: 导入说明 ───────────────────────────────── */
const StepImportRight: React.FC = () => (
  <Panel title="导入说明">
    <Stack spacing={1.25}>
      <Typography variant="body2" color="text.secondary">
        支持拖拽文件到左侧区域，或点击「导入素材」按钮选择视频 / 图片。
      </Typography>
      <Box>
        <Typography variant="caption" color="text.secondary" display="block" gutterBottom>
          支持格式
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {['MP4', 'MOV', 'AVI', 'WebM', 'JPG', 'PNG'].map((f) => (
            <Chip key={f} label={f} size="small" variant="outlined" />
          ))}
        </Box>
      </Box>
      <Divider />
      <Typography variant="caption" color="text.secondary">
        提示：素材越多，AI 匹配的可选片段越丰富，成片越自然。
      </Typography>
    </Stack>
  </Panel>
);

/* ── Step 2: 完整 API Key 配置表单 ───────────────────── */
const StepAnalysisRight: React.FC = () => {
  const {
    analysisModel, setAnalysisModel,
    analysisApiKey, setAnalysisApiKey,
    ttsProvider, setTtsProvider,
    ttsApiKeys, setTtsApiKey,
    voice,
    running,
    analysisKeyError, setAnalysisKeyError,
    ttsKeyError, setTtsKeyError,
  } = useEditingStore();

  const analysisKeyRef = useRef<HTMLInputElement>(null);
  const ttsKeyRef = useRef<HTMLInputElement>(null);

  // TTS 测试连接状态（仅此组件内部使用）
  const [testingTts, setTestingTts] = useState(false);
  const [ttsTest, setTtsTest] = useState<{ ok: boolean; msg: string } | null>(null);

  const handleTestTts = useCallback(async (): Promise<void> => {
    if (testingTts) return;
    const key = (ttsApiKeys[ttsProvider] || '').trim();
    if (!key) {
      setTtsKeyError(true);
      ttsKeyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    setTestingTts(true);
    setTtsTest(null);
    const testVoice = ttsProvider === 'doubao' ? (voice || 'zh_female_vv_uranus_bigtts') : (voice || 'Cherry');
    try {
      const baseUrl: string = await getBackendBaseUrl();
      const resp = await fetch(`${baseUrl}/api/ai-editing/preview-voice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          voice: testVoice,
          text: '连接测试',
          api_key: key,
          speed: 1.0,
          provider: ttsProvider,
        }),
      });
      if (resp.ok) {
        setTtsTest({
          ok: true,
          msg: `连接成功（${ttsProvider === 'doubao' ? '豆包 Doubao' : '千问 Qwen'} 服务可达，Key 有效）`,
        });
      } else {
        let detail = `HTTP ${resp.status}`;
        try {
          const d = await resp.json();
          detail = (d?.detail || d?.message || detail) as string;
        } catch { /* 保持默认 */ }
        setTtsTest({ ok: false, msg: `连接失败：${detail}` });
      }
    } catch (err) {
      setTtsTest({ ok: false, msg: `连接错误：${(err as Error).message}` });
    } finally {
      setTestingTts(false);
    }
  }, [testingTts, ttsProvider, ttsApiKeys, voice, setTtsKeyError]);

  // 暴露给外部（handleRun）调用的 scroll-into-view 方法
  React.useEffect(() => {
    if (analysisKeyError) analysisKeyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (ttsKeyError) ttsKeyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [analysisKeyError, ttsKeyError]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', overflow: 'auto', pr: 0.5 }}>
      {/* ── 画面分析 API ── */}
      <PaperCustom title="画面分析 API" subtitle="AI 理解文案/视频" color="warning">
        <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
          <InputLabel id="ra-model-label">分析模型</InputLabel>
          <Select
            labelId="ra-model-label"
            label="分析模型"
            value={PRESET_ANALYSIS_MODELS.includes(analysisModel) ? analysisModel : '__custom'}
            onChange={(e) => {
              const v = e.target.value as string;
              if (v !== '__custom') setAnalysisModel(v);
            }}
            disabled={running}
          >
            {PRESET_ANALYSIS_MODELS.map((m) => (
              <MenuItem key={m} value={m}>{m}{m === 'gpt-5.5' ? '（默认）' : ''}</MenuItem>
            ))}
            <MenuItem value="__custom">自定义…</MenuItem>
          </Select>
        </FormControl>
        {!PRESET_ANALYSIS_MODELS.includes(analysisModel) && (
          <TextField
            size="small" fullWidth sx={{ mb: 1.5 }} label="自定义模型名"
            value={analysisModel} onChange={(e) => setAnalysisModel(e.target.value)}
            disabled={running}
            inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
          />
        )}
        <TextField
          size="small" fullWidth type="password"
          value={analysisApiKey}
          onChange={(e) => { setAnalysisApiKey(e.target.value); setAnalysisKeyError(false); }}
          placeholder="留空则使用后端环境变量中的 Key"
          disabled={running}
          error={analysisKeyError}
          helperText={analysisKeyError ? 'API Key 不能为空，请填写后重试' : '留空则使用后端环境变量中的 Key'}
          inputRef={analysisKeyRef}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
        />
      </PaperCustom>

      {/* ── 语音合成 API（TTS）── */}
      <PaperCustom title="语音合成 API" subtitle="TTS" color="info">
        <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
          <InputLabel id="ra-tts-label">TTS 服务商</InputLabel>
          <Select
            labelId="ra-tts-label" label="TTS 服务商"
            value={ttsProvider}
            onChange={(e) => setTtsProvider(e.target.value as TtsProvider)}
            disabled={running}
          >
            <MenuItem value="qwen">千问 Qwen（默认）</MenuItem>
            <MenuItem value="doubao">豆包 Doubao（火山引擎）</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small" fullWidth type="password"
          value={ttsApiKeys[ttsProvider] ?? ''}
          onChange={(e) => { setTtsApiKey(ttsProvider, e.target.value); setTtsKeyError(false); }}
          placeholder={ttsProvider === 'doubao' ? '输入豆包 API Key' : '输入千问 API Key'}
          disabled={running}
          error={ttsKeyError}
          helperText={ttsKeyError
            ? 'API Key 不能为空，请填写后重试'
            : (ttsProvider === 'doubao'
              ? '豆包：explicit_language=zh-cn 强制中文'
              : '千问：自动锚点锁定中文')}
          inputRef={ttsKeyRef}
          inputProps={{ style: { fontFamily: 'monospace', fontSize: '0.8rem' } }}
        />
        <Box sx={{ mt: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Button
            size="small" variant="outlined"
            color={ttsTest?.ok ? 'success' : 'info'}
            onClick={handleTestTts}
            disabled={running || testingTts}
            startIcon={testingTts ? <CircularProgress size={16} color="inherit" /> : <CheckCircleIcon />}
          >
            {testingTts ? '测试中…' : '测试连接'}
          </Button>
          {ttsTest && (
            <Typography
              variant="caption"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5,
                color: ttsTest.ok ? 'success.main' : 'error.main' }}
            >
              {ttsTest.ok ? <CheckCircleIcon fontSize="inherit" /> : <ErrorIcon fontSize="inherit" />}
              {ttsTest.msg}
            </Typography>
          )}
        </Box>
      </PaperCustom>
    </Box>
  );
}

/** 小卡片容器：用于右栏紧凑展示每个 API 区块 */
const PaperCustom: React.FC<{
  title: string; subtitle: string; color: 'warning' | 'info';
  children: React.ReactNode;
}> = ({ title, subtitle, color, children }) => (
  <Box
    sx={{
      p: 2,
      border: 1,
      borderColor: 'divider',
      borderRadius: 2,
      bgcolor: 'background.paper',
    }}
  >
    <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <VpnKeyIcon fontSize="small" color={color === 'warning' ? 'warning' : 'info'} />
      {title}
      <Typography variant="caption" color="text.secondary">（{subtitle}）</Typography>
    </Typography>
    {children}
  </Box>
);

/* ── Step 3: 字幕样式卡 ─────────────────────────────── */
const SubtitleStyleCard: React.FC = () => {
  const theme = useTheme();

  // Store bindings — subtitle style
  const sf = useEditingStore(s => s.subtitleFont);
  const sc = useEditingStore(s => s.subtitleColor);
  const ss = useEditingStore(s => s.subtitleSize);
  const sk = useEditingStore(s => s.subtitleStrokeColor);
  const sw = useEditingStore(s => s.subtitleStrokeWidth);
  // sLs (letterSpacing) and ts (textShadow) are local UI state, not persisted
  const [sLs, setSLs] = useState(0);
  const ts = '0 0 4px rgba(0,0,0,0.8)';
  const sov = useEditingStore(s => s.subtitleOverrides);
  const setSc = useEditingStore(s => s.setSubtitleColor);
  const setSs = useEditingStore(s => s.setSubtitleSize);
  const setSk = useEditingStore(s => s.setSubtitleStrokeColor);
  const setSw = useEditingStore(s => s.setSubtitleStrokeWidth);
  const setSov = useEditingStore(s => s.setSubtitleOverrides);
  const favSubtitleFonts = useEditingStore(s => s.favSubtitleFonts);
  const recentSubtitleFonts = useEditingStore(s => s.recentSubtitleFonts);
  const toggleFavSubtitleFont = useEditingStore(s => s.toggleFavSubtitleFont);
  const pushRecentSubtitleFont = useEditingStore(s => s.pushRecentSubtitleFont);
  const tl = useEditingStore(s => s.timeline);

  // Local state
  const [fonts, setFonts] = useState<{ name: string; path: string }[]>([]);
  const [alignAll, setAlignAll] = useState(true);

  // Load fonts list
  const bu = useBackendUrl();
  useEffect(() => {
    fetch(`${bu}/api/ai-editing/fonts`).then(r => r.json()).then(d => {
      if (d?.data?.fonts?.length) setFonts(d.data.fonts);
    }).catch(() => {});
  }, [bu]);

  const handleFontChange = useCallback((name: string) => {
    const entry = fonts.find(f => f.name === name);
    if (entry) {
      useEditingStore.getState().setSubtitleFont(name);
      useEditingStore.getState().setSubtitleFontPath(entry.path);
      pushRecentSubtitleFont(name);
    }
  }, [fonts, pushRecentSubtitleFont]);

  const applyPosPreset = useCallback((x: number, y: number) => {
    if (alignAll) {
      const updated: Record<number, { text?: string; x?: number; y?: number }> = {};
      for (let k = 0; k < tl.length; k++) updated[k] = { x, y };
      setSov(updated);
    } else {
      setSov({ ...sov, [0]: { ...(sov[0] || {}), x, y } });
    }
  }, [alignAll, tl, sov, setSov]);

  return (
    <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
      <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <SubtitlesIcon fontSize="small" color="primary" /> 字幕样式
      </Typography>
      {/* Font + colors row */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8, alignItems: 'center' }}>
        <Box sx={{ minWidth: 120 }}>
          <FontSelect label="字幕字体" value={sf} fonts={fonts} favorites={favSubtitleFonts} recents={recentSubtitleFonts} onChange={handleFontChange} onToggleFav={toggleFavSubtitleFont} />
        </Box>
        <input type="color" value={sc} onChange={e => setSc(e.target.value)} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 3 }} title="字幕颜色" />
        <Box sx={{ minWidth: 70 }}><Typography variant="caption" fontSize="0.65rem">大小{ss}%</Typography><Slider size="small" value={ss} min={2} max={12} step={0.5} onChange={(_, v) => setSs(v as number)} /></Box>
        <input type="color" value={sk} onChange={e => setSk(e.target.value)} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 3 }} title="描边颜色" />
        <Box sx={{ minWidth: 60 }}><Typography variant="caption" fontSize="0.65rem">描边{sw}</Typography><Slider size="small" value={sw} min={0} max={6} step={0.5} onChange={(_, v) => setSw(v as number)} /></Box>
        <Box sx={{ minWidth: 60 }}><Typography variant="caption" fontSize="0.65rem">间距{sLs}</Typography><Slider size="small" value={sLs} min={-2} max={10} step={0.5} onChange={(_, v) => setSLs(v as number)} /></Box>
        <Chip label={alignAll ? '📍 对齐' : '📍 独立'} size="small" color={alignAll ? 'primary' : 'default'} variant={alignAll ? 'filled' : 'outlined'} onClick={() => setAlignAll(!alignAll)} sx={{ cursor: 'pointer', height: 24, fontSize: '0.65rem' }} />
      </Box>
      {/* Position presets */}
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mt: 0.5 }}>
        <Typography variant="caption" fontSize="0.65rem">字幕位置</Typography>
        <Chip label="底部" size="small" variant="outlined" onClick={() => applyPosPreset(50, 88)} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
        <Chip label="中下" size="small" variant="outlined" onClick={() => applyPosPreset(50, 70)} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
        <Chip label="居中" size="small" variant="outlined" onClick={() => applyPosPreset(50, 50)} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
        <Chip label="顶部" size="small" variant="outlined" onClick={() => applyPosPreset(50, 12)} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
      </Box>
      {/* Preview box */}
      <Box sx={{ mt: 0.5, p: 1, bgcolor: '#1a1a2e', borderRadius: 1, textAlign: 'center' }}>
        <Typography sx={{ fontFamily: sf, fontSize: `${ss / 100 * 320}px`, color: sc, fontWeight: 700, letterSpacing: `${sLs}px`, textShadow: sw > 0 ? ts : 'none' }}>预览效果 Preview</Typography>
      </Box>
    </Paper>
  );
};

/* ── Step 3: 背景音乐卡 ─────────────────────────────── */
interface MusicTrack { name: string; path: string; duration_sec: number; }

const MusicControlCard: React.FC = () => {
  const theme = useTheme();
  const bu = useBackendUrl();

  const bgmName = useEditingStore(s => s.bgmName);
  const setBgmName = useEditingStore(s => s.setBgmName);
  const bgmVolume = useEditingStore(s => s.bgmVolume);
  const setBgmVolume = useEditingStore(s => s.setBgmVolume);
  const voiceVolume = useEditingStore(s => s.voiceVolume);
  const setVoiceVolume = useEditingStore(s => s.setVoiceVolume);

  const [musicList, setMusicList] = useState<MusicTrack[]>([]);
  const [importing, setImporting] = useState(false);

  // Load music list
  useEffect(() => {
    fetch(`${bu}/api/music/list`).then(r => r.json()).then(d => { if (d?.data) setMusicList(d.data); }).catch(() => {});
  }, [bu]);

  const selectedTrack = musicList.find(m => m.name === bgmName);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); const fd = new FormData(); fd.append('file', file);
    try { const r = await fetch(`${bu}/api/music/import`, { method: 'POST', body: fd }); const d = await r.json(); if (d?.data) { setMusicList(prev => [...prev, d.data]); setBgmName(d.data.name); } } catch {} finally { setImporting(false); }
  }, [bu, setBgmName]);

  // BGM preview using simple Audio element (isolated from main preview)
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewBgm = useCallback(() => {
    if (!bgmName) return;
    if (bgmAudioRef.current) { bgmAudioRef.current.pause(); bgmAudioRef.current = null; }
    const audio = new Audio(`${bu}/api/music/stream?name=${encodeURIComponent(bgmName)}`);
    audio.volume = bgmVolume / 100;
    audio.play().catch(() => {});
    bgmAudioRef.current = audio;
    audio.onended = () => { bgmAudioRef.current = null; };
  }, [bgmName, bu, bgmVolume]);

  return (
    <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
      <Typography variant="subtitle2" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <MusicNoteIcon fontSize="small" color="primary" /> 背景音乐
      </Typography>
      <Box sx={{ display: 'flex', gap: 0.5, mb: 0.5, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={bgmName} onChange={e => setBgmName(e.target.value)}
          style={{ flex: 1, minWidth: 100, padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.78rem' }}>
          <option value="">无音乐</option>
          {musicList.length === 0 && <option disabled>暂无，点 ⬆ 导入</option>}
          {musicList.map(m => <option key={m.name} value={m.name}>{m.name} ({m.duration_sec > 0 ? m.duration_sec.toFixed(0) + 's' : '?'})</option>)}
        </select>
        <label style={{ cursor: 'pointer', padding: '4px 8px', background: theme.palette.primary.main, color: theme.palette.primary.contrastText, borderRadius: 4, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
          {importing ? '...' : '⬆ 导入'}
          <input type="file" accept="audio/*" onChange={handleImport} style={{ display: 'none' }} />
        </label>
        <Button size="small" variant="outlined" onClick={previewBgm} disabled={!bgmName} sx={{ whiteSpace: 'nowrap' }} title="仅试听背景音乐">试听</Button>
      </Box>
      {bgmName && selectedTrack && (
        <Typography variant="caption" fontSize="0.65rem" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          ♪ {selectedTrack.name} · {selectedTrack.duration_sec > 0 ? selectedTrack.duration_sec.toFixed(1) + 's' : '?'} · 铺满全程、结尾淡出、不循环
        </Typography>
      )}
      <Box sx={{ mb: 0.5 }}><Typography variant="caption" fontSize="0.7rem">音乐音量 {bgmVolume}%</Typography><Slider size="small" min={0} max={100} value={bgmVolume} onChange={(_, v) => setBgmVolume(v as number)} /></Box>
      <Box><Typography variant="caption" fontSize="0.7rem">口播音量 {voiceVolume}%</Typography><Slider size="small" min={0} max={100} value={voiceVolume} onChange={(_, v) => setVoiceVolume(v as number)} /></Box>
    </Paper>
  );
};

/* ── Step 3: 封面入口卡片（点击打开右侧抽屉）─────────── */
const CoverEntryCard: React.FC<{ onOpen: () => void; justUpdated: boolean }> = ({ onOpen, justUpdated }) => {
  const theme = useTheme();
  const bu = useBackendUrl();
  const tl = useEditingStore(s => s.timeline);
  const aspect = useEditingStore(s => s.videoAspect);
  const coverVideoPath = useEditingStore(s => s.coverVideoPath);
  const coverTime = useEditingStore(s => s.coverTime);
  const coverTitle = useEditingStore(s => s.coverTitle);
  const coverSubtitle = useEditingStore(s => s.coverSubtitle);
  const resetCover = useEditingStore(s => s.resetCover);

  const src = coverVideoPath || tl[0]?.video_path || '';
  const segIdx = tl.findIndex(s => s.video_path === coverVideoPath);
  const thumbUrl = src ? `${bu}/api/ai-editing/thumb?path=${encodeURIComponent(src)}&t=${coverTime}&aspect=${aspect}` : '';
  const customized = !!(coverTitle || coverSubtitle || coverVideoPath || coverTime > 0);
  const statusText = customized
    ? `已自定义 · ${aspect}${segIdx >= 0 ? ` · 片段#${segIdx + 1}` : ''}`
    : `默认封面 · ${aspect}`;

  return (
    <Paper
      elevation={0}
      onClick={onOpen}
      sx={{
        p: 1.5, bgcolor: 'background.paperAlt', cursor: 'pointer', position: 'relative',
        display: 'flex', gap: 1.5, alignItems: 'center',
        border: '1px solid', borderColor: justUpdated ? 'success.main' : 'divider',
        transition: 'transform .18s cubic-bezier(.16,1,.3,1), box-shadow .18s, border-color .3s',
        '&:hover': {
          transform: 'translateY(-2px)',
          borderColor: 'primary.main',
          boxShadow: `0 6px 18px ${theme.palette.primary.main}33`,
        },
        ...(justUpdated ? {
          animation: 'coverFlash 1.5s ease-out',
          '@keyframes coverFlash': {
            '0%': { boxShadow: `0 0 0 3px ${theme.palette.success.main}88` },
            '100%': { boxShadow: '0 0 0 0 transparent' },
          },
        } : {}),
      }}
    >
      {/* 缩略图 */}
      <Box sx={{
        width: 54, height: 72, flexShrink: 0, borderRadius: 1, overflow: 'hidden',
        bgcolor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {thumbUrl
          ? <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <ImageIcon sx={{ color: 'text.disabled', fontSize: 28 }} />}
      </Box>
      {/* 文字 */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <MovieIcon fontSize="small" color="primary" /> 视频封面设置
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap title={statusText}>
          {statusText}
        </Typography>
      </Box>
      {/* hover 显示的「重置封面」操作 */}
      <IconButton
        size="small"
        onClick={(e) => { e.stopPropagation(); resetCover(); }}
        title="重置封面为默认"
        sx={{
          opacity: 0, transition: 'opacity .15s',
          '&:hover': { color: 'error.main' },
          '.MuiPaper-root:hover &': { opacity: 1 },
        }}
      >
        <RestartAltIcon fontSize="small" />
      </IconButton>
    </Paper>
  );
};

/* ── Step 3: 成片参数 → 完整三栏功能面板 ────────────── */
const StepPreviewRight: React.FC = () => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);

  // 把草稿写回 store（应用所有 setCoverXxx）
  const applyDraft = useCallback((d: CoverDraft) => {
    const s = useEditingStore.getState();
    s.setCoverVideoPath(d.coverVideoPath);
    s.setCoverTime(d.coverTime);
    s.setCoverTitle(d.coverTitle);
    s.setCoverSubtitle(d.coverSubtitle);
    s.setCoverTitleX(d.coverTitleX);
    s.setCoverTitleY(d.coverTitleY);
    s.setCoverSubX(d.coverSubX);
    s.setCoverSubY(d.coverSubY);
    s.setCoverTitleSize(d.coverTitleSize);
    s.setCoverSubSize(d.coverSubSize);
    s.setCoverTitleColor(d.coverTitleColor);
    s.setCoverSubColor(d.coverSubColor);
    s.setCoverTitleStrokeColor(d.coverTitleStrokeColor);
    s.setCoverTitleStrokeWidth(d.coverTitleStrokeWidth);
    s.setCoverSubStrokeColor(d.coverSubStrokeColor);
    s.setCoverSubStrokeWidth(d.coverSubStrokeWidth);
    s.setCoverTitleItalic(d.coverTitleItalic);
    s.setCoverSubItalic(d.coverSubItalic);
    s.setCoverZoom(d.coverZoom);
    s.setCoverOffsetX(d.coverOffsetX);
    s.setCoverOffsetY(d.coverOffsetY);
    s.setCoverFont(d.coverFont);
    s.setCoverFontPath(d.coverFontPath);
    // 应用后让入口卡片高亮一次（增强建议 #3）
    setJustUpdated(true);
    window.setTimeout(() => setJustUpdated(false), 1500);
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%', overflow: 'auto', pr: 0.5 }}>
      <SubtitleStyleCard />
      <MusicControlCard />
      <CoverEntryCard onOpen={() => setDrawerOpen(true)} justUpdated={justUpdated} />
      <CoverDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onApply={applyDraft} />
    </Box>
  );
};

/* ── Step 4: 导出设置摘要 ───────────────────────────── */
const StepExportRight: React.FC = () => {
  const videoAspect = useEditingStore((s) => s.videoAspect);
  const videoResolution = useEditingStore((s) => s.videoResolution);
  const outputPath = useEditingStore((s) => s.outputPath);

  const Row: React.FC<{ label: string; value: string }> = ({ label, value }) => (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', py: 0.5 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant="body2" fontWeight={600} noWrap title={value}>
        {value || '—'}
      </Typography>
    </Box>
  );

  return (
    <Panel title="导出设置">
      <Row label="格式" value="MP4 (H.264)" />
      <Row label="画幅" value={videoAspect} />
      <Row label="分辨率" value={videoResolution} />
      <Row label="输出路径" value={outputPath ?? '未指定'} />
    </Panel>
  );
};

const StepRightPanel: React.FC<{ step: number }> = ({ step }) => {
  switch (step) {
    case 0: return <StepImportRight />;
    case 1: return <StepAnalysisRight />;
    case 2: return <StepPreviewRight />;
    case 3: return <StepExportRight />;
    default: return null;
  }
};

export default StepRightPanel;
