/**
 * ProjectHistory — step 1 panel for saving/restoring project snapshots.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Typography, Paper, Button, IconButton, TextField, Dialog, DialogTitle,
  DialogContent, DialogActions, Chip, Divider, CircularProgress, Tooltip,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import RestoreIcon from '@mui/icons-material/Restore';
import DeleteIcon from '@mui/icons-material/Delete';
import HistoryIcon from '@mui/icons-material/History';
import { useEditingStore } from '@/renderer/store/editing-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { AnyMaterial } from '@/renderer/types/material';
import { getBackendBaseUrl } from '@/renderer/api/backend-client';

interface ProjectEntry {
  id: string; name: string; created_at: string; script_preview: string; segment_count: number;
}

const ProjectHistory: React.FC = () => {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');

  const mats = useMaterialsStore(s => s.materials);
  const {
        analysisModel, analysisApiKey, ttsProvider, ttsApiKeys,
        timeline, script, voice, outputPath, audioPath, audioDuration, speechSpeed,
    subtitleFont, subtitleFontPath, subtitleColor, subtitleSize,
    subtitleStrokeColor, subtitleStrokeWidth, subtitleOverrides,
    coverTitle, coverSubtitle, coverTitleX, coverTitleY, coverSubX, coverSubY,
    coverTitleSize, coverSubSize, coverTitleColor, coverSubColor,
    coverTitleStrokeColor, coverSubStrokeColor, coverTitleStrokeWidth, coverSubStrokeWidth,
    coverTitleItalic, coverSubItalic, coverAspect, coverZoom, coverOffsetX, coverOffsetY,
    coverFont, coverFontPath, coverVideoPath, coverTime, videoAspect, videoResolution,
    bgmName, bgmVolume, voiceVolume,
  } = useEditingStore();
  const reset = useEditingStore(s => s.reset);
  const setAnalysisModel = useEditingStore(s => s.setAnalysisModel);
  const setAnalysisApiKey = useEditingStore(s => s.setAnalysisApiKey);
  const setTtsProvider = useEditingStore(s => s.setTtsProvider);
  const setTtsApiKey = useEditingStore(s => s.setTtsApiKey);
  const setScript = useEditingStore(s => s.setScript);
  const setVoice = useEditingStore(s => s.setVoice);
  const setTimeline = useEditingStore(s => s.setTimeline);
  const setOutputPath = useEditingStore(s => s.setOutputPath);
  const setAudioPath = useEditingStore(s => s.setAudioPath);
  const setAudioDuration = useEditingStore(s => s.setAudioDuration);
  const setSpeechSpeed = useEditingStore(s => s.setSpeechSpeed);
  const setSubtitleFont = useEditingStore(s => s.setSubtitleFont);
  const setSubtitleFontPath = useEditingStore(s => s.setSubtitleFontPath);
  const setSubtitleColor = useEditingStore(s => s.setSubtitleColor);
  const setSubtitleSize = useEditingStore(s => s.setSubtitleSize);
  const setSubtitleStrokeColor = useEditingStore(s => s.setSubtitleStrokeColor);
  const setSubtitleStrokeWidth = useEditingStore(s => s.setSubtitleStrokeWidth);
  const setSubtitleOverrides = useEditingStore(s => s.setSubtitleOverrides);
  const setCoverTitle = useEditingStore(s => s.setCoverTitle);
  const setCoverSubtitle = useEditingStore(s => s.setCoverSubtitle);
  const setCoverTitleX = useEditingStore(s => s.setCoverTitleX);
  const setCoverTitleY = useEditingStore(s => s.setCoverTitleY);
  const setCoverSubX = useEditingStore(s => s.setCoverSubX);
  const setCoverSubY = useEditingStore(s => s.setCoverSubY);
  const setCoverTitleSize = useEditingStore(s => s.setCoverTitleSize);
  const setCoverSubSize = useEditingStore(s => s.setCoverSubSize);
  const setCoverTitleColor = useEditingStore(s => s.setCoverTitleColor);
  const setCoverSubColor = useEditingStore(s => s.setCoverSubColor);
  const setCoverTitleStrokeColor = useEditingStore(s => s.setCoverTitleStrokeColor);
  const setCoverSubStrokeColor = useEditingStore(s => s.setCoverSubStrokeColor);
  const setCoverTitleStrokeWidth = useEditingStore(s => s.setCoverTitleStrokeWidth);
  const setCoverSubStrokeWidth = useEditingStore(s => s.setCoverSubStrokeWidth);
  const setCoverTitleItalic = useEditingStore(s => s.setCoverTitleItalic);
  const setCoverSubItalic = useEditingStore(s => s.setCoverSubItalic);
  const setCoverAspect = useEditingStore(s => s.setCoverAspect);
  const setVideoAspect = useEditingStore(s => s.setVideoAspect);
  const setVideoResolution = useEditingStore(s => s.setVideoResolution);
  const setCoverZoom = useEditingStore(s => s.setCoverZoom);
  const setCoverOffsetX = useEditingStore(s => s.setCoverOffsetX);
  const setCoverOffsetY = useEditingStore(s => s.setCoverOffsetY);
  const setCoverFont = useEditingStore(s => s.setCoverFont);
  const setCoverFontPath = useEditingStore(s => s.setCoverFontPath);
  const setCoverVideoPath = useEditingStore(s => s.setCoverVideoPath);
  const setCoverTime = useEditingStore(s => s.setCoverTime);
  const setBgmName = useEditingStore(s => s.setBgmName);
  const setBgmVolume = useEditingStore(s => s.setBgmVolume);
  const setVoiceVolume = useEditingStore(s => s.setVoiceVolume);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const baseUrl: string = await getBackendBaseUrl();
      const r = await fetch(`${baseUrl}/api/projects/list`);
      const d = await r.json();
      if (d?.data?.projects) setProjects(d.data.projects);
    } catch { }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProjects(); }, [fetchProjects]);

  const handleSave = useCallback(async () => {
    const name = saveName.trim() || `项目 ${new Date().toLocaleString('zh-CN')}`;
    const state = {
      analysisModel, analysisApiKey, ttsProvider, ttsApiKeys, script, voice, outputPath, audioPath, audioDuration, speechSpeed,
      timeline, materials: mats.map((m: AnyMaterial) => ({ path: (m.filePath || ''), type: m.type, status: m.status, fileName: m.fileName })),
      subtitleFont, subtitleFontPath, subtitleColor, subtitleSize,
      subtitleStrokeColor, subtitleStrokeWidth, subtitleOverrides,
      coverTitle, coverSubtitle, coverTitleX, coverTitleY, coverSubX, coverSubY,
      coverTitleSize, coverSubSize, coverTitleColor, coverSubColor,
      coverTitleStrokeColor, coverSubStrokeColor, coverTitleStrokeWidth, coverSubStrokeWidth,
      coverTitleItalic, coverSubItalic, coverAspect, coverZoom, coverOffsetX, coverOffsetY,
      coverFont, coverFontPath, coverVideoPath, coverTime, videoAspect, videoResolution,
      bgmName, bgmVolume, voiceVolume,
    };
    try {
      const baseUrl: string = await getBackendBaseUrl();
      await fetch(`${baseUrl}/api/projects/save`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, state }),
      });
      setSaveOpen(false); setSaveName('');
      fetchProjects();
    } catch { }
  }, [saveName, analysisModel, analysisApiKey, ttsProvider, ttsApiKeys, script, voice, timeline, mats, outputPath, audioPath, audioDuration, speechSpeed,
    subtitleFont, subtitleFontPath, subtitleColor, subtitleSize, subtitleStrokeColor, subtitleStrokeWidth, subtitleOverrides,
    coverTitle, coverSubtitle, coverTitleX, coverTitleY, coverSubX, coverSubY,
    coverTitleSize, coverSubSize, coverTitleColor, coverSubColor,
    coverTitleStrokeColor, coverSubStrokeColor, coverTitleStrokeWidth, coverSubStrokeWidth,
    coverTitleItalic, coverSubItalic, coverAspect, coverZoom, coverOffsetX, coverOffsetY,
    coverFont, coverFontPath, coverVideoPath, coverTime, videoAspect, videoResolution,
    bgmName, bgmVolume, voiceVolume,
    fetchProjects]);

  const handleRestore = useCallback(async (id: string) => {
    try {
      const baseUrl: string = await getBackendBaseUrl();
      const r = await fetch(`${baseUrl}/api/projects/${id}`);
      const d = await r.json();
      const s = d?.data?.state;
      if (!s) return;
      // Restore all state
      // 恢复 API 配置（新结构）；兼容旧项目存档中的单一 apiKey
      if (s.analysisApiKey !== undefined) setAnalysisApiKey(s.analysisApiKey);
      if (s.analysisModel !== undefined) setAnalysisModel(s.analysisModel);
      if (s.ttsProvider !== undefined) setTtsProvider(s.ttsProvider);
      if (s.ttsApiKeys?.qwen !== undefined) setTtsApiKey('qwen', s.ttsApiKeys.qwen);
      if (s.ttsApiKeys?.doubao !== undefined) setTtsApiKey('doubao', s.ttsApiKeys.doubao);
      if (s.apiKey) { setAnalysisApiKey(s.apiKey); setTtsApiKey('qwen', s.apiKey); }
      if (s.script) setScript(s.script);
      if (s.voice) setVoice(s.voice);
      if (s.outputPath) setOutputPath(s.outputPath);
      if (s.audioPath) setAudioPath(s.audioPath);
      if (s.audioDuration) setAudioDuration(s.audioDuration);
      if (s.speechSpeed) setSpeechSpeed(s.speechSpeed);
      if (s.timeline) setTimeline(s.timeline);
      if (s.subtitleFont) setSubtitleFont(s.subtitleFont);
      if (s.subtitleFontPath) setSubtitleFontPath(s.subtitleFontPath);
      if (s.subtitleColor) setSubtitleColor(s.subtitleColor);
      if (s.subtitleSize) setSubtitleSize(s.subtitleSize);
      if (s.subtitleStrokeColor) setSubtitleStrokeColor(s.subtitleStrokeColor);
      if (s.subtitleStrokeWidth) setSubtitleStrokeWidth(s.subtitleStrokeWidth);
      if (s.subtitleOverrides) setSubtitleOverrides(s.subtitleOverrides);
      if (s.coverTitle !== undefined) setCoverTitle(s.coverTitle);
      if (s.coverSubtitle !== undefined) setCoverSubtitle(s.coverSubtitle);
      if (s.coverTitleX !== undefined) setCoverTitleX(s.coverTitleX);
      if (s.coverTitleY !== undefined) setCoverTitleY(s.coverTitleY);
      if (s.coverSubX !== undefined) setCoverSubX(s.coverSubX);
      if (s.coverSubY !== undefined) setCoverSubY(s.coverSubY);
      if (s.coverTitleSize !== undefined) setCoverTitleSize(s.coverTitleSize);
      if (s.coverSubSize !== undefined) setCoverSubSize(s.coverSubSize);
      if (s.coverTitleColor !== undefined) setCoverTitleColor(s.coverTitleColor);
      if (s.coverSubColor !== undefined) setCoverSubColor(s.coverSubColor);
      if (s.coverTitleStrokeColor !== undefined) setCoverTitleStrokeColor(s.coverTitleStrokeColor);
      if (s.coverSubStrokeColor !== undefined) setCoverSubStrokeColor(s.coverSubStrokeColor);
      if (s.coverTitleStrokeWidth !== undefined) setCoverTitleStrokeWidth(s.coverTitleStrokeWidth);
      if (s.coverSubStrokeWidth !== undefined) setCoverSubStrokeWidth(s.coverSubStrokeWidth);
      if (s.coverTitleItalic !== undefined) setCoverTitleItalic(s.coverTitleItalic);
      if (s.coverSubItalic !== undefined) setCoverSubItalic(s.coverSubItalic);
      // 封面画幅自动跟随主视频画幅：优先用 videoAspect 一次性写回两个字段（保证不变量）。
      // 旧存档只有 coverAspect 时作向后兼容兜底。
      if (s.videoAspect !== undefined) setVideoAspect(s.videoAspect);
      else if (s.coverAspect !== undefined) setCoverAspect(s.coverAspect);
      if (s.videoResolution !== undefined) setVideoResolution(s.videoResolution);
      if (s.coverZoom !== undefined) setCoverZoom(s.coverZoom);
      if (s.coverOffsetX !== undefined) setCoverOffsetX(s.coverOffsetX);
      if (s.coverOffsetY !== undefined) setCoverOffsetY(s.coverOffsetY);
      if (s.coverFont !== undefined) setCoverFont(s.coverFont);
      if (s.coverFontPath !== undefined) setCoverFontPath(s.coverFontPath);
      if (s.coverVideoPath !== undefined) setCoverVideoPath(s.coverVideoPath);
      if (s.coverTime !== undefined) setCoverTime(s.coverTime);
      if (s.bgmName !== undefined) setBgmName(s.bgmName);
      if (s.bgmVolume !== undefined) setBgmVolume(s.bgmVolume);
      if (s.voiceVolume !== undefined) setVoiceVolume(s.voiceVolume);
    } catch { }
  }, []);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const baseUrl: string = await getBackendBaseUrl();
      await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' });
      fetchProjects();
    } catch { }
  }, [fetchProjects]);

  return (
    <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <HistoryIcon fontSize="small" color="action" />
        <Typography variant="subtitle2">项目历史</Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<SaveIcon />} variant="outlined"
          onClick={() => { setSaveName(''); setSaveOpen(true); }}>
          保存当前
        </Button>
      </Box>

      {loading ? <CircularProgress size={20} /> : projects.length === 0 ? (
        <Typography variant="body2" color="text.secondary">暂无保存的项目</Typography>
      ) : (
        projects.slice(0, 10).map(p => (
          <Paper key={p.id} elevation={0}
            sx={{ p: 1, mb: 0.5, display: 'flex', alignItems: 'center', gap: 1, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
            onClick={() => handleRestore(p.id)}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} noWrap>{p.name}</Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary">{p.created_at}</Typography>
                {p.script_preview && <Chip label={p.script_preview} size="small" sx={{ maxWidth: 200 }} />}
                {p.segment_count > 0 && <Chip label={`${p.segment_count} 片段`} size="small" variant="outlined" />}
              </Box>
            </Box>
            <Tooltip title="恢复此项目"><IconButton size="small" color="primary"><RestoreIcon /></IconButton></Tooltip>
            <Tooltip title="删除"><IconButton size="small" onClick={(e) => handleDelete(p.id, e)}><DeleteIcon /></IconButton></Tooltip>
          </Paper>
        ))
      )}

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)}>
        <DialogTitle>保存项目</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="项目名称" value={saveName}
            onChange={e => setSaveName(e.target.value)} placeholder="例如：产品宣传片 v1"
            sx={{ mt: 1, minWidth: 280 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)}>取消</Button>
          <Button variant="contained" onClick={handleSave} startIcon={<SaveIcon />}>保存</Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};

export default ProjectHistory;
