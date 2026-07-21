/**
 * TimelineEditor: seekable track, preview play, draggable subs, font paths, strip punctuation.
 */
import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import {
  Box, Typography, Paper, Button, IconButton, Slider,
  Chip, Tooltip, Popover, TextField, Snackbar,
} from '@mui/material';
import { useTheme } from '@mui/material';
import MovieIcon from '@mui/icons-material/Movie';
import { useEditingStore, computeOutputDims, computePreviewDims } from '@/renderer/store/editing-store';
import type { TimelineSegment } from '@/renderer/store/editing-store';
import { getBackendBaseUrl } from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { fitTitleLine } from '@/renderer/utils/coverFit';
import FontSelect from '@/renderer/components/common/FontSelect';
import FcpTimeline from '@/renderer/components/timeline/FcpTimeline';
import TrimEditor from '@/renderer/components/timeline/TrimEditor';
import { FCP_TIMELINE_CONFIG } from '@/renderer/components/timeline/fcpTimelineConfig';
import { computeWaveformPeaks } from '@/renderer/components/timeline/waveformPeaks';
import { videoUrl } from '@/renderer/components/timeline/mediaUrl';

function stripPunct(s: string) { return (s || '').replace(/[，,。！？；：、""''（）()\\.!?;:'"“”\s]+/g, ''); }
/** Split text into single sentences at Chinese/English punctuation */
function splitSentences(text: string): string[] {
  const cleaned = (text || '').replace(/[""''""''''\s]+/g, '');
  const parts = cleaned.split(/(?<=[，,。！？；：.!?;:])/g);
  return parts.filter(s => s.trim().length > 0);
}

/* ─── Font entry ─── */
interface FontEntry { name: string; path: string; }

/* ─── Main ─── */
const TimelineEditor: React.FC = () => {
  const theme = useTheme();
  const tl = useEditingStore(s => s.timeline); const setTl = useEditingStore(s => s.setTimeline);
  const adur = useEditingStore(s => s.audioDuration);
  const sf = useEditingStore(s => s.subtitleFont); const sc = useEditingStore(s => s.subtitleColor);
  const ss = useEditingStore(s => s.subtitleSize); const sk = useEditingStore(s => s.subtitleStrokeColor);
  const sw = useEditingStore(s => s.subtitleStrokeWidth); const sfp = useEditingStore(s => s.subtitleFontPath);
  const sov = useEditingStore(s => s.subtitleOverrides); const setSov = useEditingStore(s => s.setSubtitleOverrides);
  const setSf = useEditingStore(s => s.setSubtitleFont); const setSc = useEditingStore(s => s.setSubtitleColor);
  const setSs = useEditingStore(s => s.setSubtitleSize); const setSk = useEditingStore(s => s.setSubtitleStrokeColor);
  const setSw = useEditingStore(s => s.setSubtitleStrokeWidth); const setSfp = useEditingStore(s => s.setSubtitleFontPath);
  const favSubtitleFonts = useEditingStore(s => s.favSubtitleFonts);
  const recentSubtitleFonts = useEditingStore(s => s.recentSubtitleFonts);
  const toggleFavSubtitleFont = useEditingStore(s => s.toggleFavSubtitleFont);
  const pushRecentSubtitleFont = useEditingStore(s => s.pushRecentSubtitleFont);
  // Background music
  const bgmName = useEditingStore(s => s.bgmName);
  const bgmVolume = useEditingStore(s => s.bgmVolume);
  const voiceVolume = useEditingStore(s => s.voiceVolume);
  const setBgmName = useEditingStore(s => s.setBgmName);
  const setBgmVolume = useEditingStore(s => s.setBgmVolume);
  const setVoiceVolume = useEditingStore(s => s.setVoiceVolume);
  const audioPath = useEditingStore(s => s.audioPath);
  const [sLs, setSLs] = useState(0);
  const [alignAll, setAlignAll] = useState(true); // sync subtitle positions

  const [eSub, setESub] = useState<number | null>(null); const [eText, setEText] = useState('');
  const [ae, setAe] = useState<HTMLElement | null>(null);
  const [fonts, setFonts] = useState<FontEntry[]>([{ name: 'Microsoft YaHei', path: 'C:/Windows/Fonts/msyh.ttc' }]);
  const bu: string = useBackendUrl();

  /* ── Load fonts from API ── */
  useEffect(() => {
    fetch(`${bu}/api/ai-editing/fonts`).then(r => r.json()).then(d => {
      if (d?.data?.fonts?.length) {
        setFonts(d.data.fonts);
        const cur = d.data.fonts.find((f: FontEntry) => f.name === sf);
        if (!cur && d.data.fonts[0]) {
          setSf(d.data.fonts[0].name);
          setSfp(d.data.fonts[0].path);
        }
        // Apply @font-face ONLY for non-TTC fonts
        const fp = cur?.path || d.data.fonts[0]?.path;
        const fn = cur?.name || d.data.fonts[0]?.name;
        if (fp && fn && !fp.toLowerCase().endsWith('.ttc')) loadFontFace(fn, fp);
      }
    }).catch(() => {});
  }, [bu]);

  function loadFontFace(name: string, path: string) {
    if (path.toLowerCase().endsWith('.ttc')) return; // TTC not supported by browsers
    const fid = 'custom-subtitle-font';
    let el = document.getElementById(fid) as HTMLStyleElement | null;
    if (!el) { el = document.createElement('style'); el.id = fid; document.head.appendChild(el); }
    el.textContent = `@font-face { font-family: "${name}"; src: url(${bu}/api/ai-editing/font-file?path=${encodeURIComponent(path)}); }`;
  }

  const handleFontChange = useCallback((name: string) => {
    setSf(name);
    pushRecentSubtitleFont(name);
    const entry = fonts.find(f => f.name === name);
    if (entry) {
      setSfp(entry.path);
      loadFontFace(entry.name, entry.path);
    }
  }, [fonts, setSf, setSfp, bu, pushRecentSubtitleFont]);

  /* ── Memo ── */
  const td = useMemo(() => {
    const segSum = tl.reduce((a, s) => a + (s.duration || 0), 0);
    // Prefer the real timeline total so the preview length matches the exported
    // video. audioDuration (adur) can be stale/short and would otherwise truncate
    // the preview video + Web-Audio BGM after only a few seconds.
    return segSum > 0 ? segSum : (adur || 15);
  }, [adur, tl]);

  /* ── Subs (auto-split each segment text into single sentences) ── */
  const subs = useMemo(() => {
    let t = 0;
    const result: { i: number; start: number; end: number; text: string; x: number; y: number }[] = [];
    for (let si = 0; si < tl.length; si++) {
      const s = tl[si];
      const ov = sov[si] || {};
      const rawText = ov.text ?? s.segment_text ?? '';
      const parts = splitSentences(rawText);
      if (parts.length === 0) { t += s.duration || 0; continue; }
      const partDur = (s.duration || 1) / parts.length;
      for (const part of parts) {
        result.push({ i: si, start: t, end: t + partDur, text: part, x: ov.x ?? 50, y: ov.y ?? 85 });
        t += partDur;
      }
    }
    return result;
  }, [tl, sov]);

  /* ── Handlers ── */
  const sync = useCallback(() => { if (!adur) return; const t = tl.reduce((a, s) => a + s.duration, 0); if (t <= 0) return; setTl(tl.map(s => ({ ...s, duration: +Math.max(0.5, (s.duration * adur / t)).toFixed(1) }))); }, [adur, tl, setTl]);

  /* ── Sub edit (uses original segment index for overrides) ── */
  const openEdit = useCallback((si: number, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const segIdx = subs[si]?.i ?? si; // original segment index
    setESub(segIdx);
    setEText(sov[segIdx]?.text ?? tl[segIdx]?.segment_text ?? '');
    setAe(e.currentTarget as HTMLElement);
  }, [subs, sov, tl]);
  const saveEdit = useCallback(() => {
    if (eSub !== null) setSov({ ...sov, [eSub]: { ...sov[eSub], text: eText } });
    setESub(null); setAe(null);
  }, [eSub, eText, sov, setSov]);
  const delSub = useCallback((i: number) => { const n = { ...sov }; delete n[i]; setSov(n); }, [sov, setSov]);

  const mm = adur && Math.abs(td - adur) > 0.5;
  const ts = `${-sw}px ${-sw}px 0 ${sk},${sw}px ${-sw}px 0 ${sk},${-sw}px ${sw}px 0 ${sk},${sw}px ${sw}px 0 ${sk}`;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* ── Top bar ── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', minHeight: 36 }}>
        <Typography variant="subtitle2">预览调整</Typography>
        <Chip label={`${tl.length}片段`} size="small" />
        <Chip label={`${td.toFixed(1)}s`} size="small" color="primary" variant="outlined" />
        {adur && <Chip label={`口播${adur.toFixed(1)}s ${mm ? '⚠️' : '✅'}`} size="small" color={mm ? 'warning' : 'success'} variant="outlined" />}
        {mm && <Button size="small" variant="outlined" onClick={sync}>同步</Button>}
        <Chip label="单击选中 | 拖拽排序 | 双击片段重选时段 | 双击字幕编辑" size="small" variant="outlined" color="info" />
      </Box>

      {/* ── Subtitle edit popover ── */}
      <Popover open={eSub !== null} anchorEl={ae} onClose={saveEdit} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
        <Box sx={{ p: 2, minWidth: 280 }}>
          <Typography variant="subtitle2" gutterBottom>编辑第 {eSub !== null ? eSub + 1 : ''} 段字幕 (自动去除标点)</Typography>
          <textarea value={eText} onChange={e => setEText(e.target.value)}
            style={{ width: '100%', minHeight: 60, padding: 8, borderRadius: 4, border: '1px solid #ccc', fontSize: 14 }} />
          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Button size="small" variant="contained" onClick={saveEdit}>确定</Button>
            <Button size="small" onClick={() => { setESub(null); setAe(null); }}>取消</Button>
            {eSub !== null && <Button size="small" color="error" onClick={() => { delSub(eSub); setESub(null); setAe(null); }}>删除</Button>}
          </Box>
        </Box>
      </Popover>

      {/* ── 🎬 Preview + Subtitle + Music ── */}
      <MusicPreviewPanel
        tl={tl} td={td} adur={adur || 0} bu={bu}
        audioPath={audioPath}
        bgmName={bgmName} setBgmName={setBgmName}
        bgmVolume={bgmVolume} setBgmVolume={setBgmVolume}
        voiceVolume={voiceVolume} setVoiceVolume={setVoiceVolume}
        sf={sf} sc={sc} ss={ss} sk={sk} sw={sw} sLs={sLs} ts={ts}
        setSc={setSc} setSs={setSs} setSk={setSk} setSw={setSw} setSLs={setSLs}
        fonts={fonts} favSubtitleFonts={favSubtitleFonts} recentSubtitleFonts={recentSubtitleFonts}
        handleFontChange={handleFontChange} toggleFavSubtitleFont={toggleFavSubtitleFont}
        alignAll={alignAll} setAlignAll={setAlignAll}
        // Subtitle overlay data
        subs={subs} eSub={eSub} eText={eText} ae={ae}
        openEdit={openEdit} saveEdit={saveEdit} delSub={delSub}
        setAe={setAe} setEText={setEText}
      />
      {/* CoverEditor moved to right panel (StepRightPanel) */}
    </Box>
  );
};

/* ─────────────────────────────────────────────────────────────────────
 *  MusicPreviewPanel — merged: video preview + subtitle style + music
 *  ───────────────────────────────────────────────────────────────────── */
interface MusicPreviewPanelProps {
  tl: TimelineSegment[]; td: number; adur: number; bu: string;
  audioPath: string | null;
  bgmName: string; setBgmName: (n: string) => void;
  bgmVolume: number; setBgmVolume: (v: number) => void;
  voiceVolume: number; setVoiceVolume: (v: number) => void;
  // Subtitle props
  sf: string; sc: string; ss: number; sk: string; sw: number; sLs: number; ts: string;
  setSc: (v: string) => void; setSs: (v: number) => void; setSk: (v: string) => void;
  setSw: (v: number) => void; setSLs: (v: number) => void;
  fonts: FontEntry[]; favSubtitleFonts: string[]; recentSubtitleFonts: string[];
  handleFontChange: (name: string) => void; toggleFavSubtitleFont: (name: string) => void;
  alignAll: boolean; setAlignAll: (v: boolean) => void;
  // Subtitle overlay
  subs: Array<{ i?: number; start: number; end: number; text: string; x: number; y: number }>;
  eSub: number | null; eText: string; ae: HTMLElement | null; delSub: (i: number) => void;
  openEdit: (i: number, e: React.MouseEvent) => void; saveEdit: () => void;
  setAe: (el: HTMLElement | null) => void; setEText: (t: string) => void;
}

const MusicPreviewPanel: React.FC<MusicPreviewPanelProps> = ({
  tl, td, adur, bu, audioPath,
  bgmName, setBgmName, bgmVolume, setBgmVolume, voiceVolume, setVoiceVolume,
  sf, sc, ss, sk, sw, sLs, ts, setSc, setSs, setSk, setSw, setSLs,
  fonts, favSubtitleFonts, recentSubtitleFonts, handleFontChange, toggleFavSubtitleFont,
  alignAll, setAlignAll,
  subs, eSub, eText, ae, delSub, openEdit, saveEdit, setAe, setEText,
}) => {
  const theme = useTheme();
  const videoAspect = useEditingStore(s => s.videoAspect);
  const setVideoAspect = useEditingStore(s => s.setVideoAspect);
  const videoResolution = useEditingStore(s => s.videoResolution);
  const setVideoResolution = useEditingStore(s => s.setVideoResolution);
  const resolution = computeOutputDims(videoAspect, videoResolution);
  const sov = useEditingStore(s => s.subtitleOverrides);
  const setSov = useEditingStore(s => s.setSubtitleOverrides);
  // TTS 版本号：split-tts 每次成功自增——后端同路径覆盖音频时强制重新拉取语音 buffer
  const audioVersion = useEditingStore(s => s.audioVersion);
  type MusicTrack = { name: string; path: string; duration_sec: number };
  const [musicList, setMusicList] = useState<MusicTrack[]>([]);
  const selectedTrack = musicList.find((m) => m.name === bgmName);
  const [pvUrl, setPvUrlLocal] = useState('');
  const [pvLoading, setPvLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [scrub, setScrub] = useState(0);
  const [importing, setImporting] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  // P2 重选时段：正在 trim 的片段下标（null = 非 Trim 模式）
  const [trimIndex, setTrimIndex] = useState<number | null>(null);
  const [trimHint, setTrimHint] = useState(false);
  // Trim 大预览：Trim 模式下 320 预览框切换为被 trim 片段的素材源实时画面
  const trimVideoRef = useRef<HTMLVideoElement>(null);
  // 选择框左缘的素材源时刻（state 供徽标显示；ref 供拖拽回调/RAF 读最新值，避免闭包过期）
  const [trimTime, setTrimTime] = useState(0);
  const trimTimeRef = useRef(0);
  // 循环试听：在 [入点, 入点+槽长] 内循环播放素材源
  const [trimAudition, setTrimAudition] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const voiceBufRef = useRef<AudioBuffer | null>(null);
  const musicBufRef = useRef<AudioBuffer | null>(null);
  // P3：T3 波形峰值（复用已解码 buffer 抽峰，不重解码；null = 无音频/解析中）
  const [voicePeaks, setVoicePeaks] = useState<{ peaks: number[]; dur: number } | null>(null);
  const [bgmPeaks, setBgmPeaks] = useState<{ peaks: number[]; dur: number } | null>(null);
  const voiceSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const musicSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const bgmPreviewSrcRef = useRef<AudioBufferSourceNode | null>(null);
  const voiceGainRef = useRef<GainNode | null>(null);
  const musicGainRef = useRef<GainNode | null>(null);

  // Authoritative preview length = the ACTUAL preview video duration. The
  // preview video has NO audio track (BGM is overlaid via Web Audio), so if we
  // drive BGM length from `td`/`adur` (which can be stale/short), the music is
  // force-stopped after only a few seconds. Reading the real <video>.duration
  // makes the overlay match what the user actually sees — no more "BGM vanishes
  // after 2-3s". Falls back to td/adur only if metadata isn't ready yet.
  const [pvDur, setPvDur] = useState(0);
  const totalDur = pvDur > 0 ? pvDur : (td > 0 ? td : (adur > 0 ? adur : 15));

  // Load music list on mount
  useEffect(() => { fetch(`${bu}/api/music/list`).then(r => r.json()).then(d => { if (d?.data) setMusicList(d.data); }).catch(() => {}); }, [bu]);

  // Re-assemble preview when timeline changes — 300ms 防抖合并连续修改
  // （拖拽重排/替换/画幅切换），避免后端 assemble 排队风暴。
  useEffect(() => {
    if (!tl.length) { setPvUrlLocal(''); setPvDur(0); setPvLoading(false); return; }
    setPvLoading(true);
    const h = setTimeout(() => {
      fetch(`${bu}/api/preview/assemble`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeline: tl.map(s => ({ video_path: s.video_path, start_time: s.start_time, duration: s.duration })), ...computePreviewDims(videoAspect), aspect: videoAspect }),
      }).then(r => r.json()).then(d => { if (d?.data?.path) setPvUrlLocal(`${bu}/api/ai-editing/video?path=${encodeURIComponent(d.data.path)}&t=${Date.now()}`); }).catch(() => {}).finally(() => setPvLoading(false));
    }, FCP_TIMELINE_CONFIG.previewAssembleDebounceMs);
    return () => clearTimeout(h);
  }, [tl, bu, videoAspect, videoResolution]);

  // Preload audio buffers once (+ P3：解码完成后同步抽波形峰值供 T3 音频轨)
  useEffect(() => {
    const ctx = new AudioContext(); audioCtxRef.current = ctx;
    let cancelled = false;
    setVoicePeaks(null); setBgmPeaks(null);
    (async () => {
      if (audioPath) {
        try {
          const r = await fetch(`${bu}/api/ai-editing/audio?path=${encodeURIComponent(audioPath)}&_v=${audioVersion}`);
          const buf = await ctx.decodeAudioData(await r.arrayBuffer());
          voiceBufRef.current = buf;
          if (!cancelled) setVoicePeaks({ peaks: computeWaveformPeaks(buf, FCP_TIMELINE_CONFIG.waveformBuckets), dur: buf.duration });
        } catch {}
      }
      if (bgmName) {
        try {
          const r = await fetch(`${bu}/api/music/stream?name=${encodeURIComponent(bgmName)}`);
          const buf = await ctx.decodeAudioData(await r.arrayBuffer());
          musicBufRef.current = buf;
          if (!cancelled) setBgmPeaks({ peaks: computeWaveformPeaks(buf, FCP_TIMELINE_CONFIG.waveformBuckets), dur: buf.duration });
        } catch {}
      }
    })();
    return () => { cancelled = true; ctx.close(); };
  }, [bu, audioPath, bgmName, audioVersion]);

  const stopAll = useCallback(() => {
    [voiceSrcRef, musicSrcRef, bgmPreviewSrcRef].forEach(r => { try { r.current?.stop(); } catch {} r.current = null; });
    // Bug #1 fix: the main <video> element must be paused too, otherwise the
    // picture + burned-in narration keep playing after "stop".
    if (videoRef.current) videoRef.current.pause();
  }, []);

  /* P2 重选时段入口：双击片段。素材时长未知（source_duration ≤ 0）时提示并拦截；
     Trim 模式期间忽略新的进入请求（先完成/取消当前片段）。 */
  const handleTrimRequest = useCallback((i: number) => {
    if (trimIndex !== null) return;
    const seg = tl[i];
    if (!seg || !(seg.source_duration && seg.source_duration > 0)) {
      setTrimHint(true);
      return;
    }
    stopAll();
    setPlaying(false);
    // 大预览初始落点 = 当前入点（trim 视频 loadedmetadata 时 seek 到此）
    trimTimeRef.current = seg.start_time;
    setTrimTime(seg.start_time);
    setTrimAudition(false);
    setTrimIndex(i);
  }, [trimIndex, tl, stopAll]);

  /* 防御：Trim 中时间线被整体替换/清空导致目标片段消失时，自动退出 Trim 模式 */
  useEffect(() => {
    if (trimIndex !== null && !tl[trimIndex]) setTrimIndex(null);
  }, [trimIndex, tl]);

  /* Trim 联动：选择框左缘时刻变化 → 直接 seek 大预览里的 trim 视频。
     只做 currentTime 赋值（不 play），便宜；由 TrimEditor RAF + 最小位移双节流驱动。 */
  const handleTrimBoxTimeChange = useCallback((t: number) => {
    trimTimeRef.current = t;
    setTrimTime(t);
    const v = trimVideoRef.current;
    if (v && Math.abs(v.currentTime - t) > 0.01) v.currentTime = t;
  }, []);

  /* 新一轮拖拽开始：暂停循环试听，恢复实时跟随 */
  const handleTrimDragStart = useCallback(() => {
    setTrimAudition(false);
    trimVideoRef.current?.pause();
  }, []);

  /* 循环试听开关：ON = 从入点起播；右界由下方 RAF 卡回入点 */
  const handleToggleAudition = useCallback(() => {
    const v = trimVideoRef.current;
    if (!v) return;
    if (trimAudition) {
      v.pause();
      setTrimAudition(false);
    } else {
      v.currentTime = trimTimeRef.current;
      v.play().catch(() => {});
      setTrimAudition(true);
    }
  }, [trimAudition]);

  /* 完成/取消/ESC 退出 Trim：停试听（trim 视频随模式卸载），合成预览原样恢复 */
  const handleTrimClose = useCallback(() => {
    setTrimAudition(false);
    trimVideoRef.current?.pause();
    setTrimIndex(null);
  }, []);

  /* 循环试听期间用 RAF 卡右界：越过 入点+槽长 即跳回入点续播；
     ended/意外暂停时自愈（先回卷入点再 play）。拖拽会先把试听关掉，无冲突。 */
  const trimSegDur = trimIndex !== null ? (tl[trimIndex]?.duration ?? 0) : 0;
  useEffect(() => {
    if (!trimAudition || trimIndex === null || trimSegDur <= 0) return;
    let raf = 0;
    const tick = () => {
      const v = trimVideoRef.current;
      if (v) {
        if (v.currentTime >= trimTimeRef.current + trimSegDur) v.currentTime = trimTimeRef.current;
        if (v.paused) v.play().catch(() => {});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [trimAudition, trimIndex, trimSegDur]);

  const play = useCallback((fromTime: number) => {
    stopAll();
    const ctx = audioCtxRef.current; if (!ctx || ctx.state === 'closed') return;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime;
    if (videoRef.current) { videoRef.current.currentTime = fromTime; videoRef.current.play().catch(() => {}); }
    const endTime = totalDur + 2;
    const vGain = ctx.createGain(); vGain.gain.value = voiceVolume / 100; vGain.connect(ctx.destination); voiceGainRef.current = vGain;
    const mGain = ctx.createGain(); mGain.gain.value = bgmVolume / 100; mGain.connect(ctx.destination); musicGainRef.current = mGain;
    if (voiceBufRef.current) {
      const s = ctx.createBufferSource(); s.buffer = voiceBufRef.current!; s.connect(vGain);
      s.start(t0, Math.max(0, fromTime), Math.max(0.1, endTime - fromTime)); voiceSrcRef.current = s;
    }
    if (musicBufRef.current) {
      const s = ctx.createBufferSource(); s.buffer = musicBufRef.current!;
      const fadeStart = totalDur - 2;
      // Bug #2/#3 fix: schedule the BGM fade envelope relative to the ACTUAL
      // playback start (ctx.currentTime), not absolute context time 0. The
      // AudioContext has been alive since page load, so anchoring to 0 shifted
      // the fade into the past and the music vanished after ~2-3s.
      if (fadeStart > fromTime) {
        mGain.gain.setValueAtTime(bgmVolume / 100, t0);
        mGain.gain.linearRampToValueAtTime(bgmVolume / 100, t0 + Math.max(0, fadeStart - fromTime));
        mGain.gain.linearRampToValueAtTime(0, t0 + Math.max(0.01, endTime - fromTime));
      }
      s.connect(mGain); s.start(t0, Math.max(0, fromTime), Math.max(0.1, endTime - fromTime)); musicSrcRef.current = s;
    }
    setPlaying(true);
  }, [stopAll, voiceVolume, bgmVolume, totalDur]);

  const seek = useCallback((t: number) => { setScrub(t); if (playing) play(t); }, [playing, play]);

  // 当前播放头下的字幕（字幕位置预设「仅当前」的作用对象）。改由本面板实时
  // scrub 推导 —— 原实现由 TimelineEditor 内部 scrub 推导，但该 scrub 从未被
  // 驱动（恒为 0），预设永远作用于第一段。
  const curSub = subs.find(s => scrub >= s.start && scrub < s.end);

  // Usability: one-click subtitle position presets (sets all segments when
  // "align" is on, otherwise just the currently visible subtitle).
  const applyPosPreset = useCallback((x: number, y: number) => {
    if (alignAll) {
      const updated: Record<number, { text?: string; x?: number; y?: number }> = {};
      for (let k = 0; k < tl.length; k++) updated[k] = { x, y };
      setSov(updated);
    } else {
      const idx = curSub?.i ?? 0;
      setSov({ ...sov, [idx]: { ...(sov[idx] || {}), x, y } });
    }
  }, [alignAll, tl, sov, setSov, curSub]);

  // Usability: audition the selected BGM in isolation (does not affect the main preview).
  const previewBgm = useCallback(() => {
    const ctx = audioCtxRef.current; if (!ctx || !musicBufRef.current) return;
    if (ctx.state === 'suspended') ctx.resume();
    try { bgmPreviewSrcRef.current?.stop(); } catch {}
    const s = ctx.createBufferSource(); s.buffer = musicBufRef.current;
    const g = ctx.createGain(); g.gain.value = bgmVolume / 100; g.connect(ctx.destination);
    s.connect(g); s.start(ctx.currentTime); bgmPreviewSrcRef.current = s;
  }, [bgmVolume]);

  // RAF tick driven by video time
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v && !v.paused) { const ct = v.currentTime; setScrub(ct); if (ct >= totalDur + 2) { stopAll(); setPlaying(false); v.pause(); } }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, totalDur, stopAll]);

  /* 键盘快捷键：空格 播放/暂停（与播放按钮同语义），←/→ 播放头 ±0.1s（走 seek，播放中会重启 Web Audio）。
     守卫：焦点在输入控件、MUI Dialog/Popover 打开、或 Trim 模式（trimIndex !== null，Trim 拥有自己的键盘交互）时忽略。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (trimIndex !== null) return;
      if (document.querySelector('.MuiDialog-root, .MuiPopover-root')) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (playing) { stopAll(); setPlaying(false); } else { play(scrub); }
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const next = Math.min(Math.max(scrub + (e.key === 'ArrowRight' ? 0.1 : -0.1), 0), totalDur);
        seek(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, stopAll, seek, scrub, totalDur, trimIndex]);

  useEffect(() => { if (musicGainRef.current) musicGainRef.current.gain.value = bgmVolume / 100; }, [bgmVolume]);
  useEffect(() => { if (voiceGainRef.current) voiceGainRef.current.gain.value = voiceVolume / 100; }, [voiceVolume]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setImporting(true); const fd = new FormData(); fd.append('file', file);
    try { const r = await fetch(`${bu}/api/music/import`, { method: 'POST', body: fd }); const d = await r.json(); if (d?.data) { setMusicList(prev => [...prev, d.data]); setBgmName(d.data.name); } } catch {} finally { setImporting(false); }
  }, [bu, setBgmName]);

  const hasVoice = !!audioPath;

  /* Trim 模式派生：预览框内容切换依据（片段防御性缺失时视为非 Trim） */
  const trimActive = trimIndex !== null && !!tl[trimIndex];
  const trimSeg = trimActive ? tl[trimIndex as number] : undefined;

  return (
    <Paper elevation={1} sx={{ p: 1.5, mt: 1 }}>
      {/* ── Aspect ratio switch (shared by preview + export, global) ── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, justifyContent: 'center', flexWrap: 'wrap' }}>
        <Typography variant="caption" fontSize="0.7rem">画幅</Typography>
        <Chip label="9:16" size="small" color={videoAspect === '9:16' ? 'primary' : 'default'} variant={videoAspect === '9:16' ? 'filled' : 'outlined'} onClick={() => setVideoAspect('9:16')} sx={{ cursor: 'pointer', height: 24 }} />
        <Chip label="3:4" size="small" color={videoAspect === '3:4' ? 'primary' : 'default'} variant={videoAspect === '3:4' ? 'filled' : 'outlined'} onClick={() => setVideoAspect('3:4')} sx={{ cursor: 'pointer', height: 24 }} />
        <Typography variant="caption" fontSize="0.65rem" color="text.secondary">{videoAspect}</Typography>
        <Typography variant="caption" fontSize="0.7rem" sx={{ ml: 1 }}>分辨率</Typography>
        <Chip label="1080p" size="small" color={videoResolution === '1080p' ? 'primary' : 'default'} variant={videoResolution === '1080p' ? 'filled' : 'outlined'} onClick={() => setVideoResolution('1080p')} sx={{ cursor: 'pointer', height: 24 }} />
        <Chip label="2K" size="small" color={videoResolution === '2K' ? 'primary' : 'default'} variant={videoResolution === '2K' ? 'filled' : 'outlined'} onClick={() => setVideoResolution('2K')} sx={{ cursor: 'pointer', height: 24 }} />
        <Typography variant="caption" fontSize="0.65rem" color="text.secondary">{resolution.width}×{resolution.height}</Typography>
      </Box>
      {/* ── Video preview with subtitle overlay ── */}
      <Box sx={{ width: 320, mx: 'auto', mb: 1 }}>
        <Box sx={{ position: 'relative', width: '100%', paddingBottom: videoAspect === '3:4' ? '133.33%' : '177.78%', bgcolor: '#000', borderRadius: 1, overflow: 'hidden' }}>
          {/* 首次加载（尚无画面）才显示整屏占位 */}
          {pvLoading && !pvUrl && <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography color="grey.400" fontSize="0.75rem">⏳ 正在准备预览...</Typography></Box>}
          {/* 重合成期间不卸载旧 <video>，避免黑屏闪烁；仅叠加加载角标。
              Trim 模式下保持挂载但 display:none（保留 currentTime/src，退出即原样恢复，无黑闪） */}
          {pvUrl && (
            <video key={pvUrl} ref={videoRef} src={pvUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', display: trimActive ? 'none' : 'block' }}
              onLoadedMetadata={(e) => setPvDur(e.currentTarget.duration)}
              onEnded={() => { setPlaying(false); stopAll(); }} muted playsInline />
          )}
          {/* Trim 模式：预览框切换为被 trim 片段的素材源实时画面（同尺寸/objectFit，布局不跳变）。
              静音 + preload auto；loadedmetadata 时落到进入时的入点，之后由拖拽联动 seek。 */}
          {trimActive && trimSeg && (
            <video ref={trimVideoRef} src={videoUrl(bu, trimSeg.video_path)}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
              onLoadedMetadata={(e) => { e.currentTarget.currentTime = trimTimeRef.current; }}
              muted playsInline preload="auto" />
          )}
          {pvLoading && pvUrl && (
            <Box sx={{ position: 'absolute', top: 4, left: 8, zIndex: 6, px: 0.75, py: 0.25, borderRadius: 1, bgcolor: 'rgba(0,0,0,0.6)', pointerEvents: 'none' }}>
              <Typography color="grey.200" fontSize="0.6rem">⟳ 更新预览…</Typography>
            </Box>
          )}
          {/* Subtitle overlay（Trim 取景时无关，隐藏） */}
          {pvUrl && !trimActive && subs.map((sub, i) => {
            const vis = scrub >= sub.start && scrub < sub.end;
            if (!vis) return null;
            return (
              <Box key={i} onDoubleClick={(e: React.MouseEvent) => openEdit(i, e)}
                sx={{ position: 'absolute', left: `${sub.x}%`, top: `${sub.y}%`, transform: 'translate(-50%,-50%)', textAlign: 'center', maxWidth: '90%', cursor: 'grab', zIndex: 5, userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                style={{ fontFamily: sf, fontSize: `${ss / 100 * 320}px`, color: sc, fontWeight: 700, lineHeight: 1.2, letterSpacing: `${sLs}px`, textShadow: sw > 0 ? ts : '0 0 4px rgba(0,0,0,0.8)' }}>
                {sub.text}
              </Box>);
          })}
          {/* Safe-area reference overlay (toggle via 安全区 chip; Trim 取景时隐藏) */}
          {pvUrl && showSafe && !trimActive && (
            <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}>
              <Box sx={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.25) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.25) 1px, transparent 1px)', backgroundSize: '33.33% 33.33%' }} />
              <Box sx={{ position: 'absolute', left: '50%', top: '50%', width: 16, height: 16, transform: 'translate(-50%,-50%)', border: '1px solid rgba(255,80,80,0.9)', borderRadius: '50%' }} />
              <Box sx={{ position: 'absolute', inset: '5%', border: '1px dashed rgba(255,255,255,0.7)' }} />
            </Box>
          )}
          {!pvLoading && !pvUrl && tl.length === 0 && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography color="grey.600" fontSize="0.75rem">生成时间线后预览</Typography></Box>
          )}
          {!pvLoading && !pvUrl && tl.length > 0 && (
            <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography color="grey.500" fontSize="0.75rem">预览生成失败</Typography></Box>
          )}
          <Box sx={{ position: 'absolute', bottom: 4, right: 8, color: '#fff', fontSize: '0.65rem', fontFamily: 'monospace', bgcolor: 'rgba(0,0,0,0.5)', px: 1, borderRadius: 1 }}>
            {trimActive && trimSeg
              ? `${trimTime.toFixed(1)}s / ${(trimSeg.source_duration ?? 0).toFixed(1)}s`
              : `${scrub.toFixed(1)}s / ${totalDur.toFixed(1)}s`}
          </Box>
        </Box>
      </Box>

      {/* ── P2: 重选时段（Trim）— 双击片段后展开，位于预览框与视频轨之间 ── */}
      {trimActive && trimIndex !== null && (
        <TrimEditor
          segmentIndex={trimIndex}
          onClose={handleTrimClose}
          onBoxTimeChange={handleTrimBoxTimeChange}
          onDragStart={handleTrimDragStart}
          auditioning={trimAudition}
          onToggleAudition={handleToggleAudition}
        />
      )}

      {/* ── P1+P3: FcpTimeline 三轨时间轴（T1 视频轨 + T2 字幕轨 + T3 音频波形轨） ── */}
      <FcpTimeline
        scrub={scrub}
        totalDur={totalDur}
        onScrub={(t) => { setScrub(t); if (videoRef.current) videoRef.current.currentTime = t; }}
        onScrubCommit={seek}
        playing={playing}
        canPlay={!(!hasVoice && tl.length === 0)}
        onTogglePlay={() => (playing ? (stopAll(), setPlaying(false)) : play(scrub))}
        onStop={() => { stopAll(); setScrub(0); }}
        hasVoice={hasVoice}
        showSafe={showSafe}
        onToggleSafe={() => setShowSafe(v => !v)}
        trimActive={trimActive}
        onTrimRequest={handleTrimRequest}
        // P3：T2 字幕轨（只读联动 + 双击走现有 openEdit Popover）
        subs={subs}
        onSubtitleEdit={openEdit}
        // P3：T3 音频轨（峰值复用已解码 buffer；音量/静音走现有 store 字段）
        voicePeaks={voicePeaks?.peaks ?? null}
        voiceDur={voicePeaks?.dur ?? 0}
        bgmPeaks={bgmPeaks?.peaks ?? null}
        bgmDur={bgmPeaks?.dur ?? 0}
        voiceVolume={voiceVolume}
        bgmVolume={bgmVolume}
        onVoiceVolume={setVoiceVolume}
        onBgmVolume={setBgmVolume}
        bgmName={bgmName}
      />

      {/* 素材时长未知时的 Trim 拦截提示 */}
      <Snackbar
        open={trimHint}
        autoHideDuration={2500}
        onClose={() => setTrimHint(false)}
        message="素材时长未知，无法重选时段"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />

      {/* Subtitle & music controls moved to right panel (StepRightPanel) */}
    </Paper>
  );
};

/* ─── Cover Editor (exported for StepRightPanel) ─── */
const COVER_PREVIEW_FONT_FAMILY = 'coverPreviewFont';
export interface CoverDraft {
  coverVideoPath: string;
  coverTime: number;
  coverTitle: string;
  coverSubtitle: string;
  coverTitleX: number;
  coverTitleY: number;
  coverSubX: number;
  coverSubY: number;
  coverTitleSize: number;
  coverSubSize: number;
  coverTitleColor: string;
  coverSubColor: string;
  coverTitleStrokeColor: string;
  coverTitleStrokeWidth: number;
  coverSubStrokeColor: string;
  coverSubStrokeWidth: number;
  coverTitleItalic: boolean;
  coverSubItalic: boolean;
  coverZoom: number;
  coverOffsetX: number;
  coverOffsetY: number;
  coverFont: string;
  coverFontPath: string;
}

interface CoverEditorProps {
  value: CoverDraft;
  onPatch: (patch: Partial<CoverDraft>) => void;
  /** 预览框高度(px)，宽度按画幅自动推导。抽屉里传较大值以放大预览。 */
  previewH?: number;
}

export const CoverEditor: React.FC<CoverEditorProps> = ({ value, onPatch, previewH = 320 }) => {
  const tl = useEditingStore(s => s.timeline);
  const aspect = useEditingStore(s => s.videoAspect);
  const favCoverFonts = useEditingStore(s => s.favCoverFonts);
  const recentCoverFonts = useEditingStore(s => s.recentCoverFonts);
  const toggleFavCoverFont = useEditingStore(s => s.toggleFavCoverFont);
  const pushRecentCoverFont = useEditingStore(s => s.pushRecentCoverFont);

  const {
    coverVideoPath: vp, coverTime: ct, coverTitle: title, coverSubtitle: subtitle,
    coverTitleX: tx, coverTitleY: ty, coverSubX: sx, coverSubY: sy,
    coverTitleSize: ts, coverSubSize: tsc, coverTitleColor: tc, coverSubColor: tbc,
    coverTitleStrokeColor: ctsk, coverTitleStrokeWidth: ctsw,
    coverSubStrokeColor: cssk, coverSubStrokeWidth: cssw,
    coverTitleItalic: ti, coverSubItalic: si,
    coverZoom: zoom, coverOffsetX: offX, coverOffsetY: offY,
    coverFont, coverFontPath,
  } = value;

  const patch = useCallback((p: Partial<CoverDraft>) => onPatch(p), [onPatch]);

  const src = vp || tl[0]?.video_path || '';
  const [dTitle, setDTitle] = useState(false);
  const [dSub, setDSub] = useState(false);
  const [dPan, setDPan] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [coverFtList, setCoverFtList] = useState<FontEntry[]>([]);
  const CV = useRef<HTMLDivElement>(null);
  const bu: string = useBackendUrl();

  useEffect(() => {
    fetch(`${bu}/api/ai-editing/fonts`).then(r => r.json()).then(d => {
      if (d?.data?.fonts?.length) setCoverFtList(d.data.fonts);
    }).catch(() => {});
  }, [bu]);

  // Bug 1 fix: load the selected cover font as a real CSS @font-face so the
  // preview reflects the chosen font. The export path already uses
  // `coverFontPath` via ffmpeg drawtext; the preview must mirror it.
  // We fetch the binary from the backend and turn it into a blob: URL, which
  // bypasses the 5173↔18000 cross-origin restriction that blocks @font-face
  // from pointing directly at the backend URL.
  const [coverFontTick, setCoverFontTick] = useState(0);
  const coverFontUrlRef = useRef<string | null>(null);

  useEffect(() => {
    const path = coverFontPath;
    if (!path) return;
    let cancelled = false;
        (async () => {
      try {
        const baseUrl = await getBackendBaseUrl();
        // Browsers do not support .ttc (TrueType Collection) via @font-face.
        // Skip blob-URL injection for .ttc — the cover preview will use
        // the system-installed font via CSS font-family fallback instead.
        // (Subtitle side already does this at loadFontFace L103.)
                if (path.toLowerCase().endsWith('.ttc')) {
          // Clear any previous @font-face for 'coverPreviewFont' so the CSS
          // fallback chain ('coverPreviewFont', '${coverFont}', sans-serif)
          // truly falls through to the system font. Without this, switching
          // from a .ttf font to a .ttc font leaves the old .ttf @font-face
          // registered, causing ExportConfirm's measureTextWidth to measure
          // with the WRONG font (old .ttf metrics) and B+ to mis-calculate
          // the shrink/position — potentially truncating the title.
          const el = document.getElementById('cover-preview-font') as HTMLStyleElement | null;
          if (el) el.textContent = '';
          if (coverFontUrlRef.current) {
            URL.revokeObjectURL(coverFontUrlRef.current);
            coverFontUrlRef.current = null;
          }
          return;
        }
        if (cancelled) return;
        const resp = await fetch(`${baseUrl}/api/ai-editing/font-file?path=${encodeURIComponent(path)}`);
        if (!resp.ok || cancelled) return;
        const blob = await resp.blob();
        if (cancelled) return;
        const blobUrl = URL.createObjectURL(blob);
        const ext = (path.split('.').pop() || 'ttf').toLowerCase();
        const formatMap: Record<string, string> = {
          ttf: 'truetype', otf: 'opentype', ttc: 'truetype',
          woff: 'woff', woff2: 'woff2',
        };
        const format = formatMap[ext] || 'truetype';
        let el = document.getElementById('cover-preview-font') as HTMLStyleElement | null;
        if (!el) {
          el = document.createElement('style');
          el.id = 'cover-preview-font';
          document.head.appendChild(el);
        }
        el.textContent = `@font-face { font-family: '${COVER_PREVIEW_FONT_FAMILY}'; src: url(${blobUrl}) format('${format}'); }`;
        // Release the previous blob URL before overwriting the ref (avoid leak).
        if (coverFontUrlRef.current) {
          URL.revokeObjectURL(coverFontUrlRef.current);
        }
        coverFontUrlRef.current = blobUrl;
        // Trigger a first re-render so the @font-face takes effect.
        setCoverFontTick((t) => t + 1);
        // Wait for the font to actually load, then re-render once more so the
        // preview text is guaranteed to repaint with the new font.
        try {
          await document.fonts.load(`10px '${COVER_PREVIEW_FONT_FAMILY}'`);
          await document.fonts.ready;
        } catch {
          // Font may fail to load; we already re-rendered with the new @font-face.
        }
        if (!cancelled) setCoverFontTick((t) => t + 1);
      } catch {
        // Network/backend error — keep the default font fallback in place.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [coverFontPath]);

  // Bug 1 fix: release the blob URL when the component unmounts.
  useEffect(() => {
    return () => {
      if (coverFontUrlRef.current) {
        URL.revokeObjectURL(coverFontUrlRef.current);
        coverFontUrlRef.current = null;
      }
    };
  }, []);

  // Cover dimensions (preview box scaled by previewH prop)
  const pH = previewH;
  const pW = aspect === '3:4' ? Math.round(previewH * 3 / 4) : Math.round(previewH * 9 / 16);
  // 预览框高度相对 320 基准框的缩放系数。滑杆/导出语义仍以 320 框为基准
  // （导出端 ×COVER_SCALE，320→成片高），抽屉里 previewH 更大时字号/描边
  // 必须随 k 同步放大，否则预览中的标题占比比导出结果偏小偏细（WYSIWYG 漂移）。
  const k = pH / 320;

  // WYSIWYG cover-fit: compute the effective title/subtitle geometry (shift /
  // shrink) in PREVIEW coordinates so the preview matches the export 1:1. The
  // fit is recomputed whenever the text, font, size, anchor, or the loaded
  // cover font (coverFontTick bumps after the @font-face finishes loading)
  // changes, so the visible overlay always reflects the final export geometry.
  const titleFit = useMemo(
    () => title
      ? fitTitleLine(
          title,
          { fontFamily: `'${COVER_PREVIEW_FONT_FAMILY}', '${coverFont}', sans-serif`, fontWeight: 800, fontStyle: ti ? 'italic' : 'normal' },
          { fontSize: ts * k, titleX: tx, titleY: ty, canvasW: pW, canvasH: pH, safeMargin: 0.04, strokeWidth: ctsw * k },
        )
      : { fontSize: ts * k, titleX: tx, titleY: ty, adjusted: false, didShrink: false },
    [title, ti, ts, tx, ty, ctsw, pW, pH, k, coverFontTick],
  );
  const subFit = useMemo(
    () => subtitle
      ? fitTitleLine(
          subtitle,
          { fontFamily: `'${COVER_PREVIEW_FONT_FAMILY}', '${coverFont}', sans-serif`, fontWeight: 600, fontStyle: si ? 'italic' : 'normal' },
          { fontSize: tsc * k, titleX: sx, titleY: sy, canvasW: pW, canvasH: pH, safeMargin: 0.04, strokeWidth: cssw * k },
        )
      : { fontSize: tsc * k, titleX: sx, titleY: sy, adjusted: false, didShrink: false },
    [subtitle, si, tsc, sx, sy, cssw, pW, pH, k, coverFontTick],
  );

  const frameUrl = useMemo(() => src ? `${bu}/api/ai-editing/thumb?path=${encodeURIComponent(src)}&t=${ct}&aspect=${aspect}` : '', [src, ct, aspect, bu]);

  const handleCDrag = useCallback((e: React.MouseEvent, isTitle: boolean) => {
    if (!CV.current) return;
    const r = CV.current.getBoundingClientRect();
    const x = +((e.clientX - r.left) / r.width * 100).toFixed(1);
    const y = +((e.clientY - r.top) / r.height * 100).toFixed(1);
    if (isTitle) { patch({ coverTitleX: x, coverTitleY: y }); } else { patch({ coverSubX: x, coverSubY: y }); }
  }, [patch]);

  return (
    <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt', mt: 2 }}>
      <Typography variant="subtitle2" gutterBottom><MovieIcon sx={{ mr: 0.5, verticalAlign: 'middle', fontSize: 18 }} />视频封面</Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {/* Frame preview */}
        <Box ref={CV} sx={{ position: 'relative', width: pW, height: pH, bgcolor: '#000', borderRadius: 1, overflow: 'hidden', flexShrink: 0, cursor: 'grab' }}>
          <Box style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}
            onMouseDown={e => { setDPan(true); setPanStart({ x: e.clientX - offX, y: e.clientY - offY }); }}>
            {frameUrl && <img src={frameUrl} alt="" style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              // Mirror backend render_cover() frame geometry 1:1 so the step-3
              // preview is WYSIWYG with the exported cover:
              //   backend : scale = W*zoom : H*zoom  (a pure STRETCH, no aspect
              //            preservation) + crop = W:H  (center-crop when zoom!=1,
              //            identity when zoom=1) + crop-window offset (offset_x/Y).
              //   preview : objectFit:'fill' stretches the thumbnail onto the box
              //            (== backend stretch); CSS scale(zoom) reproduces the
              //            zoom-in / zoom-out; translate(offX,offY) reproduces the
              //            crop-window offset. The old maxWidth/maxHeight 'contain'
              //            letterboxed the frame, which diverged from the export's
              //            fill/crop and made the title look mis-placed.
              objectFit: 'fill',
              transform: `translate(${offX}px, ${offY}px) scale(${zoom})`,
              transformOrigin: 'center center',
            }} onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }} />}
          </Box>
          {/* Title overlay — WYSIWYG: rendered with the SAME effective geometry the
              export will burn (computed by fitTitleLine: shift first, shrink only
              if it still overflows the safe margin). */}
          {title && <Typography
            key={`cover-title-${coverFontTick}`}
            onMouseDown={e => { e.stopPropagation(); setDTitle(true); }}
            sx={{ position: 'absolute', left: `${titleFit.titleX}%`, top: `${titleFit.titleY}%`, transform: 'translate(-50%,-50%)', cursor: 'grab', textAlign: 'center', maxWidth: '100%', userSelect: 'none', whiteSpace: 'nowrap',
              fontFamily: `'${COVER_PREVIEW_FONT_FAMILY}', '${coverFont}', sans-serif`, fontSize: `${titleFit.fontSize}px`, color: tc, fontWeight: 800, fontStyle: ti ? 'italic' : 'normal',
            }}
            style={{
              WebkitTextStroke: ctsw > 0 ? `${ctsw * k}px ${ctsk}` : undefined,
              paintOrder: ctsw > 0 ? 'stroke fill' : undefined,
              textShadow: ctsw <= 0 ? '0 2px 8px rgba(0,0,0,0.8)' : undefined,
            }}>{title}</Typography>}
          {/* Subtitle overlay — same WYSIWYG treatment as the title. */}
          {subtitle && <Typography
            key={`cover-sub-${coverFontTick}`}
            onMouseDown={e => { e.stopPropagation(); setDSub(true); }}
            sx={{ position: 'absolute', left: `${subFit.titleX}%`, top: `${subFit.titleY}%`, transform: 'translate(-50%,-50%)', cursor: 'grab', textAlign: 'center', maxWidth: '100%', userSelect: 'none', whiteSpace: 'nowrap',
              fontFamily: `'${COVER_PREVIEW_FONT_FAMILY}', '${coverFont}', sans-serif`, fontSize: `${subFit.fontSize}px`, color: tbc, fontWeight: 600, fontStyle: si ? 'italic' : 'normal',
            }}
            style={{
              WebkitTextStroke: cssw > 0 ? `${cssw * k}px ${cssk}` : undefined,
              paintOrder: cssw > 0 ? 'stroke fill' : undefined,
              textShadow: cssw <= 0 ? '0 2px 6px rgba(0,0,0,0.7)' : undefined,
            }}>{subtitle}</Typography>}
          {/* 导出安全区参考线：内缩 4%（与 fitTitleLine safeMargin 一致），
              超出此虚线框的文字在导出时可能被裁切，提示用户留白。 */}
          <Box sx={{ position: 'absolute', inset: '4%', border: '1px dashed rgba(255,255,255,0.45)', borderRadius: 1, pointerEvents: 'none', zIndex: 2 }} />
          {/* WYSIWYG auto-fit badges: inform the user when a line was shifted or
              shrunk to avoid being cropped at the cover edges. */}
          {titleFit.adjusted && (
            <Chip size="small" label={titleFit.didShrink ? '主标题已缩放适配' : '主标题已平移适配'}
              title="标题超出安全区，已自动适配以避免导出裁切"
              sx={{ position: 'absolute', left: 4, top: 4, height: 18, fontSize: '0.6rem', zIndex: 3, bgcolor: 'rgba(255,255,255,0.88)' }} />
          )}
          {subFit.adjusted && (
            <Chip size="small" label={subFit.didShrink ? '副标题已缩放适配' : '副标题已平移适配'}
              title="副标题超出安全区，已自动适配以避免导出裁切"
              sx={{ position: 'absolute', left: 4, top: titleFit.adjusted ? 26 : 4, height: 18, fontSize: '0.6rem', zIndex: 3, bgcolor: 'rgba(255,255,255,0.88)' }} />
          )}
        </Box>
        {/* Controls */}
        <Box sx={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Box sx={{ minWidth: 130, position: 'relative' }}>
            <Box
              onClick={() => setPickerOpen(o => !o)}
              sx={{ display: 'flex', alignItems: 'center', gap: 1, p: '4px 6px', borderRadius: 1, border: '1px solid', borderColor: 'divider', fontSize: '0.8rem', cursor: 'pointer', bgcolor: 'background.paper', userSelect: 'none' }}
            >
              {src && (
                <img src={`${bu}/api/ai-editing/thumb?path=${encodeURIComponent(src)}&t=${ct}&aspect=${aspect}`} alt="" style={{ width: 36, height: 48, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
              )}
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(vp || tl[0]?.video_path || '').split(/[\\/]/).pop()}
              </span>
              <span style={{ fontSize: '0.7rem', color: '#888' }}>▾</span>
            </Box>
            {pickerOpen && (
              <Box sx={{ position: 'absolute', zIndex: 1000, mt: 0.5, width: '100%', bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 1, boxShadow: 3, p: 0.5, overflow: 'visible' }}>
                {tl.map((s, i) => (
                  <Box key={i} className="cover-opt"
                    onClick={() => { patch({ coverVideoPath: s.video_path }); setPickerOpen(false); }}
                    sx={{
                      position: 'relative', display: 'flex', alignItems: 'center', gap: 1, p: 0.5, cursor: 'pointer', borderRadius: 1,
                      '&:hover': { bgcolor: 'action.hover' },
                      '&:hover .zoom': { opacity: 1, transform: 'scale(1)' },
                    }}
                  >
                    <img src={`${bu}/api/ai-editing/thumb?path=${encodeURIComponent(s.video_path)}&t=${ct}&aspect=${aspect}`} alt="" style={{ width: 44, height: 60, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                    <span style={{ fontSize: '0.72rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      #{i + 1} {s.video_path?.split(/[\\/]/).pop()}
                    </span>
                    <Box className="zoom" sx={{
                      position: 'absolute', right: '100%', top: 0, mr: 1, width: 264, height: 360,
                      opacity: 0, transform: 'scale(0.92)', transformOrigin: 'right center',
                      transition: 'opacity .18s cubic-bezier(.16,1,.3,1), transform .18s cubic-bezier(.16,1,.3,1)',
                      pointerEvents: 'none', zIndex: 50, borderRadius: 1, overflow: 'hidden', boxShadow: 6, bgcolor: '#000',
                    }}>
                      <img src={`${bu}/api/ai-editing/thumb?path=${encodeURIComponent(s.video_path)}&t=${ct}&aspect=${aspect}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    </Box>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
          <Box>
            <Typography variant="caption">截取时间 {ct.toFixed(1)}s</Typography>
            <Slider size="small" value={ct} min={0} max={20} step={0.1} onChange={(_, v) => patch({ coverTime: v as number })} />
          </Box>
          <TextField size="small" label="主标题" value={title} onChange={e => patch({ coverTitle: e.target.value })} fullWidth />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Box><input type="color" value={tc} onChange={e => patch({ coverTitleColor: e.target.value })} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 4 }} title="主标题颜色" /></Box>
            <Typography variant="caption" sx={{ minWidth: 24 }}>{ts}px</Typography>
            <Slider size="small" value={ts} min={12} max={80} step={1} onChange={(_, v) => patch({ coverTitleSize: v as number })} sx={{ width: 60 }} />
            <Chip label={ti ? '斜体' : '正体'} size="small" variant={ti ? 'filled' : 'outlined'} color={ti ? 'primary' : 'default'}
              onClick={() => patch({ coverTitleItalic: !ti })} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
          </Box>
          <TextField size="small" label="副标题" value={subtitle} onChange={e => patch({ coverSubtitle: e.target.value })} fullWidth />
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Box><input type="color" value={tbc} onChange={e => patch({ coverSubColor: e.target.value })} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 4 }} title="副标题颜色" /></Box>
            <Typography variant="caption" sx={{ minWidth: 24 }}>{tsc}px</Typography>
            <Slider size="small" value={tsc} min={12} max={60} step={1} onChange={(_, v) => patch({ coverSubSize: v as number })} sx={{ width: 60 }} />
            <Chip label={si ? '斜体' : '正体'} size="small" variant={si ? 'filled' : 'outlined'} color={si ? 'primary' : 'default'}
              onClick={() => patch({ coverSubItalic: !si })} sx={{ cursor: 'pointer', height: 22, fontSize: '0.65rem' }} />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="caption" fontWeight={600}>主标题描边</Typography>
            <Box><input type="color" value={ctsk} onChange={e => patch({ coverTitleStrokeColor: e.target.value })} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 4 }} title="主标题描边颜色" /></Box>
            <Typography variant="caption">{ctsw}px</Typography>
            <Slider size="small" value={ctsw} min={0} max={8} step={0.5} onChange={(_, v) => patch({ coverTitleStrokeWidth: v as number })} sx={{ width: 60 }} />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="caption" fontWeight={600}>副标题描边</Typography>
            <Box><input type="color" value={cssk} onChange={e => patch({ coverSubStrokeColor: e.target.value })} style={{ width: 28, height: 24, border: 'none', cursor: 'pointer', borderRadius: 4 }} title="副标题描边颜色" /></Box>
            <Typography variant="caption">{cssw}px</Typography>
            <Slider size="small" value={cssw} min={0} max={8} step={0.5} onChange={(_, v) => patch({ coverSubStrokeWidth: v as number })} sx={{ width: 60 }} />
          </Box>
          <Box sx={{ minWidth: 150 }}>
            <FontSelect
              label="封面字体"
              value={coverFont}
              fonts={coverFtList}
              favorites={favCoverFonts}
              recents={recentCoverFonts}
              onChange={(nm: string) => {
                const entry = coverFtList.find(f => f.name === nm);
                patch({ coverFont: nm, ...(entry ? { coverFontPath: entry.path } : {}) });
                pushRecentCoverFont(nm);
              }}
              onToggleFav={toggleFavCoverFont}
            />
          </Box>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Typography variant="caption" color="text.secondary">封面画幅自动跟随成片（{aspect}）</Typography>
            <Typography variant="caption">缩放{zoom.toFixed(1)}x</Typography>
            <Slider size="small" value={zoom} min={0.2} max={3.0} step={0.1} onChange={(_, v) => patch({ coverZoom: v as number })} sx={{ width: 60 }} />
          </Box>
          <Typography variant="caption" color="text.secondary">拖拽画面平移 · 拖拽标题调整位置</Typography>
          {/* Style presets */}
          <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid #ddd' }}>
            <Typography variant="caption" fontWeight={600}>封面样式预设</Typography>
            <CoverPresets
              onLoad={(s) => {
                if (s.titleSize) patch({ coverTitleSize: s.titleSize });
                if (s.subSize) patch({ coverSubSize: s.subSize });
                if (s.titleColor) patch({ coverTitleColor: s.titleColor });
                if (s.subColor) patch({ coverSubColor: s.subColor });
                if (s.titleStrokeColor) patch({ coverTitleStrokeColor: s.titleStrokeColor });
                if (s.titleStrokeWidth !== undefined) patch({ coverTitleStrokeWidth: s.titleStrokeWidth });
                if (s.subStrokeColor) patch({ coverSubStrokeColor: s.subStrokeColor });
                if (s.subStrokeWidth !== undefined) patch({ coverSubStrokeWidth: s.subStrokeWidth });
                if (s.tx !== undefined && s.ty !== undefined && s.sx !== undefined && s.sy !== undefined) patch({ coverTitleX: s.tx, coverTitleY: s.ty, coverSubX: s.sx, coverSubY: s.sy });
                if (s.font) patch({ coverFont: s.font });
                if (s.fontPath) patch({ coverFontPath: s.fontPath });
                if (s.titleItalic !== undefined) patch({ coverTitleItalic: s.titleItalic });
                if (s.subItalic !== undefined) patch({ coverSubItalic: s.subItalic });
              }}
              currentStyle={{ titleSize: ts, subSize: tsc, titleColor: tc, subColor: tbc, titleStrokeColor: ctsk, titleStrokeWidth: ctsw, subStrokeColor: cssk, subStrokeWidth: cssw, tx, ty, sx, sy, font: coverFont, fontPath: coverFontPath, titleItalic: ti, subItalic: si }}
            />
          </Box>
        </Box>
      </Box>
      {/* Drag handler for titles */}
      {(dTitle || dSub) && (
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'grabbing' }}
          onMouseMove={e => handleCDrag(e, dTitle)}
          onMouseUp={() => { setDTitle(false); setDSub(false); }}
          onMouseLeave={() => { setDTitle(false); setDSub(false); }}
        />
      )}
      {/* Pan handler for cover image */}
      {dPan && (
        <Box sx={{ position: 'fixed', inset: 0, zIndex: 9999, cursor: 'grabbing' }}
          onMouseMove={e => { patch({ coverOffsetX: e.clientX - panStart.x, coverOffsetY: e.clientY - panStart.y }); }}
          onMouseUp={() => setDPan(false)}
          onMouseLeave={() => setDPan(false)}
        />
      )}
    </Paper>
  );
};

/* ─── Cover Style Presets ─── */
export interface CoverStyle { titleSize: number; subSize: number; titleColor: string; subColor: string; titleStrokeColor: string; titleStrokeWidth: number; subStrokeColor: string; subStrokeWidth: number; tx: number; ty: number; sx: number; sy: number; font: string; fontPath: string; titleItalic: boolean; subItalic: boolean; }

export const CoverPresets: React.FC<{ onLoad: (s: Partial<CoverStyle>) => void; currentStyle: CoverStyle }> = ({ onLoad, currentStyle }) => {
  const [presets, setPresets] = useState<Record<string, CoverStyle>>({});
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    try { setPresets(JSON.parse(localStorage.getItem('cover_presets') || '{}')); } catch { }
  }, []);

  const save = () => {
    const n = name.trim() || `样式${Date.now() % 10000}`;
    const p = { ...presets, [n]: currentStyle };
    localStorage.setItem('cover_presets', JSON.stringify(p));
    setPresets(p); setName(''); setMsg(`已保存「${n}」`); setTimeout(() => setMsg(''), 2000);
  };
  const load = () => {
    if (!selected || !presets[selected]) return;
    onLoad(presets[selected]);
    setMsg(`已加载「${selected}」`); setTimeout(() => setMsg(''), 2000);
  };
  const del = () => {
    if (!selected) return;
    const p = { ...presets }; delete p[selected];
    localStorage.setItem('cover_presets', JSON.stringify(p));
    setPresets(p); setSelected('');
  };

  const names = Object.keys(presets);

  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
      {names.length > 0 && (
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ padding: '2px 4px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.75rem', maxWidth: 120 }}>
          <option value="">选择预设...</option>
          {names.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      )}
      <TextField size="small" placeholder="预设名称" value={name} onChange={e => setName(e.target.value)} sx={{ width: 100, '& input': { fontSize: '0.75rem', py: 0.5 } }} />
      <Button size="small" variant="outlined" onClick={save} sx={{ fontSize: '0.7rem', py: 0.2 }}>保存</Button>
      {names.length > 0 && <Button size="small" variant="outlined" onClick={load} sx={{ fontSize: '0.7rem', py: 0.2 }}>加载</Button>}
      {selected && <IconButton size="small" onClick={del}><Typography variant="caption" sx={{ fontSize: '0.65rem', color: 'error.main' }}>删除</Typography></IconButton>}
      {msg && <Typography variant="caption" color="success.main">{msg}</Typography>}
    </Box>
  );
};

export default TimelineEditor;
