/**
 * TransitionPicker component.
 *
 * Visual selector for 6 transition effects with preview and duration slider.
 * Allows users to pick a transition type and set its duration.
 */
import React, { useCallback } from 'react';
import {
  Box,
  Typography,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Paper,
  Tooltip,
} from '@mui/material';
import type {
  Transition,
  TransitionType,
} from '@/renderer/types/template';
import { TRANSITION_LABELS } from '@/renderer/types/template';

interface TransitionPickerProps {
  /** Current transition value */
  transition: Transition;
  /** Label for the picker (e.g., "入转场" or "出转场") */
  label: string;
  /** Callback when transition changes */
  onChange: (transition: Transition) => void;
}

/**
 * Visual representation of each transition type for the preview.
 * Uses simple CSS-based animations to suggest the effect.
 */
const TRANSITION_PREVIEWS: Record<TransitionType, { gradient: string; description: string }> = {
  none: {
    gradient: 'linear-gradient(135deg, #1976d2 0%, #1976d2 50%, #9c27b0 50%, #9c27b0 100%)',
    description: '无转场效果，直接切换',
  },
  fade: {
    gradient: 'linear-gradient(135deg, #1976d2 0%, #7b68cc 50%, #9c27b0 100%)',
    description: '逐步淡入淡出切换',
  },
  slide: {
    gradient: 'linear-gradient(90deg, #1976d2 0%, #1976d2 60%, #9c27b0 60%, #9c27b0 100%)',
    description: '水平滑动切换镜头',
  },
  zoom: {
    gradient: 'radial-gradient(circle, #1976d2 0%, #7b68cc 40%, #9c27b0 100%)',
    description: '缩放放大/缩小过渡',
  },
  wipe: {
    gradient: 'linear-gradient(135deg, #1976d2 0%, #1976d2 30%, #ffffff 30%, #ffffff 70%, #9c27b0 70%, #9c27b0 100%)',
    description: '擦除式切换效果',
  },
  dissolve: {
    gradient: 'linear-gradient(135deg, rgba(25,118,210,0.6) 0%, rgba(156,39,176,0.6) 50%, rgba(25,118,210,0.6) 100%)',
    description: '溶解混合切换',
  },
};

const TRANSITION_TYPES: TransitionType[] = ['none', 'fade', 'slide', 'zoom', 'wipe', 'dissolve'];

/**
 * Visual transition effect picker with duration control.
 *
 * Renders 6 toggle buttons with CSS gradient previews and a
 * duration slider (0.1s - 3.0s) for fine-tuning.
 */
const TransitionPicker: React.FC<TransitionPickerProps> = ({
  transition,
  label,
  onChange,
}) => {
  const handleTypeChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, newType: TransitionType | null): void => {
      if (newType !== null) {
        onChange({ ...transition, type: newType });
      }
    },
    [transition, onChange],
  );

  const handleDurationChange = useCallback(
    (_event: Event, value: number | number[]): void => {
      onChange({ ...transition, duration: value as number });
    },
    [transition, onChange],
  );

  const preview = TRANSITION_PREVIEWS[transition.type] || TRANSITION_PREVIEWS.none;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" gutterBottom fontWeight={600}>
        {label}
      </Typography>

      {/* Transition type selector */}
      <ToggleButtonGroup
        value={transition.type}
        exclusive
        onChange={handleTypeChange}
        size="small"
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 0.5,
          mb: 1.5,
          width: '100%',
        }}
      >
        {TRANSITION_TYPES.map((type: TransitionType) => (
          <ToggleButton
            key={type}
            value={type}
            sx={{
              flexDirection: 'column',
              p: 0.75,
              minWidth: 0,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: '8px !important',
            }}
          >
            <Tooltip title={TRANSITION_PREVIEWS[type]?.description || ''} arrow>
              <Box
                sx={{
                  width: 40,
                  height: 24,
                  borderRadius: '4px',
                  background: TRANSITION_PREVIEWS[type]?.gradient || '#ccc',
                  mb: 0.3,
                }}
              />
            </Tooltip>
            <Typography variant="caption" sx={{ fontSize: 10, lineHeight: 1 }}>
              {TRANSITION_LABELS[type]}
            </Typography>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* Duration slider */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 36, fontSize: 11 }}>
          时长
        </Typography>
        <Slider
          value={transition.duration}
          onChange={handleDurationChange}
          min={0.1}
          max={3.0}
          step={0.1}
          size="small"
          valueLabelDisplay="auto"
          valueLabelFormat={(v: number) => `${v.toFixed(1)}s`}
          sx={{ flex: 1 }}
        />
        <Typography variant="caption" sx={{ minWidth: 36, textAlign: 'right', fontSize: 11 }}>
          {transition.duration.toFixed(1)}s
        </Typography>
      </Box>

      {/* Preview description */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block', fontSize: 11 }}>
        {preview.description}
      </Typography>
    </Paper>
  );
};

export default TransitionPicker;
