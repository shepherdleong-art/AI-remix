import React from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import LightModeIcon from '@mui/icons-material/LightMode';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows';
import { useThemeMode, type ThemeMode } from '@/renderer/theme/ThemeContext';

const OPTIONS: Array<{
  mode: ThemeMode;
  label: string;
  Icon: React.ComponentType<{ fontSize?: 'small' | 'inherit' }>;
}> = [
  { mode: 'light', label: '浅色', Icon: LightModeIcon },
  { mode: 'dark', label: '深色', Icon: DarkModeIcon },
  { mode: 'system', label: '跟随系统', Icon: DesktopWindowsIcon },
];

/**
 * Segmented theme control (浅 / 深 / 跟随). Current option highlighted yellow.
 */
export const ThemeSwitch: React.FC = () => {
  const { mode, setMode } = useThemeMode();
  return (
    <Box
      sx={{
        display: 'inline-flex',
        p: 0.5,
        gap: 0.5,
        borderRadius: 2,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      {OPTIONS.map(({ mode: m, label, Icon }) => {
        const active = mode === m;
        return (
          <Tooltip title={label} key={m}>
            <IconButton
              size="small"
              aria-label={label}
              aria-pressed={active}
              onClick={() => setMode(m)}
              color={active ? 'primary' : 'default'}
              sx={{
                borderRadius: 1.5,
                bgcolor: active ? 'primary.main' : 'transparent',
                color: active ? 'primary.contrastText' : 'text.secondary',
                '&:hover': {
                  bgcolor: active ? 'primary.main' : 'action.hover',
                },
              }}
            >
              <Icon fontSize="small" />
            </IconButton>
          </Tooltip>
        );
      })}
    </Box>
  );
};
