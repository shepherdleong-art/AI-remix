/**
 * RenderSettings component.
 *
 * Provides render configuration controls:
 * - Output format selection (MP4/WebM/GIF)
 * - Resolution selection (720p/1080p/original)
 * - Frame rate selection (24/30/60)
 * - Quality preset (low/medium/high)
 * - Audio toggle
 * - Watermark text input
 * - Preset save/load (up to 3 custom presets)
 */
import React, { useState, useCallback } from 'react';
import {
  Box,
  Typography,
  ToggleButtonGroup,
  ToggleButton,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Slider,
  Switch,
  TextField,
  Button,
  IconButton,
  Tooltip,
  Chip,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Paper,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import DeleteIcon from '@mui/icons-material/Delete';
import BookmarkIcon from '@mui/icons-material/Bookmark';

import { useRenderStore } from '@/renderer/store/render-store';
import type {
  RenderConfig,
  OutputFormat,
  ResolutionOption,
  FpsOption,
  QualityPreset,
} from '@/renderer/types/renderer';
import {
  SUPPORTED_FORMATS,
  FORMAT_LABELS,
  RESOLUTION_OPTIONS,
  RESOLUTION_LABELS,
  FPS_OPTIONS,
  FPS_LABELS,
  QUALITY_LABELS,
  MAX_RENDER_PRESETS,
} from '@/renderer/types/renderer';

/** Quality slider marks */
const QUALITY_MARKS: Array<{ value: number; label: string }> = [
  { value: 0, label: '低' },
  { value: 1, label: '中' },
  { value: 2, label: '高' },
];

/** Map slider index to QualityPreset */
const INDEX_TO_QUALITY: QualityPreset[] = ['low', 'medium', 'high'];

/** Map QualityPreset to slider index */
function qualityToIndex(q: QualityPreset): number {
  switch (q) {
    case 'low': return 0;
    case 'medium': return 1;
    case 'high': return 2;
  }
}

/**
 * Render settings panel for configuring output options.
 */
const RenderSettings: React.FC = () => {
  // Store
  const config = useRenderStore((s) => s.config);
  const presets = useRenderStore((s) => s.presets);
  const updateConfig = useRenderStore((s) => s.updateConfig);
  const savePreset = useRenderStore((s) => s.savePreset);
  const deletePreset = useRenderStore((s) => s.deletePreset);
  const applyPreset = useRenderStore((s) => s.applyPreset);

  // Local state
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [presetName, setPresetName] = useState<string>('');

  // Handlers
  const handleFormatChange = useCallback(
    (_: React.MouseEvent<HTMLElement>, newFormat: OutputFormat | null): void => {
      if (newFormat) {
        updateConfig({ outputFormat: newFormat });
      }
    },
    [updateConfig],
  );

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<{ value: unknown }>): void => {
      updateConfig({ resolution: e.target.value as ResolutionOption });
    },
    [updateConfig],
  );

  const handleFpsChange = useCallback(
    (e: React.ChangeEvent<{ value: unknown }>): void => {
      updateConfig({ fps: e.target.value as FpsOption });
    },
    [updateConfig],
  );

  const handleQualityChange = useCallback(
    (_: Event, value: number | number[]): void => {
      const idx: number = Array.isArray(value) ? value[0] : value;
      updateConfig({ quality: INDEX_TO_QUALITY[idx] });
    },
    [updateConfig],
  );

  const handleAudioToggle = useCallback(
    (_: React.ChangeEvent<HTMLInputElement>): void => {
      updateConfig({ includeAudio: !config.includeAudio });
    },
    [config.includeAudio, updateConfig],
  );

  const handleWatermarkChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      updateConfig({ watermark: e.target.value });
    },
    [updateConfig],
  );

  const handleSavePreset = useCallback((): void => {
    if (presetName.trim()) {
      savePreset(presetName.trim());
      setPresetName('');
      setSaveDialogOpen(false);
    }
  }, [presetName, savePreset]);

  const handleDeletePreset = useCallback(
    (presetId: string): void => {
      deletePreset(presetId);
    },
    [deletePreset],
  );

  const handleApplyPreset = useCallback(
    (presetId: string): void => {
      applyPreset(presetId);
    },
    [applyPreset],
  );

  const canSavePreset: boolean = presets.length < MAX_RENDER_PRESETS;

  return (
    <Paper elevation={0} sx={{ p: 3 }}>
      <Typography variant="h6" gutterBottom fontWeight={600}>
        渲染设置
      </Typography>

      {/* Output Format */}
      <Box sx={{ mb: 3 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          输出格式
        </Typography>
        <ToggleButtonGroup
          value={config.outputFormat}
          exclusive
          onChange={handleFormatChange}
          size="small"
          fullWidth
        >
          {SUPPORTED_FORMATS.map((fmt: OutputFormat) => (
            <ToggleButton key={fmt} value={fmt}>
              {fmt.toUpperCase()}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          {FORMAT_LABELS[config.outputFormat]}
        </Typography>
      </Box>

      {/* Resolution */}
      <Box sx={{ mb: 2 }}>
        <FormControl fullWidth size="small">
          <InputLabel>分辨率</InputLabel>
          <Select
            value={config.resolution}
            label="分辨率"
            onChange={handleResolutionChange as never}
          >
            {RESOLUTION_OPTIONS.map((opt: ResolutionOption) => (
              <MenuItem key={opt} value={opt}>
                {RESOLUTION_LABELS[opt]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* FPS */}
      <Box sx={{ mb: 2 }}>
        <FormControl fullWidth size="small">
          <InputLabel>帧率</InputLabel>
          <Select
            value={config.fps}
            label="帧率"
            onChange={handleFpsChange as never}
          >
            {FPS_OPTIONS.map((opt: FpsOption) => (
              <MenuItem key={opt} value={opt}>
                {FPS_LABELS[opt]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Box>

      {/* Quality */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          质量预设
        </Typography>
        <Slider
          value={qualityToIndex(config.quality)}
          onChange={handleQualityChange}
          step={1}
          min={0}
          max={2}
          marks={QUALITY_MARKS}
          valueLabelDisplay="auto"
          valueLabelFormat={(idx: number) => QUALITY_LABELS[INDEX_TO_QUALITY[idx]]}
        />
      </Box>

      {/* Audio Toggle */}
      <Box sx={{ mb: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="body2">包含音频</Typography>
        <Switch
          checked={config.includeAudio}
          onChange={handleAudioToggle}
          size="small"
        />
      </Box>

      {/* Watermark */}
      <Box sx={{ mb: 3 }}>
        <TextField
          fullWidth
          size="small"
          label="水印文字（可选）"
          value={config.watermark}
          onChange={handleWatermarkChange}
          placeholder="例如: @YourName"
          helperText="水印将显示在视频右下角"
          inputProps={{ maxLength: 50 }}
        />
      </Box>

      <Divider sx={{ mb: 2 }} />

      {/* Presets */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="subtitle2" color="text.secondary">
            配置预设（{presets.length}/{MAX_RENDER_PRESETS}）
          </Typography>
          <Tooltip title={canSavePreset ? '保存当前配置' : `最多保存 ${MAX_RENDER_PRESETS} 个预设`}>
            <span>
              <Button
                size="small"
                startIcon={<SaveIcon />}
                onClick={() => setSaveDialogOpen(true)}
                disabled={!canSavePreset}
              >
                保存
              </Button>
            </span>
          </Tooltip>
        </Box>

        {presets.length === 0 ? (
          <Typography variant="caption" color="text.disabled">
            暂无保存的预设
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
            {presets.map((preset) => (
              <Chip
                key={preset.id}
                icon={<BookmarkIcon />}
                label={preset.name}
                onClick={() => handleApplyPreset(preset.id)}
                onDelete={() => handleDeletePreset(preset.id)}
                size="small"
                variant="outlined"
              />
            ))}
          </Box>
        )}
      </Box>

      {/* Save Preset Dialog */}
      <Dialog open={saveDialogOpen} onClose={() => setSaveDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>保存配置预设</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="预设名称"
            value={presetName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPresetName(e.target.value)}
            placeholder="例如: 高清MP4预设"
            sx={{ mt: 1 }}
            inputProps={{ maxLength: 20 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveDialogOpen(false)}>取消</Button>
          <Button
            onClick={handleSavePreset}
            variant="contained"
            disabled={!presetName.trim()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};

export default RenderSettings;
