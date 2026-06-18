/**
 * TimelineEditor: seekable track, preview play, draggable subs, font paths, strip punctuation.
 */
import React, { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import {
  Box, Typography, Paper, Button, IconButton, Slider, Dialog, DialogTitle, DialogContent,
  Chip, Tooltip, Popover,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import StopIcon from '@mui/icons-material/Stop';
import SwapHorizIcon from '@mui/icons-material/SwapHoriz';
import SubtitlesIcon from '@mui/icons-material/Subtitles';
import PreviewIcon from '@mui/icons-material/Preview';
import { useEditingStore } from '@/renderer/store/editing-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { AnyMaterial } from '@/renderer/types/material';

const API = 'http://127.0.0.1:18000';
const THUMB = `${API}/api/ai-editing/thumb`;
const VIDEO = `${API}/api/ai-editing/video`;
const TRACK_H = 60; const AUDIO_H = 28; const PX_SEC = 80; const EDGE = 10;

function fp(path: string) { return encodeURIComponent((path || '').replace(/\\/g, '/')); }
function thumb(path: string, t: number) { return `${THUMB}?path=${fp(path)}&t=${t.toFixed(1)}`; }
function stripPunct(s: string) { return (s || '').replace(/[，,。！？；：、""''（）()\\.!?;:'"“”\s]+/g, ''); }

/* ─── Material Picker ─── */
const Pick: React.FC<{ o: boolean; c: () => void; p: string; s: (v: string) => void }> = ({ o, c, p, s }) => {
  const m = useMaterialsStore(x => x.materials).filter((x: AnyMaterial) => x.type === 'video');
  const [v, setV] = useState(p);
  useEffect(() => { setV(p); }, [p]);
  return (<Dialog open={o} onClose={c} maxWidth="md" fullWidth><DialogTitle>替换</DialogTitle><DialogContent>
    <Box sx={{ display: 'flex', gap: 2, minHeight: 280 }}><Box sx={{ flex: 1 }}><Box sx={{ bgcolor: '#000', borderRadius: 1, mb: 1 }}>
      <video src={`${VIDEO}?path=${fp(v)}`} style={{ width: '100%', maxHeight: 200 }} controls /></Box></Box>
      <Box sx={{ flex: 1, overflowY: 'auto', maxHeight: 360 }}>
        {m.map((x: AnyMaterial) => { const fp2 = (x.filePath || '') as string;
          return (<Paper key={fp2 || x.id} elevation={fp2 === p ? 2 : 0}
            sx={{ p: 1, mb: 1, cursor: 'pointer', border: fp2 === p ? 2 : 1, borderColor: fp2 === p ? 'primary.main' : 'grey.200', display: 'flex', gap: 1, alignItems: 'center' }}
            onDoubleClick={() => { s(fp2); c(); }} onClick={() => setV(fp2)}>
            <img src={thumb(fp2, 1)} alt="" style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 4, background: '#eee' }}
              onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <Box sx={{ flex: 1, minWidth: 0 }}><Typography variant="body2" noWrap>{x.fileName || fp2.split(/[\\/]/).pop()}</Typography></Box></Paper>); })}</Box></Box></DialogContent></Dialog>);
};

/* ─── Font entry ─── */
interface FontEntry { name: string; path: string; }

/* ─── Main ─── */
const TimelineEditor: React.FC = () => {
  const tl = useEditingStore(s => s.timeline); const setTl = useEditingStore(s => s.setTimeline);
  const adur = useEditingStore(s => s.audioDuration);
  const sf = useEditingStore(s => s.subtitleFont); const sc = useEditingStore(s => s.subtitleColor);
  const ss = useEditingStore(s => s.subtitleSize); const sk = useEditingStore(s => s.subtitleStrokeColor);
  const sw = useEditingStore(s => s.subtitleStrokeWidth); const sfp = useEditingStore(s => s.subtitleFontPath);
  const sov = useEditingStore(s => s.subtitleOverrides); const setSov = useEditingStore(s => s.setSubtitleOverrides);
  const setSf = useEditingStore(s => s.setSubtitleFont); const setSc = useEditingStore(s => s.setSubtitleColor);
  const setSs = useEditingStore(s => s.setSubtitleSize); const setSk = useEditingStore(s => s.setSubtitleStrokeColor);
  const setSw = useEditingStore(s => s.setSubtitleStrokeWidth); const setSfp = useEditingStore(s => s.setSubtitleFontPath);
  const [sLs, setSLs] = useState(0);

  const [scrub, setScrub] = useState(0); const [playing, setPlaying] = useState(false);
  const [po, setPo] = useState(false); const [pi, setPi] = useState(0);
  const [di, setDi] = useState<number | null>(null); const [dx, setDx] = useState(0); const [ds, setDs] = useState(0);
  const [ed, setEd] = useState<{ i: number; s: 'L' | 'R'; x: number; ost: number; od: number; sd: number } | null>(null);
  const [he, setHe] = useState<{ i: number; s: 'L' | 'R' } | null>(null);
  const [fonts, setFonts] = useState<FontEntry[]>([{ name: 'Microsoft YaHei', path: 'C:/Windows/Fonts/msyh.ttc' }]);
  const [dSub, setDSub] = useState<number | null>(null);
  const [eSub, setESub] = useState<number | null>(null); const [eText, setEText] = useState('');
  const [ae, setAe] = useState<HTMLElement | null>(null);
  const [pvUrl, setPvUrl] = useState(''); const [pvLoading, setPvLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const cv = useRef<HTMLDivElement | null>(null); const pvRef = useRef<HTMLVideoElement | null>(null);

  /* ── Load fonts ── */
  useEffect(() => {
    fetch(`${API}/api/ai-editing/fonts`).then(r => r.json()).then(d => {
      if (d?.data?.fonts?.length) {
        setFonts(d.data.fonts);
        // Keep current font if it exists, otherwise first
        const cur = d.data.fonts.find((f: FontEntry) => f.name === sf);
        if (!cur && d.data.fonts[0]) {
          setSf(d.data.fonts[0].name);
          setSfp(d.data.fonts[0].path);
        }
      }
    }).catch(() => {});
  }, []);

  const handleFontChange = useCallback((name: string) => {
    setSf(name);
    const entry = fonts.find(f => f.name === name);
    if (entry) setSfp(entry.path);
  }, [fonts, setSf, setSfp]);

  /* ── Memo ── */
  const td = useMemo(() => { const d = tl.reduce((a, s) => a + (s.duration || 0), 0); return d || 15; }, [tl]);
  const tdr = useRef(td); useEffect(() => { tdr.current = td; }, [td]);
  const tw = useMemo(() => Math.max(td * PX_SEC, 800), [td]);
  const segs = useMemo(() => { let x = 0; return tl.map((s, i) => { const w = (s.duration || 1) * PX_SEC; return { ...s, index: i, sx: x, w }; x += w; }); }, [tl]);

  /* ── Frame preview ── */
  const [frame, setFrame] = useState('');
  useEffect(() => {
    if (!tl.length) { setFrame(''); return; }
    const seg = segs.find(s => scrub >= s.sx / PX_SEC && scrub < (s.sx + s.w) / PX_SEC);
    if (seg) { const t = (scrub - seg.sx / PX_SEC) + (seg.start_time || 0); setFrame(thumb(seg.video_path, t)); }
  }, [scrub, segs, tl]);

  /* ── Scrub ── */
  useEffect(() => { if (!playing) return; timer.current = setInterval(() => setScrub(p => p + 0.1 >= tdr.current ? 0 : p + 0.1), 100); return () => { if (timer.current) clearInterval(timer.current); }; }, [playing]);

  /* ── Subs ── */
  const subs = useMemo(() => {
    let t = 0;
    return tl.map((s, i) => { const ov = sov[i] || {}; const r = {
      i, start: t, end: t + (s.duration || 0),
      text: stripPunct(ov.text ?? s.segment_text),
      x: ov.x ?? 50, y: ov.y ?? 85
    }; t += s.duration || 0; return r; });
  }, [tl, sov]);

  /* ── Handlers ── */
  const cD = useCallback((i: number, e: React.MouseEvent) => {
    if (ed || dSub !== null) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.clientX - r.left < EDGE || e.clientX - r.left > r.width - EDGE) return; setDi(i); setDx(e.clientX); setDs(segs[i]?.sx || 0);
  }, [ed, dSub, segs]);
  const eD = useCallback((i: number, s: 'L' | 'R', e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault(); const seg = tl[i];
    setEd({ i, s, x: e.clientX, ost: seg.start_time, od: seg.duration, sd: seg.source_duration || 60 });
  }, [tl]);

  const mM = useCallback((e: React.MouseEvent) => {
    if (ed) {
      const dx2 = (e.clientX - ed.x) / PX_SEC; const n = [...tl]; const s = { ...n[ed.i] };
      if (ed.s === 'L') { const ns = Math.max(0, ed.ost + dx2); s.start_time = +Math.min(ns, ed.ost + ed.od - 0.5).toFixed(1); s.duration = +(ed.ost + ed.od - s.start_time).toFixed(1); }
      else { s.duration = +Math.max(0.5, Math.min(ed.od + dx2, (s.source_duration || ed.sd) - s.start_time)).toFixed(1); }
      n[ed.i] = s; setTl(n); return;
    }
    if (di === null && dSub === null) return;
    if (dSub !== null && cv.current) {
      const r = cv.current.getBoundingClientRect();
      setSov({ ...sov, [dSub]: { ...sov[dSub], x: +((e.clientX - r.left) / r.width * 100).toFixed(1), y: +((e.clientY - r.top) / r.height * 100).toFixed(1) } });
      return;
    }
    if (di === null) return;
    const dx2 = e.clientX - dx; const ns = (ds + dx2) / PX_SEC; const no = [...tl]; const d = no.splice(di, 1)[0];
    let at = 0, acc = 0; for (let i = 0; i < no.length; i++) { acc += no[i].duration || 1; if (acc > ns) { at = i + 1; break; } if (i === no.length - 1) at = no.length; }
    no.splice(Math.min(at, no.length), 0, d); setTl(no); setDi(at); setDx(e.clientX); let nx = 0; for (let i = 0; i < at; i++) nx += no[i].duration * PX_SEC; setDs(nx);
  }, [ed, di, dSub, dx, ds, tl, setTl, sov, setSov]);

  const mU = useCallback(() => { setDi(null); setEd(null); setDSub(null); }, []);
  const sync = useCallback(() => { if (!adur) return; const t = tl.reduce((a, s) => a + s.duration, 0); if (t <= 0) return; setTl(tl.map(s => ({ ...s, duration: +Math.max(0.5, (s.duration * adur / t)).toFixed(1) }))); }, [adur, tl, setTl]);

  /* ── Track click to seek ── */
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    if (di !== null || ed || dSub !== null) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const sx = el.scrollLeft + e.clientX - rect.left;
    const t = sx / PX_SEC;
    setScrub(Math.max(0, Math.min(t, td)));
  }, [di, ed, dSub, td]);

  /* ── Preview play ── */
  const handlePreviewPlay = useCallback(async () => {
    if (!tl.length) return;
    setPvLoading(true); setPvUrl('');
    try {
      const resp = await fetch(`${API}/api/ai-editing/preview-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segments: tl.map(s => ({ video_path: s.video_path, start_time: s.start_time, duration: s.duration })),
          width: 480, height: 640,
        }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.data?.url) {
          setPvUrl(data.data.url);
          setTimeout(() => { setPlaying(true); pvRef.current?.play(); }, 200);
        }
      }
    } catch { }
    setPvLoading(false);
  }, [tl]);

  const handleStopPreview = useCallback(() => { setPlaying(false); setPvUrl(''); }, []);

  /* ── Canvas drag ── */
  const cM = useCallback((e: React.MouseEvent) => {
    if (!cv.current) return;
    const r = cv.current.getBoundingClientRect(); const cx = (e.clientX - r.left) / r.width * 100; const cy = (e.clientY - r.top) / r.height * 100;
    const hit = subs.find(s => scrub >= s.start && scrub < s.end && Math.abs(cx - s.x) < 10 && Math.abs(cy - s.y) < 8);
    if (hit) { setDSub(hit.i); e.preventDefault(); }
  }, [subs, scrub]);

  /* ── Canvas click to seek ── */
  const handleCanvasClick = useCallback((e: React.MouseEvent) => {
    if (dSub !== null || !cv.current) return;
    const r = cv.current.getBoundingClientRect();
    // Only seek if clicking on canvas bg, not on subtitle
    const cx = (e.clientX - r.left) / r.width * 100; const cy = (e.clientY - r.top) / r.height * 100;
    const hit = subs.find(s => scrub >= s.start && scrub < s.end && Math.abs(cx - s.x) < 12 && Math.abs(cy - s.y) < 10);
    if (!hit) {
      const seekPct = (e.clientX - r.left) / r.width;
      setScrub(Math.max(0, Math.min(seekPct * td, td)));
    }
  }, [dSub, subs, scrub, td]);

  /* ── Sub edit ── */
  const openEdit = useCallback((i: number, e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault();
    const sub = subs[i]; setESub(i); setEText(sov[i]?.text ?? tl[i]?.segment_text ?? ''); setAe(e.currentTarget as HTMLElement);
  }, [subs, sov, tl]);
  const saveEdit = useCallback(() => {
    if (eSub !== null) setSov({ ...sov, [eSub]: { ...sov[eSub], text: stripPunct(eText) } });
    setESub(null); setAe(null);
  }, [eSub, eText, sov, setSov]);
  const delSub = useCallback((i: number) => { const n = { ...sov }; delete n[i]; setSov(n); }, [sov, setSov]);

  const mm = adur && Math.abs(td - adur) > 0.5;
  const curSub = subs.find(s => scrub >= s.start && scrub < s.end);
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
        {tl.length > 0 && (
          <Button size="small" variant="contained" startIcon={pvLoading ? undefined : <PreviewIcon />}
            onClick={pvUrl ? handleStopPreview : handlePreviewPlay}
            color={pvUrl ? 'error' : 'success'} disabled={pvLoading}>
            {pvLoading ? '生成中...' : pvUrl ? <><StopIcon fontSize="small" /> 停止</> : '预览播放'}
          </Button>
        )}
        <Chip label="点击轨道跳帧 | 拖字幕调位置 | 双击编辑" size="small" variant="outlined" color="info" />
      </Box>

      {/* ── 3:4 Canvas ── */}
      <Paper elevation={3} ref={cv}
        sx={{ bgcolor: '#000', borderRadius: 1, overflow: 'hidden', position: 'relative', cursor: tl.length ? 'crosshair' : 'default', maxWidth: 360, mx: 'auto', width: '100%' }}
        onMouseDown={cM} onMouseMove={pvUrl ? undefined : mM} onMouseUp={() => mU()} onMouseLeave={() => mU()}
        onClick={handleCanvasClick}>
        <Box sx={{ position: 'relative', width: '100%', paddingBottom: '133.33%', bgcolor: '#0a0a0a' }}>
          {/* Preview video playback */}
          {pvUrl && (
            <video ref={pvRef} src={pvUrl} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }}
              onTimeUpdate={() => { if (pvRef.current) setScrub(pvRef.current.currentTime); }}
              onEnded={() => { setPlaying(false); setPvUrl(''); setScrub(td); }}
              controls={false} autoPlay />
          )}
          {!pvUrl && frame && <img src={frame} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
            onError={e => { (e.target as HTMLImageElement).style.opacity = '0.15'; }} />}
          {/* Subtitles always on top */}
          {subs.map((sub, i) => {
            const vis = scrub >= sub.start && scrub < sub.end;
            if (!vis) return null;
            return (
              <Box key={i} onDoubleClick={e => openEdit(i, e)}
                sx={{ position: 'absolute', left: `${sub.x}%`, top: `${sub.y}%`, transform: 'translate(-50%,-50%)', textAlign: 'center', maxWidth: '90%', cursor: 'grab', zIndex: 5, userSelect: 'none',
                  fontFamily: sf, fontSize: `${ss}px`, color: sc, fontWeight: 700, lineHeight: 1.2,
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  letterSpacing: `${sLs}px`,
                  textShadow: sw > 0 ? ts : '0 0 4px rgba(0,0,0,0.8)',
                }}>{sub.text}</Box>);
          })}
          <Box sx={{ position: 'absolute', bottom: 4, left: 8, zIndex: 10, color: '#fff', fontSize: '0.65rem', fontFamily: 'monospace', textShadow: '0 0 3px #000', pointerEvents: 'none' }}>
            {scrub.toFixed(1)}s / {td.toFixed(1)}s
          </Box>
          {!tl.length && <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography color="grey.600">生成时间线后预览</Typography></Box>}
        </Box>
      </Paper>
      {curSub && !pvUrl && <Typography variant="caption" color="text.secondary" textAlign="center" sx={{ mt: -1 }}>字幕 #{curSub.i + 1}: {curSub.text?.substring(0, 40)}</Typography>}

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

      {/* ── Style panel ── */}
      <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'grey.50' }}>
        <Typography variant="subtitle2" gutterBottom><SubtitlesIcon sx={{ mr: 0.5, verticalAlign: 'middle' }} fontSize="small" />字幕样式</Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          <Box sx={{ minWidth: 130 }}>
            <select value={sf} onChange={e => handleFontChange(e.target.value)} style={{ width: '100%', padding: '4px 6px', borderRadius: 4, border: '1px solid #ccc', fontSize: '0.8rem' }}>
              {fonts.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
          </Box>
          <Box><input type="color" value={sc} onChange={e => setSc(e.target.value)} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', borderRadius: 4 }} /></Box>
          <Box sx={{ minWidth: 100 }}><Typography variant="caption">大小{ss}px</Typography><Slider size="small" value={ss} min={12} max={60} step={1} onChange={(_, v) => setSs(v as number)} /></Box>
          <Box><input type="color" value={sk} onChange={e => setSk(e.target.value)} style={{ width: 32, height: 28, border: 'none', cursor: 'pointer', borderRadius: 4 }} /></Box>
          <Box sx={{ minWidth: 80 }}><Typography variant="caption">描边{sw}px</Typography><Slider size="small" value={sw} min={0} max={6} step={0.5} onChange={(_, v) => setSw(v as number)} /></Box>
          <Box sx={{ minWidth: 80 }}><Typography variant="caption">间距{sLs}px</Typography><Slider size="small" value={sLs} min={-2} max={10} step={0.5} onChange={(_, v) => setSLs(v as number)} /></Box>
        </Box>
        <Box sx={{ mt: 1, p: 1.5, bgcolor: '#1a1a2e', borderRadius: 1, textAlign: 'center' }}>
          <Typography sx={{ fontFamily: sf, fontSize: ss, color: sc, fontWeight: 700, letterSpacing: `${sLs}px`,
            textShadow: sw > 0 ? ts : 'none',
          }}>预览效果 Preview</Typography>
        </Box>
      </Paper>

      {/* ── Timeline ── */}
      <Paper elevation={1} sx={{ p: 1, overflowX: 'auto', userSelect: 'none', position: 'relative', cursor: 'pointer' }}
        onMouseMove={mM} onMouseUp={mU} onMouseLeave={() => { mU(); setHe(null); }}>
        <Box sx={{ position: 'absolute', top: 0, left: scrub * PX_SEC + 8, width: 2, height: '100%', bgcolor: '#f44336', zIndex: 20, pointerEvents: 'none' }} />
        <Box sx={{ display: 'flex', mb: 0.5, ml: 1, height: 16 }} onClick={handleTrackClick}>
          {Array.from({ length: Math.ceil(td) + 1 }, (_, i) => <Typography key={i} variant="caption" sx={{ width: PX_SEC, fontSize: '0.6rem', color: 'text.secondary' }}>{i}s</Typography>)}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1, fontSize: '0.65rem' }}>视频轨道 (点击跳帧)</Typography>
        <Box sx={{ display: 'flex', height: TRACK_H, minWidth: Math.max(tw, 200), bgcolor: '#1a1a2e', borderRadius: 1 }} onClick={handleTrackClick}>
          {tl.length > 0 ? segs.map(seg => (
            <Box key={seg.index} onMouseDown={e => cD(seg.index, e)}
              sx={{ width: seg.w, height: '100%', position: 'relative', mx: '1px', bgcolor: di === seg.index ? '#1565c0' : '#1976d2', border: di === seg.index ? '2px solid #fff' : '1px solid rgba(255,255,255,0.1)', borderRadius: '2px', overflow: 'hidden' }}>
              <img src={thumb(seg.video_path, (seg.start_time || 0) + 1)} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.35 }}
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              <Box sx={{ position: 'relative', zIndex: 1, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <Typography variant="caption" sx={{ color: '#fff', fontWeight: 700, fontSize: '0.7rem' }}>#{seg.index + 1}</Typography>
                <Typography variant="caption" sx={{ color: '#fff', fontSize: '0.6rem', opacity: 0.9 }}>{seg.duration.toFixed(1)}s</Typography>
              </Box>
              <Box onMouseDown={e => eD(seg.index, 'L', e)} onMouseEnter={() => setHe({ i: seg.index, s: 'L' })} onMouseLeave={() => setHe(null)}
                sx={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: EDGE, cursor: 'w-resize', zIndex: 10, bgcolor: (he?.i === seg.index && he.s === 'L') || (ed?.i === seg.index && ed.s === 'L') ? 'rgba(255,152,0,0.6)' : 'transparent' }} />
              <Box onMouseDown={e => eD(seg.index, 'R', e)} onMouseEnter={() => setHe({ i: seg.index, s: 'R' })} onMouseLeave={() => setHe(null)}
                sx={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: EDGE, cursor: 'e-resize', zIndex: 10, bgcolor: (he?.i === seg.index && he.s === 'R') || (ed?.i === seg.index && ed.s === 'R') ? 'rgba(255,152,0,0.6)' : 'transparent' }} />
            </Box>
          )) : <Box sx={{ flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography variant="caption" color="grey.500">暂无</Typography></Box>}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1, mt: 0.5, fontSize: '0.65rem', display: 'block' }}>音频轨道</Typography>
        <Box sx={{ display: 'flex', height: AUDIO_H, minWidth: Math.max(tw, 200), bgcolor: '#1b5e20', borderRadius: 1 }} onClick={handleTrackClick}>
          {tl.length > 0 ? segs.map(seg => (
            <Box key={seg.index} sx={{ width: seg.w, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: '1px solid rgba(255,255,255,0.15)', mx: '1px', overflow: 'hidden', px: 0.5 }}>
              <Typography variant="caption" sx={{ fontSize: '0.6rem', color: '#a5d6a7', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{stripPunct(seg.segment_text)?.substring(0, 22)}</Typography>
            </Box>
          )) : <Box sx={{ flex: 1, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Typography variant="caption" sx={{ color: '#81c784' }}>-</Typography></Box>}
        </Box>
      </Paper>

      {/* ── Detail ── */}
      {tl.length > 0 && <Box>
        <Typography variant="subtitle2" gutterBottom>片段详情</Typography>
        {segs.map(seg => (
          <Paper key={seg.index} elevation={0} sx={{ p: 1, mb: 1, bgcolor: 'grey.50', display: 'flex', gap: 1.5, alignItems: 'center' }}>
            <img src={thumb(seg.video_path, (seg.start_time || 0) + 0.5)} alt=""
              style={{ width: 80, height: 45, objectFit: 'cover', borderRadius: 4, background: '#e0e0e0', flexShrink: 0 }}
              onError={e => { const t = e.target as HTMLImageElement; t.style.background = '#ccc'; }}
              onClick={() => { setPi(seg.index); setPo(true); }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} noWrap>#{seg.index + 1} {stripPunct(seg.segment_text)}</Typography>
              <Typography variant="caption" color="text.secondary">{seg.video_path?.split(/[\\/]/).pop()}</Typography>
              <Typography variant="caption">入:{seg.start_time?.toFixed(1)}s 长:{seg.duration?.toFixed(1)}s</Typography>
            </Box>
            <Tooltip title="替换"><IconButton size="small" onClick={() => { setPi(seg.index); setPo(true); }}><SwapHorizIcon /></IconButton></Tooltip>
          </Paper>
        ))}
      </Box>}

      <Pick o={po} c={() => setPo(false)} p={tl[pi]?.video_path || ''} s={p => { setTl(tl.map((s, i) => i === pi ? { ...s, video_path: p, start_time: 0 } : s)); }} />
    </Box>
  );
};
export default TimelineEditor;
