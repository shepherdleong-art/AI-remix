/**
 * 批量模式 · 阶段二：脚本批量录入（ScriptBatchEditor）。
 *
 * - 左侧脚本列表（增删、拖拽排序），右侧当前脚本编辑器
 * - 一键粘贴批量导入（空行切分）；每条脚本「出片数量」copies（D1 裂变，默认 1）
 * - 全局设置区（D7 设一次）：音色/语速、字幕样式（字体/颜色/位置）、BGM 池（默认全库轮替）
 * - 可行性预估条（O2）：素材数/脚本数变化 → estimate，超建议量黄字预警不拦截
 * - 「开始分配」：保存脚本+设置 → TTS 批量预生成（轮询）→ allocate → 跳阶段三
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Slider,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import ErrorIcon from '@mui/icons-material/Error';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import RefreshIcon from '@mui/icons-material/Refresh';
import UploadFileIcon from '@mui/icons-material/UploadFile';

import api from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { useBatchStore } from '@/renderer/store/batch-store';
import { useEditingStore } from '@/renderer/store/editing-store';
import type { BatchScript, SubtitleStyle } from '@/renderer/types/batch';

interface EditableScript {
  id: string;
  text: string;
  copies: number;
}

interface VoiceOption { id: string; name: string; gender?: string; }
interface FontOption { name: string; path: string; }
interface MusicTrack { name: string; path?: string; duration_sec?: number; }

let scriptSeq = 0;
function newScriptId(): string {
  scriptSeq += 1;
  return `s_${Date.now().toString(36)}_${scriptSeq}`;
}

/** 按空行切分批量粘贴文本 */
function splitPasted(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ScriptBatchEditorProps {
  /** 分配完成，跳阶段三（分配审改，S6 界面预留钩子） */
  onAdvance: () => void;
  onBack: () => void;
}

const ScriptBatchEditor: React.FC<ScriptBatchEditorProps> = ({ onAdvance, onBack }) => {
  const batch = useBatchStore((s) => s.batch);
  const estimate = useBatchStore((s) => s.estimate);
  const ttsProgress = useBatchStore((s) => s.ttsProgress);
  const busy = useBatchStore((s) => s.busy);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);
  const saveScriptsAction = useBatchStore((s) => s.saveScripts);
  const saveSettingsAction = useBatchStore((s) => s.saveSettings);
  const loadEstimate = useBatchStore((s) => s.loadEstimate);
  const startTts = useBatchStore((s) => s.startTts);
  const allocate = useBatchStore((s) => s.allocate);

  const ttsProvider = useEditingStore((s) => s.ttsProvider);
  const editingVoice = useEditingStore((s) => s.voice);
  const ttsApiKeys = useEditingStore((s) => s.ttsApiKeys);
  const ttsKeyUseGlobal = useBatchStore((s) => s.ttsKeyUseGlobal);
  const ttsKeyOverride = useBatchStore((s) => s.ttsKeyOverride);
  const setTtsKeyUseGlobal = useBatchStore((s) => s.setTtsKeyUseGlobal);
  const setTtsKeyOverride = useBatchStore((s) => s.setTtsKeyOverride);

  const bu = useBackendUrl();

  // ── 脚本本地状态（编辑期以此为准，防抖自动保存） ──
  const [scripts, setScripts] = useState<EditableScript[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const dragIndexRef = useRef<number | null>(null);
  const batchIdRef = useRef<string | null>(null);

  // ── 全局设置本地状态 ──
  const [voice, setVoice] = useState('');
  const [speed, setSpeed] = useState(1.0);
  const [targetDuration, setTargetDuration] = useState(30);
  const [subFont, setSubFont] = useState('Microsoft YaHei');
  const [subFontPath, setSubFontPath] = useState('C:/Windows/Fonts/msyh.ttc');
  const [subColor, setSubColor] = useState('#ffffff');
  const [subSize, setSubSize] = useState(7);
  const [subStrokeColor, setSubStrokeColor] = useState('#000000');
  const [subStrokeWidth, setSubStrokeWidth] = useState(2);
  const [subY, setSubY] = useState(80);
  const [bgmMode, setBgmMode] = useState<'all' | 'custom'>('all');
  const [bgmSelected, setBgmSelected] = useState<string[]>([]);

  // ── 选项数据 ──
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [bgmImporting, setBgmImporting] = useState(false);
  const [tracksLoading, setTracksLoading] = useState(false);
  const [tracksError, setTracksError] = useState<string | null>(null);
  const bgmFileRef = useRef<HTMLInputElement | null>(null);

  /* 加载共享音乐库（与单条生产同一份 MUSIC_DIR） */
  const loadTracks = useCallback(async () => {
    setTracksLoading(true);
    setTracksError(null);
    try {
      const r = await api.get<MusicTrack[]>('/api/music/list');
      if (r.code === 0 && Array.isArray(r.data)) {
        const seen = new Set<string>();
        setTracks(r.data.filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true))));
      } else {
        setTracksError(`加载音乐库失败（code ${r.code}）`);
      }
    } catch (e) {
      setTracksError('加载音乐库出错：' + (e as Error).message);
    } finally {
      setTracksLoading(false);
    }
  }, []);

  /* 导入 BGM 到共享库（必须用原生 fetch + FormData，api.post 会把 FormData 当 JSON 序列化） */
  const handleBgmImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBgmImporting(true);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await fetch(`${bu}/api/music/import`, { method: 'POST', body: fd });
      const d = (await r.json()) as { code: number; message: string; data?: MusicTrack };
      if (d.code === 0 && d.data) {
        setTracks((prev) => (prev.some((t) => t.name === d.data!.name) ? prev : [...prev, d.data!]));
      } else {
        setTracksError('导入失败：' + (d.message || '未知错误'));
      }
    } catch (err) {
      setTracksError('导入出错：' + (err as Error).message);
    } finally {
      setBgmImporting(false);
      if (bgmFileRef.current) bgmFileRef.current.value = '';
    }
  }, [bu]);

  /* 从共享库删除曲目（双向管理） */
  const handleDeleteTrack = useCallback(async (name: string) => {
    try {
      const d = await api.delete<{ code: number; message: string }>(
        `/api/music/${encodeURIComponent(name)}`,
      );
      if (d.code === 0) {
        setTracks((prev) => prev.filter((t) => t.name !== name));
        setBgmSelected((prev) => prev.filter((n) => n !== name));
      } else {
        setTracksError('删除失败：' + (d.message || '未知错误'));
      }
    } catch (err) {
      setTracksError('删除出错：' + (err as Error).message);
    }
  }, []);

  // ── 分配流程状态 ──
  const [allocPhase, setAllocPhase] = useState<'idle' | 'saving' | 'tts' | 'allocating'>('idle');
  const [ttsFailures, setTtsFailures] = useState<string[]>([]);

  /* 批次切换时初始化本地状态（断点恢复） */
  useEffect(() => {
    if (!batch || batch.id === batchIdRef.current) return;
    batchIdRef.current = batch.id;
    const init = (batch.scripts ?? []).map((s: BatchScript) => ({
      id: s.id, text: s.text, copies: Math.max(1, s.copies || 1),
    }));
    setScripts(init);
    setSelectedId(init[0]?.id ?? null);
    const gs = batch.global_settings ?? {};
    setVoice(gs.voice || editingVoice || '');
    setSpeed(typeof gs.speed === 'number' ? gs.speed : 1.0);
    setTargetDuration(gs.target_duration || 30);
    const ss = gs.subtitle_style ?? {};
    if (ss.font) setSubFont(ss.font);
    if (ss.font_path) setSubFontPath(ss.font_path);
    if (ss.color) setSubColor(ss.color);
    if (typeof ss.size === 'number') setSubSize(ss.size);
    if (ss.stroke_color) setSubStrokeColor(ss.stroke_color);
    if (typeof ss.stroke_width === 'number') setSubStrokeWidth(ss.stroke_width);
    if (typeof ss.y === 'number') setSubY(ss.y);
    if (Array.isArray(gs.bgm_pool)) { setBgmMode('custom'); setBgmSelected(gs.bgm_pool); }
    else { setBgmMode('all'); setBgmSelected([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id]);

  /* 加载音色 / 字体 / 曲库选项 */
  useEffect(() => {
    void (async () => {
      const r = await api.get<{ voices?: VoiceOption[] } | VoiceOption[]>(
        `/api/ai-editing/voices?provider=${encodeURIComponent(ttsProvider)}`,
      );
      if (r.code === 0 && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.voices ?? []);
        setVoices(list);
        setVoice((cur) => cur || list[0]?.id || '');
      }
    })();
  }, [ttsProvider]);
  useEffect(() => {
    void (async () => {
      const r = await api.get<{ fonts?: FontOption[] }>('/api/ai-editing/fonts');
      if (r.code === 0 && r.data?.fonts) setFonts(r.data.fonts);
    })();
    void loadTracks();
  }, [loadTracks]);

  /* 脚本变化防抖自动保存（2s） */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!batchIdRef.current || scripts.length === 0) return undefined;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const valid = scripts.filter((s) => s.text.trim());
      if (valid.length > 0) void saveScriptsAction(valid);
    }, 2000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [scripts, saveScriptsAction]);

  /* 设置变化防抖自动保存（1.5s） */
  const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsPayload = useCallback(() => ({
    voice,
    speed,
    tts_provider: ttsProvider,
    target_duration: targetDuration,
    subtitle_style: {
      font: subFont, font_path: subFontPath, color: subColor,
      // 字段校准（与单条 ExportConfirm 同款语义，backend _render_subtitles 实际消费）：
      // subSize 是「画面宽度%」→ 转成 ffmpeg fontsize 像素；批量导出宽固定 1080。
      size: Math.round(subSize / 100 * 1080),
      stroke_color: subStrokeColor,
      // 描边随字号同步缩放：预览 320px 框 → 导出 1080 宽，×(1080/320)
      stroke_width: Math.round(subStrokeWidth * 1080 / 320),
      // y 为百分比；composite 的位置走逐段 subtitle_x/y，由后端导出任务注入
      y: subY,
    } as SubtitleStyle,
    bgm_pool: (bgmMode === 'all' ? 'all' : bgmSelected) as 'all' | string[],
  }), [voice, speed, ttsProvider, targetDuration, subFont, subFontPath, subColor, subSize,
    subStrokeColor, subStrokeWidth, subY, bgmMode, bgmSelected]);
  useEffect(() => {
    if (!batchIdRef.current || !voice) return undefined;
    if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current);
    settingsTimerRef.current = setTimeout(() => { void saveSettingsAction(settingsPayload()); }, 1500);
    return () => { if (settingsTimerRef.current) clearTimeout(settingsTimerRef.current); };
  }, [settingsPayload, saveSettingsAction, voice]);

  /* O2 可行性预估：素材数/总片数/目标时长变化 → 防抖刷新 */
  const totalClips = useMemo(() => scripts.reduce((a, s) => a + Math.max(1, s.copies || 1), 0), [scripts]);
  const materialsCount = batch?.materials.length ?? 0;
  const estimateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!batchIdRef.current || materialsCount === 0) return undefined;
    if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current);
    estimateTimerRef.current = setTimeout(() => { void loadEstimate(); }, 800);
    return () => { if (estimateTimerRef.current) clearTimeout(estimateTimerRef.current); };
  }, [materialsCount, totalClips, targetDuration, loadEstimate]);

  // ── 脚本列表操作 ──
  const addScript = useCallback(() => {
    const s = { id: newScriptId(), text: '', copies: 1 };
    setScripts((prev) => [...prev, s]);
    setSelectedId(s.id);
  }, []);

  const removeScript = useCallback((id: string) => {
    setScripts((prev) => {
      const next = prev.filter((s) => s.id !== id);
      setSelectedId((cur) => (cur === id ? next[0]?.id ?? null : cur));
      return next;
    });
  }, []);

  const updateScript = useCallback((id: string, patch: Partial<EditableScript>) => {
    setScripts((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }, []);

  const handleDrop = useCallback((toIndex: number) => {
    const from = dragIndexRef.current;
    dragIndexRef.current = null;
    if (from === null || from === toIndex) return;
    setScripts((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

  const handlePasteImport = useCallback(() => {
    const parts = splitPasted(pasteText);
    if (parts.length === 0) return;
    const added = parts.map((t) => ({ id: newScriptId(), text: t, copies: 1 }));
    setScripts((prev) => [...prev, ...added]);
    setSelectedId(added[0].id);
    setPasteText('');
    setPasteOpen(false);
  }, [pasteText]);

  // ── 开始分配：保存 → TTS（轮询）→ allocate → 跳阶段三 ──
  const handleStartAllocate = useCallback(async () => {
    const valid = scripts.filter((s) => s.text.trim());
    if (valid.length === 0) {
      setError('请先录入至少一条脚本');
      return;
    }
    setError(null);
    setTtsFailures([]);
    setAllocPhase('saving');
    useBatchStore.setState({ busy: true });
    try {
      if (!(await saveScriptsAction(valid))) return;
      if (!(await saveSettingsAction(settingsPayload()))) return;

      setAllocPhase('tts');
      const prog = await startTts();
      if (!prog) return; // key 缺失等，error 已写入 store

      // 汇总 TTS 失败的脚本（单脚本失败不阻塞，分配只用 done 的）
      const after = useBatchStore.getState().batch?.scripts ?? [];
      const failed = after
        .filter((s) => (s.tts?.status ?? '') === 'failed')
        .map((s) => s.text.slice(0, 24) + (s.text.length > 24 ? '…' : ''));
      setTtsFailures(failed);
      const doneCount = after.filter((s) => s.tts?.status === 'done').length;
      if (doneCount === 0) {
        setError('全部脚本 TTS 失败，无法分配。请检查「语音合成」API Key 后重试。');
        return;
      }

      setAllocPhase('allocating');
      const ok = await allocate();
      if (ok) onAdvance();
    } finally {
      useBatchStore.setState({ busy: false });
      setAllocPhase('idle');
    }
  }, [scripts, setError, saveScriptsAction, saveSettingsAction, settingsPayload, startTts, allocate, onAdvance]);

  const selected = scripts.find((s) => s.id === selectedId) ?? null;
  const ttsRunning = !!ttsProgress?.running || allocPhase === 'tts';
  const suggested = estimate?.suggested_max_clips ?? null;
  const overSuggested = suggested !== null && totalClips > suggested;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* ── O2 可行性预估条 ── */}
      <Paper
        elevation={0}
        sx={{
          p: 1.5, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap',
          bgcolor: overSuggested ? 'rgba(255,159,10,0.10)' : 'background.paperAlt',
          border: '1px solid', borderColor: overSuggested ? 'warning.main' : 'divider',
        }}
      >
        <Typography variant="body2" fontWeight={600}>
          可行性预估
        </Typography>
        {estimate ? (
          <>
            <Chip size="small" variant="outlined" label={`可用素材 ${estimate.materials_ready} 条`} />
            <Chip size="small" variant="outlined" label={`总可用 ${estimate.total_usable_seconds}s`} />
            <Chip size="small" color="info" variant="outlined" label={`建议 ≤ ${estimate.suggested_max_clips} 条不重复成片`} />
            <Chip size="small" color={overSuggested ? 'warning' : 'default'} variant={overSuggested ? 'filled' : 'outlined'}
              label={`当前计划 ${totalClips} 片`} />
            {overSuggested && (
              <Typography variant="caption" color="warning.main">
                超出建议量：将启用智能降级（优先重复高匹配素材并换区间），不拦截
              </Typography>
            )}
          </>
        ) : (
          <Typography variant="caption" color="text.secondary">
            {materialsCount === 0 ? '登记素材后自动计算' : '计算中…'}
          </Typography>
        )}
      </Paper>

      {storeError && <Alert severity="error" onClose={() => setError(null)}>{storeError}</Alert>}
      {ttsFailures.length > 0 && (
        <Alert severity="warning">
          {ttsFailures.length} 条脚本 TTS 失败（已跳过，分配只含成功脚本）：{ttsFailures.join('、')}
        </Alert>
      )}

      {/* ── 脚本编辑区：左列表 + 右编辑器 ── */}
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch' }}>
        {/* 左：脚本列表 */}
        <Paper elevation={0} sx={{ width: 320, flexShrink: 0, p: 1.5, bgcolor: 'background.paperAlt', display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="subtitle2" sx={{ flex: 1 }}>脚本列表（{scripts.length}）</Typography>
            <Tooltip title="按空行切分批量导入">
              <Button size="small" startIcon={<ContentPasteIcon />} onClick={() => setPasteOpen(true)}>
                粘贴导入
              </Button>
            </Tooltip>
            <Tooltip title="新增脚本">
              <IconButton size="small" color="primary" onClick={addScript}><AddIcon /></IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ flex: 1, overflow: 'auto', maxHeight: 420 }}>
            {scripts.length === 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ p: 1, display: 'block' }}>
                还没有脚本。点右上角 + 新增，或用「粘贴导入」一次灌入多条（空行分隔）。
              </Typography>
            )}
            {scripts.map((s, idx) => {
              const tts = batch?.scripts.find((x) => x.id === s.id)?.tts;
              return (
                <Box
                  key={s.id}
                  draggable
                  onDragStart={() => { dragIndexRef.current = idx; }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(idx)}
                  onClick={() => setSelectedId(s.id)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 0.5, p: 1, mb: 0.5,
                    borderRadius: 1.5, cursor: 'pointer',
                    border: '1px solid',
                    borderColor: selectedId === s.id ? 'primary.main' : 'divider',
                    bgcolor: selectedId === s.id ? 'action.selected' : 'background.paper',
                  }}
                >
                  <DragIndicatorIcon fontSize="small" sx={{ color: 'text.disabled', cursor: 'grab' }} />
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap>
                      {idx + 1}. {s.text.trim() ? s.text.trim().slice(0, 30) : '（空脚本）'}
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }} onClick={(e) => e.stopPropagation()}>
                      <Typography variant="caption" color="text.secondary">出片</Typography>
                      <TextField
                        type="number"
                        size="small"
                        value={s.copies}
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
                          updateScript(s.id, { copies: v });
                        }}
                        inputProps={{ min: 1, max: 99, style: { padding: '2px 4px', width: 34, textAlign: 'center' } }}
                        variant="outlined"
                      />
                      <Typography variant="caption" color="text.secondary">条</Typography>
                      {tts?.status === 'done' && <CheckCircleIcon color="success" sx={{ fontSize: 14 }} />}
                      {tts?.status === 'failed' && (
                        <Tooltip title={tts.error || 'TTS 失败'}><ErrorIcon color="error" sx={{ fontSize: 14 }} /></Tooltip>
                      )}
                    </Box>
                  </Box>
                  <IconButton size="small" onClick={(e) => { e.stopPropagation(); removeScript(s.id); }}>
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Box>
              );
            })}
          </Box>
        </Paper>

        {/* 右：当前脚本编辑器 */}
        <Paper elevation={0} sx={{ flex: 1, p: 2, bgcolor: 'background.paperAlt', minHeight: 300 }}>
          {selected ? (
            <>
              <Typography variant="subtitle2" gutterBottom>
                脚本 {scripts.findIndex((s) => s.id === selected.id) + 1} 全文
              </Typography>
              <TextField
                multiline
                fullWidth
                minRows={10}
                value={selected.text}
                onChange={(e) => updateScript(selected.id, { text: e.target.value })}
                placeholder="输入口播文案（15 秒约 150-200 字）"
              />
              <Typography variant="caption" color="text.secondary">
                {selected.text.length} 字 · 出片 {selected.copies} 条
              </Typography>
            </>
          ) : (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Typography variant="body2" color="text.secondary">从左侧选择或新增一条脚本</Typography>
            </Box>
          )}
        </Paper>
      </Box>

      {/* ── 全局设置区（D7 设一次） ── */}
      <Paper elevation={0} sx={{ p: 2.5, bgcolor: 'background.paperAlt' }}>
        <Typography variant="subtitle2" gutterBottom>全局设置（全批次统一，设一次）</Typography>
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* 音色/语速 */}
          <Box sx={{ minWidth: 240, flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <RecordVoiceOverIcon fontSize="small" color="primary" />
              <Typography variant="body2" fontWeight={600}>音色 / 语速</Typography>
              <Typography variant="caption" color="text.secondary">（服务商：{ttsProvider === 'doubao' ? '豆包' : '千问'}，与单条模式一致）</Typography>
            </Box>
            <FormControl size="small" fullWidth sx={{ mb: 1 }}>
              <InputLabel>音色</InputLabel>
              <Select value={voice} label="音色" onChange={(e) => setVoice(e.target.value)}>
                {voices.map((v) => (
                  <MenuItem key={v.id} value={v.id}>
                    {v.name}{v.gender === 'female' ? '（女声）' : v.gender === 'male' ? '（男声）' : ''}
                  </MenuItem>
                ))}
                {voices.length === 0 && voice && <MenuItem value={voice}>{voice}</MenuItem>}
              </Select>
            </FormControl>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>语速</Typography>
              <Slider
                size="small" value={speed} min={0.5} max={2.0} step={0.1}
                marks={[{ value: 0.5, label: '0.5x' }, { value: 1.0, label: '1x' }, { value: 2.0, label: '2x' }]}
                onChange={(_e, v) => setSpeed(v as number)}
                sx={{ flex: 1, maxWidth: 220 }}
              />
              <Chip label={`${speed.toFixed(1)}x`} size="small" />
            </Box>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                <Typography variant="caption" color="text.secondary">成片目标时长</Typography>
                <TextField
                  type="number" size="small" value={targetDuration}
                  onChange={(e) => setTargetDuration(Math.max(5, Math.min(120, parseInt(e.target.value, 10) || 30)))}
                  inputProps={{ min: 5, max: 120, style: { width: 48 } }}
                />
                <Typography variant="caption" color="text.secondary">秒</Typography>
              </Box>
              {/* 语音合成 API Key（批量可覆盖全局） */}
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1.5 }}>
                <RecordVoiceOverIcon fontSize="small" color="primary" />
                <Typography variant="body2" fontWeight={600}>语音合成 API Key</Typography>
                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={ttsKeyUseGlobal}
                      onChange={(e) => setTtsKeyUseGlobal(e.target.checked)}
                    />
                  }
                  label={ttsKeyUseGlobal ? '使用全局密钥' : '自定义覆盖'}
                />
              </Box>
              <TextField
                fullWidth
                size="small"
                type="password"
                sx={{ mt: 0.5 }}
                placeholder={ttsKeyUseGlobal ? `（使用全局${ttsProvider === 'doubao' ? '豆包' : '千问'}密钥）` : `粘贴批量专用${ttsProvider === 'doubao' ? '豆包' : '千问'}密钥`}
                value={ttsKeyUseGlobal ? (ttsApiKeys[ttsProvider] || '') : (ttsKeyOverride[ttsProvider] || '')}
                disabled={ttsKeyUseGlobal}
                onChange={(e) => setTtsKeyOverride(ttsProvider, e.target.value)}
              />
              <Typography variant="caption" color="text.secondary">
                默认复用单条模式的「语音合成」密钥；关闭开关可在此填入批量专用密钥（不影响单条模式）。
              </Typography>
            </Box>

            <Divider orientation="vertical" flexItem />

          {/* 字幕样式 */}
          <Box sx={{ minWidth: 260, flex: 1 }}>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>字幕样式</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              字号 = 画面宽度百分比（与单条模式一致），位置为纵向百分比
            </Typography>
            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <InputLabel>字体</InputLabel>
                <Select
                  value={subFont} label="字体"
                  onChange={(e) => {
                    const name = e.target.value;
                    setSubFont(name);
                    const f = fonts.find((x) => x.name === name);
                    if (f) setSubFontPath(f.path);
                  }}
                >
                  {fonts.slice(0, 60).map((f) => <MenuItem key={f.name} value={f.name}>{f.name}</MenuItem>)}
                  {!fonts.some((f) => f.name === subFont) && <MenuItem value={subFont}>{subFont}</MenuItem>}
                </Select>
              </FormControl>
              <TextField
                size="small" label="颜色" value={subColor}
                onChange={(e) => setSubColor(e.target.value)}
                sx={{ width: 96 }}
                InputProps={{ startAdornment: <Box component="span" sx={{ width: 14, height: 14, borderRadius: '3px', bgcolor: subColor, border: '1px solid', borderColor: 'divider', mr: 0.5 }} /> }}
              />
              <TextField
                size="small" label="字号" type="number" value={subSize}
                onChange={(e) => setSubSize(Math.max(1, Math.min(20, parseInt(e.target.value, 10) || 7)))}
                sx={{ width: 76 }}
              />
              <TextField
                size="small" label="描边色" value={subStrokeColor}
                onChange={(e) => setSubStrokeColor(e.target.value)}
                sx={{ width: 96 }}
                InputProps={{ startAdornment: <Box component="span" sx={{ width: 14, height: 14, borderRadius: '3px', bgcolor: subStrokeColor, border: '1px solid', borderColor: 'divider', mr: 0.5 }} /> }}
              />
              <TextField
                size="small" label="描边宽" type="number" value={subStrokeWidth}
                onChange={(e) => setSubStrokeWidth(Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0)))}
                sx={{ width: 76 }}
              />
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 56 }}>纵向位置</Typography>
              <Slider
                size="small" value={subY} min={0} max={100} step={1}
                onChange={(_e, v) => setSubY(v as number)}
                sx={{ flex: 1, maxWidth: 220 }}
              />
              <Chip label={`${subY}%`} size="small" />
            </Box>
          </Box>

          <Divider orientation="vertical" flexItem />

          {/* BGM 池 */}
          <Box sx={{ minWidth: 220, flex: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, mb: 0.5 }}>
              <Typography variant="body2" fontWeight={600}>BGM 池（批次内不重复轮替）</Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Tooltip title="导入 BGM 到共享音乐库">
                  <IconButton size="small" onClick={() => bgmFileRef.current?.click()} disabled={bgmImporting}>
                    <UploadFileIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="刷新音乐库">
                  <IconButton size="small" onClick={() => void loadTracks()} disabled={tracksLoading}>
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                {bgmImporting && <CircularProgress size={16} />}
              </Box>
            </Box>
            <Typography variant="caption" color="text.secondary">与单条生产共享同一本地音乐库（{tracks.length} 首）</Typography>
            {tracksError && (
              <Alert severity="error" sx={{ mt: 0.5, py: 0 }}>{tracksError}</Alert>
            )}
            {tracks.length === 0 ? (
              <Alert
                severity="info"
                sx={{ mt: 1 }}
                action={
                  <Button size="small" startIcon={<UploadFileIcon />} disabled={bgmImporting} onClick={() => bgmFileRef.current?.click()}>
                    导入 BGM
                  </Button>
                }
              >
                音乐库为空，导入后可在批次内轮替使用。
              </Alert>
            ) : (
              <>
                <FormControl size="small" fullWidth sx={{ mt: 0.5 }}>
                  <InputLabel>曲目范围</InputLabel>
                  <Select
                    value={bgmMode} label="曲目范围"
                    onChange={(e) => setBgmMode(e.target.value as 'all' | 'custom')}
                  >
                    <MenuItem value="all">全库轮替（{tracks.length} 首）</MenuItem>
                    <MenuItem value="custom">圈选曲目轮替</MenuItem>
                  </Select>
                </FormControl>
                {bgmMode === 'custom' && (
                  <FormControl size="small" fullWidth sx={{ mt: 1 }}>
                    <InputLabel>选择曲目</InputLabel>
                    <Select
                      multiple
                      value={bgmSelected}
                      label="选择曲目"
                      onChange={(e) => setBgmSelected(e.target.value as string[])}
                      renderValue={(sel) => `${sel.length} 首`}
                    >
                      {tracks.map((t) => (
                        <MenuItem key={t.name} value={t.name}>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 1 }}>
                            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</Box>
                            <IconButton
                              size="small"
                              edge="end"
                              onClick={(ev) => { ev.stopPropagation(); void handleDeleteTrack(t.name); }}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                )}
              </>
            )}
            <input ref={bgmFileRef} hidden type="file" accept="audio/*" onChange={handleBgmImport} />
          </Box>
        </Box>
      </Paper>

      {/* ── 分配进度 + 动作 ── */}
      {allocPhase !== 'idle' && (
        <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {allocPhase === 'saving' && '正在保存脚本与全局设置…'}
            {allocPhase === 'tts' && `TTS 预生成中 ${ttsProgress?.done ?? 0}/${ttsProgress?.total ?? '…'}（槽长是分配输入，请耐心等待）`}
            {allocPhase === 'allocating' && '正在联合分配素材 + BGM 轮替…'}
          </Typography>
          <LinearProgress
            variant={allocPhase === 'tts' && ttsProgress && ttsProgress.total > 0 ? 'determinate' : 'indeterminate'}
            value={allocPhase === 'tts' && ttsProgress && ttsProgress.total > 0
              ? Math.round((ttsProgress.done / ttsProgress.total) * 100) : 0}
            sx={{ borderRadius: 999, height: 6, '& .MuiLinearProgress-bar': { borderRadius: 999 } }}
          />
        </Paper>
      )}
      {ttsRunning && allocPhase === 'idle' && (
        <Alert severity="info">TTS 正在后台生成中 {ttsProgress?.done ?? 0}/{ttsProgress?.total ?? '…'}，完成后再点「开始分配」可跳过等待。</Alert>
      )}

      <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
        <Button onClick={onBack} disabled={busy}>上一步：素材预修</Button>
        <Button
          variant="contained"
          size="large"
          startIcon={<RocketLaunchIcon />}
          disabled={busy || scripts.filter((s) => s.text.trim()).length === 0}
          onClick={() => { void handleStartAllocate(); }}
        >
          {busy ? '分配流程进行中…' : `开始分配（${totalClips} 片）`}
        </Button>
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button size="small" endIcon={<ArrowForwardIcon />} onClick={onAdvance} disabled={busy}>
          跳过分配，直接去分配审改
        </Button>
      </Box>

      {/* ── 粘贴批量导入对话框 ── */}
      <Dialog open={pasteOpen} onClose={() => setPasteOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>粘贴批量导入（空行切分）</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus multiline fullWidth minRows={10}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={'第一段口播文案……\n\n第二段口播文案……\n\n第三段口播文案……'}
            sx={{ mt: 1 }}
          />
          <Typography variant="caption" color="text.secondary">
            将切分为 {splitPasted(pasteText).length} 条脚本
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPasteOpen(false)}>取消</Button>
          <Button variant="contained" onClick={handlePasteImport} disabled={splitPasted(pasteText).length === 0}>
            导入 {splitPasted(pasteText).length} 条
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ScriptBatchEditor;
