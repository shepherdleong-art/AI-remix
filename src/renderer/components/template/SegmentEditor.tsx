/**
 * SegmentEditor component.
 *
 * A right-side drawer panel for editing the properties of the currently
 * selected segment on the timeline. Provides controls for:
 * - Material selection (from materials store)
 * - Time trimming (startTime/endTime with inputs + sliders)
 * - Volume adjustment (0-100% slider)
 * - Speed adjustment (0.5x-2.0x slider with presets)
 * - Filter overlay (multi-select chips with value sliders)
 * - Text overlay configuration
 */
import React, { useCallback, useMemo } from 'react';
import {
  Box,
  Typography,
  Slider,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Chip,
  IconButton,
  Tooltip,
  Button,
  Divider,
  Paper,
  Switch,
  FormControlLabel,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import VolumeUpIcon from '@mui/icons-material/VolumeUp';
import SpeedIcon from '@mui/icons-material/Speed';
import SettingsIcon from '@mui/icons-material/Settings';
import TextFieldsIcon from '@mui/icons-material/FormatSize';
import type { SelectChangeEvent } from '@mui/material';
import { useTemplateStore } from '@/renderer/store/template-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { Segment, Filter, TextOverlay, FilterType } from '@/renderer/types/template';
import {
  FILTER_LABELS,
  FILTER_DEFAULTS,
  FILTER_RANGES,
  DEFAULT_TEXT_OVERLAY,
  TEXT_POSITION_PRESETS,
} from '@/renderer/types/template';
import type { AnyMaterial } from '@/renderer/types/material';

/** Available speed presets */
const SPEED_PRESETS: number[] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

/** All filter types */
const ALL_FILTER_TYPES: FilterType[] = ['brightness', 'contrast', 'saturation', 'blur', 'sharpen'];

/**
 * Segment property editor panel.
 *
 * Renders all editable properties for the currently selected segment.
 * Disabled/empty state when no segment is selected.
 */
const SegmentEditor: React.FC = () => {
  // Store
  const currentTemplate = useTemplateStore((s) => s.currentTemplate);
  const selectedSegmentId = useTemplateStore((s) => s.selectedSegmentId);
  const updateSegment = useTemplateStore((s) => s.updateSegment);
  const addFilter = useTemplateStore((s) => s.addFilter);
  const removeFilter = useTemplateStore((s) => s.removeFilter);
  const updateFilter = useTemplateStore((s) => s.updateFilter);
  const setTextOverlay = useTemplateStore((s) => s.setTextOverlay);
  const materials = useMaterialsStore((s) => s.materials);

  const template = currentTemplate();
  const segment: Segment | undefined = template?.segments.find(
    (s: Segment) => s.id === selectedSegmentId,
  );

  // Available video materials for the dropdown
  const availableMaterials: AnyMaterial[] = useMemo(
    () => materials.filter((m: AnyMaterial) => m.status === 'ready'),
    [materials],
  );

  // Current source material (for time range context)
  const sourceMaterial: AnyMaterial | undefined = useMemo(() => {
    if (!segment?.materialId) return undefined;
    return materials.find((m: AnyMaterial) => m.id === segment.materialId);
  }, [segment?.materialId, materials]);

  // Max time for sliders
  const maxSourceTime: number = useMemo(() => {
    if (sourceMaterial && 'durationSeconds' in sourceMaterial) {
      return (sourceMaterial as { durationSeconds: number }).durationSeconds || 60;
    }
    return 60;
  }, [sourceMaterial]);

  // ─── Empty State ──────────────────────────────────────

  if (!segment) {
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle2" fontWeight={600} gutterBottom>
          片段属性
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          请选择时间轴上的一个片段以编辑其属性
        </Typography>
      </Paper>
    );
  }

  // ─── Handlers ─────────────────────────────────────────

  const handleMaterialChange = useCallback(
    (event: SelectChangeEvent): void => {
      updateSegment(segment.id, { materialId: event.target.value });
    },
    [segment.id, updateSegment],
  );

  const handleStartTimeChange = useCallback(
    (_event: Event, value: number | number[]): void => {
      const v: number = value as number;
      updateSegment(segment.id, {
        startTime: v,
        endTime: Math.min(maxSourceTime, Math.max(v + 0.1, segment.endTime)),
      });
    },
    [segment.id, segment.endTime, maxSourceTime, updateSegment],
  );

  const handleEndTimeChange = useCallback(
    (_event: Event, value: number | number[]): void => {
      const v: number = value as number;
      updateSegment(segment.id, {
        endTime: v,
        startTime: Math.min(segment.startTime, Math.max(0, v - 0.1)),
      });
    },
    [segment.id, segment.startTime, updateSegment],
  );

  const handleVolumeChange = useCallback(
    (_event: Event, value: number | number[]): void => {
      updateSegment(segment.id, { volume: (value as number) / 100 });
    },
    [segment.id, updateSegment],
  );

  const handleSpeedChange = useCallback(
    (_event: Event, value: number | number[]): void => {
      updateSegment(segment.id, { speed: value as number });
    },
    [segment.id, updateSegment],
  );

  const handleSpeedPreset = useCallback(
    (speed: number): void => {
      updateSegment(segment.id, { speed });
    },
    [segment.id, updateSegment],
  );

  const handleFilterToggle = useCallback(
    (filterType: FilterType): void => {
      const existing: Filter | undefined = segment.filters.find(
        (f: Filter) => f.type === filterType,
      );
      if (existing) {
        removeFilter(segment.id, filterType);
      } else {
        addFilter(segment.id, { type: filterType, value: FILTER_DEFAULTS[filterType] });
      }
    },
    [segment.id, segment.filters, addFilter, removeFilter],
  );

  const handleFilterValueChange = useCallback(
    (filterType: FilterType) =>
      (_event: Event, value: number | number[]): void => {
        updateFilter(segment.id, filterType, value as number);
      },
    [segment.id, updateFilter],
  );

  const handleTextToggle = useCallback(
    (_event: React.ChangeEvent<HTMLInputElement>, checked: boolean): void => {
      if (checked) {
        setTextOverlay(segment.id, { ...DEFAULT_TEXT_OVERLAY });
      } else {
        setTextOverlay(segment.id, null);
      }
    },
    [segment.id, setTextOverlay],
  );

  const handleTextChange = useCallback(
    (field: keyof TextOverlay) =>
      (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
        if (segment.textOverlay) {
          setTextOverlay(segment.id, {
            ...segment.textOverlay,
            [field]: event.target.value,
          } as TextOverlay);
        }
      },
    [segment.id, segment.textOverlay, setTextOverlay],
  );

  const handleTextSelectChange = useCallback(
    (field: keyof TextOverlay) =>
      (event: SelectChangeEvent): void => {
        if (segment.textOverlay) {
          setTextOverlay(segment.id, {
            ...segment.textOverlay,
            [field]: event.target.value,
          } as TextOverlay);
        }
      },
    [segment.id, segment.textOverlay, setTextOverlay],
  );

  const handleTextNumberChange = useCallback(
    (field: 'fontSize' | 'startTime' | 'duration') =>
      (_event: Event, value: number | number[]): void => {
        if (segment.textOverlay) {
          setTextOverlay(segment.id, {
            ...segment.textOverlay,
            [field]: value as number,
          } as TextOverlay);
        }
      },
    [segment.id, segment.textOverlay, setTextOverlay],
  );

  const activeFilters: FilterType[] = segment.filters.map((f: Filter) => f.type);

  return (
    <Paper variant="outlined" sx={{ p: 2, maxHeight: '100%', overflowY: 'auto' }}>
      <Typography variant="subtitle2" fontWeight={600} gutterBottom>
        片段属性
      </Typography>
      <Typography variant="caption" color="text.secondary">
        片段 #{segment.order + 1} — {segment.duration.toFixed(1)}s
      </Typography>

      <Divider sx={{ my: 1.5 }} />

      {/* ── Material Selection ─────────────────────────── */}
      <FormControl fullWidth size="small" sx={{ mb: 2 }}>
        <InputLabel>关联素材</InputLabel>
        <Select
          value={segment.materialId}
          label="关联素材"
          onChange={handleMaterialChange}
        >
          <MenuItem value="">
            <em>未选择素材</em>
          </MenuItem>
          {availableMaterials.map((m: AnyMaterial) => (
            <MenuItem key={m.id} value={m.id}>
              {m.fileName} ({m.type === 'video' ? '视频' : '图片'})
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {/* ── Time Trimming ──────────────────────────────── */}
      <Typography variant="caption" fontWeight={600}>
        时间裁剪
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mb: 1 }}>
        <TextField
          label="起始"
          type="number"
          size="small"
          value={segment.startTime}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            updateSegment(segment.id, { startTime: Math.max(0, parseFloat(e.target.value) || 0) });
          }}
          inputProps={{ min: 0, max: maxSourceTime, step: 0.1 }}
          sx={{ flex: 1 }}
        />
        <TextField
          label="结束"
          type="number"
          size="small"
          value={segment.endTime}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            updateSegment(segment.id, { endTime: Math.min(maxSourceTime, Math.max(segment.startTime + 0.1, parseFloat(e.target.value) || segment.startTime + 0.1)) });
          }}
          inputProps={{ min: segment.startTime + 0.1, max: maxSourceTime, step: 0.1 }}
          sx={{ flex: 1 }}
        />
      </Box>
      <Slider
        value={[segment.startTime, segment.endTime]}
        onChange={(_e: Event, value: number | number[]) => {
          const [s, e] = value as [number, number];
          updateSegment(segment.id, { startTime: s, endTime: Math.max(s + 0.1, e) });
        }}
        min={0}
        max={maxSourceTime}
        step={0.1}
        size="small"
        valueLabelDisplay="auto"
        sx={{ mb: 2 }}
      />

      <Divider sx={{ my: 1.5 }} />

      {/* ── Volume ─────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <VolumeUpIcon fontSize="small" color="action" />
        <Typography variant="caption">音量</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', minWidth: 32, textAlign: 'right' }}>
          {Math.round(segment.volume * 100)}%
        </Typography>
      </Box>
      <Slider
        value={segment.volume * 100}
        onChange={handleVolumeChange}
        min={0}
        max={100}
        step={1}
        size="small"
        sx={{ mb: 2 }}
      />

      {/* ── Speed ──────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <SpeedIcon fontSize="small" color="action" />
        <Typography variant="caption">速度</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto', minWidth: 32, textAlign: 'right' }}>
          {segment.speed.toFixed(1)}x
        </Typography>
      </Box>
      <Slider
        value={segment.speed}
        onChange={handleSpeedChange}
        min={0.5}
        max={2.0}
        step={0.1}
        size="small"
        valueLabelDisplay="auto"
        valueLabelFormat={(v: number) => `${v.toFixed(1)}x`}
        sx={{ mb: 1 }}
      />
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 2 }}>
        {SPEED_PRESETS.map((sp: number) => (
          <Chip
            key={sp}
            label={`${sp}x`}
            size="small"
            variant={Math.abs(segment.speed - sp) < 0.05 ? 'filled' : 'outlined'}
            color={Math.abs(segment.speed - sp) < 0.05 ? 'primary' : 'default'}
            onClick={() => handleSpeedPreset(sp)}
            clickable
            sx={{ height: 22, fontSize: 11 }}
          />
        ))}
      </Box>

      <Divider sx={{ my: 1.5 }} />

      {/* ── Filters ────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <SettingsIcon fontSize="small" color="action" />
        <Typography variant="caption" fontWeight={600}>
          滤镜
        </Typography>
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1 }}>
        {ALL_FILTER_TYPES.map((ft: FilterType) => (
          <Chip
            key={ft}
            label={FILTER_LABELS[ft]}
            size="small"
            variant={activeFilters.includes(ft) ? 'filled' : 'outlined'}
            color={activeFilters.includes(ft) ? 'primary' : 'default'}
            onClick={() => handleFilterToggle(ft)}
            clickable
            sx={{ height: 22, fontSize: 11 }}
          />
        ))}
      </Box>
      {/* Filter value sliders for active filters */}
      {segment.filters.map((f: Filter) => (
        <Box key={f.type} sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">
              {FILTER_LABELS[f.type]}
            </Typography>
            <IconButton
              size="small"
              onClick={() => removeFilter(segment.id, f.type)}
              sx={{ p: 0, mb: -0.5 }}
            >
              <DeleteIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
          <Slider
            value={f.value}
            onChange={handleFilterValueChange(f.type)}
            min={FILTER_RANGES[f.type][0]}
            max={FILTER_RANGES[f.type][1]}
            step={f.type === 'blur' || f.type === 'sharpen' ? 0.5 : 1}
            size="small"
            valueLabelDisplay="auto"
          />
        </Box>
      ))}

      <Divider sx={{ my: 1.5 }} />

      {/* ── Text Overlay ───────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <TextFieldsIcon fontSize="small" color="action" />
        <Typography variant="caption" fontWeight={600}>
          文字叠加
        </Typography>
      </Box>
      <FormControlLabel
        control={
          <Switch
            checked={segment.textOverlay !== null}
            onChange={handleTextToggle}
            size="small"
          />
        }
        label={<Typography variant="caption">启用文字叠加</Typography>}
        sx={{ mb: 1 }}
      />

      {segment.textOverlay && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 1 }}>
          <TextField
            label="文字内容"
            size="small"
            fullWidth
            value={segment.textOverlay.text}
            onChange={handleTextChange('text')}
          />
          <TextField
            label="字体"
            size="small"
            fullWidth
            value={segment.textOverlay.font}
            onChange={handleTextChange('font')}
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="字号"
              type="number"
              size="small"
              value={segment.textOverlay.fontSize}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                handleTextNumberChange('fontSize')({} as Event, parseInt(e.target.value, 10) || 16);
              }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="颜色"
              size="small"
              value={segment.textOverlay.color}
              onChange={handleTextChange('color')}
              sx={{ flex: 1 }}
              InputProps={{
                startAdornment: (
                  <Box
                    sx={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      bgcolor: segment.textOverlay.color,
                      border: '1px solid #ccc',
                    }}
                  />
                ),
              }}
            />
          </Box>
          <FormControl size="small" fullWidth>
            <InputLabel>位置</InputLabel>
            <Select
              value={segment.textOverlay.position}
              label="位置"
              onChange={handleTextSelectChange('position')}
            >
              {Object.entries(TEXT_POSITION_PRESETS).map(([key]) => (
                <MenuItem key={key} value={key}>
                  {key}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <TextField
              label="起始(s)"
              type="number"
              size="small"
              value={segment.textOverlay.startTime}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                handleTextNumberChange('startTime')({} as Event, parseFloat(e.target.value) || 0);
              }}
              sx={{ flex: 1 }}
            />
            <TextField
              label="时长(s)"
              type="number"
              size="small"
              value={segment.textOverlay.duration}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                handleTextNumberChange('duration')({} as Event, parseFloat(e.target.value) || 1);
              }}
              sx={{ flex: 1 }}
            />
          </Box>
        </Box>
      )}
    </Paper>
  );
};

export default SegmentEditor;
