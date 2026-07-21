import React from 'react';
import { Box, ToggleButtonGroup, ToggleButton, Typography } from '@mui/material';
import { useEditingStore } from '@/renderer/store/editing-store';

/**
 * Top-bar global aspect / resolution control.
 * Binds directly to editing-store (the single source of truth), so the
 * preview and export stay in sync no matter where it is changed.
 * Active state uses theme.palette.primary → works in light & dark.
 */
export const GlobalAspectControl: React.FC = () => {
  const videoAspect = useEditingStore((s) => s.videoAspect);
  const videoResolution = useEditingStore((s) => s.videoResolution);
  const setVideoAspect = useEditingStore((s) => s.setVideoAspect);
  const setVideoResolution = useEditingStore((s) => s.setVideoResolution);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          画幅
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={videoAspect}
          onChange={(_, v: '9:16' | '3:4' | null) => v && setVideoAspect(v)}
          sx={{ height: 30 }}
        >
          <ToggleButton value="9:16" sx={{ px: 1.5, py: 0.25 }}>
            9:16
          </ToggleButton>
          <ToggleButton value="3:4" sx={{ px: 1.5, py: 0.25 }}>
            3:4
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          分辨率
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={videoResolution}
          onChange={(_, v: '1080p' | '2K' | null) => v && setVideoResolution(v)}
          sx={{ height: 30 }}
        >
          <ToggleButton value="1080p" sx={{ px: 1.5, py: 0.25 }}>
            1080p
          </ToggleButton>
          <ToggleButton value="2K" sx={{ px: 1.5, py: 0.25 }}>
            2K
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>
    </Box>
  );
};
