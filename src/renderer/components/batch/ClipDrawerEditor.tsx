/**
 * 批量阶段三 · 侧拉审改抽屉（ClipDrawerEditor，D5/D6）。
 *
 * - 大预览：单 video 元素顺序播放各段（timeupdate 越过出点 → 切下一段），
 *   口播音频并行对齐（简化方案，段长=TTS 槽长漂移小；BGM 不混音只显示曲名）
 * - 素材段：逐段缩略帧 + 入点单柄滑杆（钳在可用窗口内）+ 批次内替换素材
 * - 字幕：逐段文本校对（subtitle_overrides，只改字幕不改口播）
 * - 封面：选段 + 取帧点滑杆 + 标题/副标题（专用端点，user_modified 自动置位）
 * - BGM：换曲（专用端点）+ 批次内撞曲前端自查提示
 *
 * 本地编辑态按 clipId 初始化；保存走 updateClip → refreshBatch，
 * 本地态不随刷新重置（未保存的编辑不丢）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Slider,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MovieIcon from '@mui/icons-material/Movie';
import MusicNoteIcon from '@mui/icons-material/MusicNote';
import SubtitlesIcon from '@mui/icons-material/Subtitles';
import PhotoIcon from '@mui/icons-material/Photo';
import SaveIcon from '@mui/icons-material/Save';

import api from '@/renderer/api/backend-client';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { useBatchStore } from '@/renderer/store/batch-store';
import type {
  BatchClip,
  BatchMaterial,
  ClipCover,
  ClipSegment,
} from '@/renderer/types/batch';
import { fp } from '../timeline/mediaUrl';
import { isClipLocked } from './ClipCard';
import { CLIP_STATUS_META, materialThumbUrl, materialVideoUrl } from './utils';

interface Props {
  clipId: string | null;
  open: boolean;
  onClose: () => void;
}

interface MusicTrack {
  name: string;
  path?: string;
  duration_sec?: number;
}

type SubtitleOverrides = Record<string, { text?: string; x?: number; y?: number }>;

const fmt = (v: number): string => v.toFixed(1);

const ClipDrawerEditor: React.FC<Props> = ({ clipId, open, onClose }) => {
  const batch = useBatchStore((s) => s.batch);
  const updateClip = useBatchStore((s) => s.updateClip);
  const busy = useBatchStore((s) => s.busy);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);
  const bu = useBackendUrl();
  const batchId = batch?.id ?? '';

  const clip: BatchClip | null = batch?.clips.find((c) => c.id === clipId) ?? null;
  const script = batch?.scripts.find((s) => s.id === clip?.script_id) ?? null;
  const locked = clip ? isClipLocked(clip.status) : false;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playIdx, setPlayIdx] = useState(0);
  const [segs, setSegs] = useState<ClipSegment[]>([]);
  const [subTexts, setSubTexts] = useState<Record<number, string>>({});
  const [cover, setCover] = useState<ClipCover | null>(null);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');

  /* clip 切换时重置本地编辑态（刷新批次不重置，保住未保存编辑） */
  useEffect(() => {
    if (!clip) return;
    setSegs((clip.segments ?? []).map((s) => ({ ...s })));
    setCover(clip.cover ? { ...clip.cover } : null);
    setPlayIdx(0);
    const overrides = (clip.subtitle_overrides ?? {}) as SubtitleOverrides;
    const subs: Record<number, string> = {};
    (script?.tts?.segments ?? []).forEach((t, i) => {
      subs[i] = overrides[String(i)]?.text ?? t.text ?? '';
    });
    setSubTexts(subs);
    setDirty(false);
    setMsg('');
    // 仅在切换成片时初始化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId]);

  /* BGM 曲目表 */
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const r = await api.get<MusicTrack[]>('/api/music/list');
      if (r.code === 0 && Array.isArray(r.data)) setTracks(r.data);
    })();
  }, [open]);

  /* 当前播放段越界时回正 */
  useEffect(() => {
    if (playIdx >= segs.length) setPlayIdx(0);
  }, [segs.length, playIdx]);

  const ttsAudioUrl = useMemo(() => {
    const p = script?.tts?.audio_path;
    return p ? `${bu}/api/ai-editing/audio?path=${fp(p)}` : '';
  }, [script?.tts?.audio_path, bu]);

  const materialsByHash = useMemo(() => {
    const m = new Map<string, BatchMaterial>();
    (batch?.materials ?? []).forEach((mat) => {
      if (mat.file_hash) m.set(mat.file_hash, mat);
    });
    return m;
  }, [batch?.materials]);

  /** 替换素材池：已分析且未缺失 */
  const pool = useMemo(
    () =>
      (batch?.materials ?? []).filter(
        (m) => m.file_hash && m.analysis_status === 'done' && !m.missing,
      ),
    [batch?.materials],
  );

  const filenameOf = (hash?: string | null): string =>
    (hash && materialsByHash.get(hash)?.filename) || '未知素材';

  /** 批次内撞曲自查（后端也有撞曲检查，这里只做提示） */
  const bgmCollision = useMemo(() => {
    if (!clip?.bgm_name || !batch) return false;
    return batch.clips.some((c) => c.id !== clip.id && c.bgm_name === clip.bgm_name);
  }, [batch, clip]);

  if (!clip) return null;
  const curSeg = segs[playIdx] ?? segs[0];
  const ttsSegments = script?.tts?.segments ?? [];
  const meta = CLIP_STATUS_META[clip.status] ?? CLIP_STATUS_META.待生成;
  const metaColor = meta.color === 'default' ? 'text.secondary' : `${meta.color}.main`;

  /** 视频 timeupdate：越过当前段出点则跳下一段（播完暂停） */
  const onTimeUpdate = (): void => {
    const v = videoRef.current;
    if (!v || !curSeg) return;
    if (v.currentTime >= curSeg.out - 0.05) {
      const next = playIdx + 1;
      if (next < segs.length) {
        setPlayIdx(next);
      } else {
        v.pause();
        audioRef.current?.pause();
      }
    }
  };

  /** playIdx / 素材变化时切换视频源并对齐口播音频进度 */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !curSeg || !curSeg.file_hash) return;
    const src = materialVideoUrl(bu, batchId, curSeg.file_hash);
    if (!v.src.startsWith(src)) {
      v.src = src;
      v.onloadedmetadata = () => {
        v.currentTime = curSeg.in;
        void v.play().catch(() => undefined);
      };
      v.load();
    } else {
      v.currentTime = curSeg.in;
      void v.play().catch(() => undefined);
    }
    const a = audioRef.current;
    if (a) {
      let offset = 0;
      for (let i = 0; i < playIdx; i += 1) offset += segs[i]?.duration ?? 0;
      a.currentTime = offset;
      void a.play().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playIdx, curSeg?.file_hash]);

  const adjustSegIn = (i: number, v: number): void => {
    setSegs((prev) => {
      const next = prev.map((s) => ({ ...s }));
      const s = next[i];
      const dur = s.duration || s.out - s.in;
      s.in = Math.max(0, v);
      s.out = s.in + dur;
      s.duration = dur;
      return next;
    });
    setDirty(true);
  };

  const replaceSegMaterial = (i: number, hash: string): void => {
    setSegs((prev) => {
      const next = prev.map((s) => ({ ...s }));
      const s = next[i];
      const mat = materialsByHash.get(hash);
      if (!mat) return prev;
      const dur = s.duration || s.out - s.in;
      const usableIn = mat.usable_in ?? 0;
      const usableOut = mat.usable_out || mat.duration || dur;
      const maxIn = Math.max(usableIn, usableOut - dur);
      s.file_hash = hash;
      s.video_rel_path = mat.rel_path;
      s.in = Math.min(Math.max(s.in, usableIn), maxIn);
      s.out = s.in + dur;
      s.duration = dur;
      return next;
    });
    setDirty(true);
  };

  const saveSegments = async (): Promise<void> => {
    const ok = await updateClip(clip.id, { segments: segs });
    if (ok) {
      setDirty(false);
      setMsg('素材段已保存');
    }
  };

  const saveSubtitles = async (): Promise<void> => {
    const overrides: SubtitleOverrides = {
      ...((clip.subtitle_overrides ?? {}) as SubtitleOverrides),
    };
    Object.entries(subTexts).forEach(([k, text]) => {
      overrides[k] = { ...(overrides[k] ?? {}), text };
    });
    const ok = await updateClip(clip.id, { subtitle_overrides: overrides });
    if (ok) {
      setDirty(false);
      setMsg('字幕校对已保存（只改字幕，不改口播）');
    }
  };

  const saveCover = async (): Promise<void> => {
    if (!cover) return;
    const ok = await updateClip(clip.id, { cover: cover as Record<string, unknown> });
    if (ok) {
      setDirty(false);
      setMsg('封面已保存');
    }
  };

  const saveBgm = async (name: string): Promise<void> => {
    const ok = await updateClip(clip.id, { bgm_name: name });
    if (ok) setMsg('BGM 已保存');
  };

  const setCoverField = (patch: Partial<ClipCover>): void => {
    setCover((prev) => {
      const base: ClipCover =
        prev ?? {
          time: segs[0]?.in ?? 0,
          file_hash: segs[0]?.file_hash ?? '',
          video_rel_path: segs[0]?.video_rel_path ?? '',
        };
      return { ...base, ...patch };
    });
    setDirty(true);
  };

  /** 封面取帧段：封面 file_hash 落在 segs 中的下标（默认 0） */
  const coverSegIdx = Math.max(
    0,
    segs.findIndex((s) => s.file_hash === cover?.file_hash),
  );
  const coverSeg = segs[coverSegIdx] ?? segs[0];
  const coverThumb = cover?.file_hash
    ? materialThumbUrl(bu, batchId, cover.file_hash, cover.time ?? coverSeg?.in ?? 0, 480)
    : '';

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: 560,
          bgcolor: 'background.default',
          borderLeft: '1px solid',
          borderColor: 'divider',
        },
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        spacing={1}
        sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }} noWrap>
          {clip.cover?.title || clip.id} · 审改
        </Typography>
        <Typography variant="caption" sx={{ color: metaColor, flexShrink: 0 }}>
          {clip.status}
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
        <Stack spacing={2}>
          {locked && (
            <Alert severity="info" variant="outlined">
              该成片已确认锁定。在卡片上点击解锁后回到待确认状态才能编辑。
            </Alert>
          )}
          {storeError && (
            <Alert severity="error" onClose={() => setError(null)}>
              {storeError}
            </Alert>
          )}
          {msg && (
            <Alert severity="success" onClose={() => setMsg('')}>
              {msg}
            </Alert>
          )}

          {/* ── 大预览 ── */}
          <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paperAlt' }}>
            <Box
              sx={{
                width: '100%',
                aspectRatio: '16/9',
                bgcolor: '#000',
                borderRadius: 1,
                overflow: 'hidden',
              }}
            >
              <video
                ref={videoRef}
                muted
                playsInline
                onTimeUpdate={onTimeUpdate}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            </Box>
            {ttsAudioUrl && (
              <audio ref={audioRef} src={ttsAudioUrl} style={{ display: 'none' }} />
            )}
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.5, display: 'block' }}
            >
              顺序播放各段（视频静音）{ttsAudioUrl ? ' + 口播音频' : ''}
              {clip.bgm_name ? ` · BGM 预览不含混音（当前：${clip.bgm_name}）` : ''}
            </Typography>
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap' }}>
              {segs.map((_, i) => (
                <Button
                  key={i}
                  size="small"
                  variant={playIdx === i ? 'contained' : 'outlined'}
                  onClick={() => setPlayIdx(i)}
                  sx={{ minWidth: 0, px: 1, py: 0, fontSize: 11 }}
                >
                  段{i + 1}
                </Button>
              ))}
            </Stack>
          </Paper>

          {/* ── 素材段编辑 ── */}
          <Accordion defaultExpanded>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <MovieIcon fontSize="small" color="primary" />
                <Typography variant="subtitle2">素材段（{segs.length}）</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                {segs.map((s, i) => {
                  const mat = s.file_hash ? materialsByHash.get(s.file_hash) : undefined;
                  const usableIn = mat?.usable_in ?? 0;
                  const usableOut = mat?.usable_out || mat?.duration || s.out;
                  const maxIn = Math.max(usableIn, usableOut - (s.duration || s.out - s.in));
                  return (
                    <Paper key={i} variant="outlined" sx={{ p: 1.25 }}>
                      <Stack direction="row" spacing={1.25} alignItems="center">
                        <Box
                          component="img"
                          src={
                            s.file_hash
                              ? materialThumbUrl(bu, batchId, s.file_hash, s.in, 160)
                              : undefined
                          }
                          alt=""
                          sx={{
                            width: 84,
                            height: 48,
                            objectFit: 'cover',
                            borderRadius: 0.5,
                            bgcolor: '#000',
                            flexShrink: 0,
                          }}
                        />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="caption" fontWeight={600}>
                              段{i + 1}
                            </Typography>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              noWrap
                              sx={{ flex: 1 }}
                              title={filenameOf(s.file_hash)}
                            >
                              {filenameOf(s.file_hash)}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {fmt(s.in)}s → {fmt(s.out)}s
                            </Typography>
                          </Stack>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
                            <Typography variant="caption" color="text.secondary" sx={{ width: 32 }}>
                              入点
                            </Typography>
                            <Slider
                              size="small"
                              min={usableIn}
                              max={Math.max(maxIn, usableIn + 0.1)}
                              step={0.1}
                              value={Math.min(s.in, maxIn)}
                              disabled={locked}
                              onChange={(_, v) => adjustSegIn(i, v as number)}
                              sx={{ flex: 1 }}
                            />
                            <FormControl size="small" sx={{ minWidth: 140 }}>
                              <Select
                                value={s.file_hash ?? ''}
                                disabled={locked}
                                onChange={(e) => replaceSegMaterial(i, e.target.value as string)}
                                displayEmpty
                                sx={{ fontSize: 12 }}
                              >
                                {pool.map((m) => (
                                  <MenuItem key={m.file_hash} value={m.file_hash} sx={{ fontSize: 12 }}>
                                    {m.filename}
                                  </MenuItem>
                                ))}
                              </Select>
                            </FormControl>
                          </Stack>
                        </Box>
                        <Tooltip title="播放到此段">
                          <Button
                            size="small"
                            variant={playIdx === i ? 'contained' : 'text'}
                            onClick={() => setPlayIdx(i)}
                            sx={{ minWidth: 0, px: 1, alignSelf: 'flex-start' }}
                          >
                            ▶
                          </Button>
                        </Tooltip>
                      </Stack>
                    </Paper>
                  );
                })}
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<SaveIcon />}
                  disabled={locked || busy || !dirty}
                  onClick={() => void saveSegments()}
                  sx={{ alignSelf: 'flex-end' }}
                >
                  保存素材段
                </Button>
              </Stack>
            </AccordionDetails>
          </Accordion>

          {/* ── 字幕校对 ── */}
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <SubtitlesIcon fontSize="small" color="primary" />
                <Typography variant="subtitle2">
                  字幕校对（{Object.keys(subTexts).length}）
                </Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.25}>
                <Typography variant="caption" color="text.secondary">
                  只改字幕文字，不改口播语音。留空则该段不显示字幕。
                </Typography>
                {Object.entries(subTexts).map(([k, text]) => (
                  <TextField
                    key={k}
                    size="small"
                    fullWidth
                    multiline
                    minRows={1}
                    maxRows={3}
                    label={`段${Number(k) + 1}`}
                    value={text}
                    disabled={locked}
                    onChange={(e) => {
                      setSubTexts((prev) => ({ ...prev, [k]: e.target.value }));
                      setDirty(true);
                    }}
                  />
                ))}
                {Object.keys(subTexts).length === 0 && (
                  <Typography variant="caption" color="text.secondary">
                    该脚本尚无口播分段文本（TTS 未生成）。
                  </Typography>
                )}
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<SaveIcon />}
                  disabled={locked || busy || !dirty || Object.keys(subTexts).length === 0}
                  onClick={() => void saveSubtitles()}
                  sx={{ alignSelf: 'flex-end' }}
                >
                  保存字幕
                </Button>
              </Stack>
            </AccordionDetails>
          </Accordion>

          {/* ── 封面编辑 ── */}
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <PhotoIcon fontSize="small" color="primary" />
                <Typography variant="subtitle2">封面与标题</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                {coverThumb && (
                  <Box
                    component="img"
                    src={coverThumb}
                    alt="封面"
                    sx={{
                      width: '100%',
                      maxHeight: 180,
                      objectFit: 'cover',
                      borderRadius: 1,
                      bgcolor: '#000',
                    }}
                  />
                )}
                <Stack direction="row" spacing={1} alignItems="center">
                  <FormControl size="small" sx={{ minWidth: 100 }}>
                    <InputLabel>取帧段</InputLabel>
                    <Select
                      label="取帧段"
                      value={coverSegIdx}
                      disabled={locked || segs.length === 0}
                      onChange={(e) => {
                        const idx = Number(e.target.value);
                        const seg = segs[idx];
                        if (!seg) return;
                        setCoverField({
                          file_hash: seg.file_hash,
                          video_rel_path: seg.video_rel_path,
                          time: seg.in,
                        });
                      }}
                    >
                      {segs.map((_, i) => (
                        <MenuItem key={i} value={i}>
                          段{i + 1}
                        </MenuItem>
                      ))}
                    </Select>
                  </FormControl>
                  <Typography variant="caption" color="text.secondary" sx={{ width: 52 }}>
                    取帧点
                  </Typography>
                  <Slider
                    size="small"
                    min={coverSeg?.in ?? 0}
                    max={Math.max(coverSeg?.out ?? 1, (coverSeg?.in ?? 0) + 0.1)}
                    step={0.1}
                    value={Math.min(
                      Math.max(cover?.time ?? coverSeg?.in ?? 0, coverSeg?.in ?? 0),
                      coverSeg?.out ?? 1,
                    )}
                    disabled={locked}
                    onChange={(_, v) => setCoverField({ time: v as number })}
                    sx={{ flex: 1 }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ width: 42 }}>
                    {fmt(cover?.time ?? coverSeg?.in ?? 0)}s
                  </Typography>
                </Stack>
                <TextField
                  size="small"
                  fullWidth
                  label="封面标题"
                  value={cover?.title ?? ''}
                  disabled={locked}
                  onChange={(e) => setCoverField({ title: e.target.value })}
                />
                <TextField
                  size="small"
                  fullWidth
                  label="封面副标题"
                  value={cover?.subtitle ?? ''}
                  disabled={locked}
                  onChange={(e) => setCoverField({ subtitle: e.target.value })}
                />
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<SaveIcon />}
                  disabled={locked || busy || !cover}
                  onClick={() => void saveCover()}
                  sx={{ alignSelf: 'flex-end' }}
                >
                  保存封面
                </Button>
              </Stack>
            </AccordionDetails>
          </Accordion>

          {/* ── BGM ── */}
          <Accordion>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Stack direction="row" spacing={1} alignItems="center">
                <MusicNoteIcon fontSize="small" color="primary" />
                <Typography variant="subtitle2">背景音乐</Typography>
              </Stack>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.25}>
                <FormControl size="small" fullWidth>
                  <InputLabel>BGM</InputLabel>
                  <Select
                    label="BGM"
                    value={clip.bgm_name ?? ''}
                    disabled={locked || busy}
                    onChange={(e) => void saveBgm(e.target.value as string)}
                  >
                    <MenuItem value="">
                      <em>无</em>
                    </MenuItem>
                    {tracks.map((m) => (
                      <MenuItem key={m.name} value={m.name}>
                        {m.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
                {bgmCollision && (
                  <Alert severity="warning" variant="outlined">
                    ⚠ 与本批次其他成片撞曲，建议换一首
                  </Alert>
                )}
              </Stack>
            </AccordionDetails>
          </Accordion>

          {/* ── 口播原文对照 ── */}
          {ttsSegments.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.paperAlt' }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mb: 0.5 }}
              >
                口播原文（TTS 已合成，仅供对照）
              </Typography>
              {ttsSegments.map((t, i) => (
                <Typography key={i} variant="body2" sx={{ fontSize: 12, lineHeight: 1.7 }}>
                  {i + 1}. {t.text ?? ''}
                </Typography>
              ))}
            </Paper>
          )}
        </Stack>
      </Box>
    </Drawer>
  );
};

export default ClipDrawerEditor;
