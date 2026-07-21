import { createTheme, type Theme, type PaletteMode } from '@mui/material/styles';

// Extend MUI's background palette so `background.paperAlt` is typed & theme-aware.
declare module '@mui/material/styles' {
  interface TypeBackground {
    paperAlt: string;
  }
}

/**
 * FCP (Final Cut Pro) inspired design tokens.
 *
 * Light (default): clean white workspace with classic blue accent (#1976d2).
 * Dark: immersive near-black workspace (#121212) with mint-green accent (#2DD4BF),
 *   mirroring the screenshot reference (dark page + light-green highlights).
 */

interface FcpPalette {
  bg: string;
  paper: string;
  paperAlt: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  primary: string;
  primaryHover: string;
  primaryActive: string;
  primaryContrast: string;
}

const LIGHT: FcpPalette = {
  bg: '#ECECEC',
  paper: '#FFFFFF',
  paperAlt: '#F7F7F8',
  divider: '#D9D9D9',
  textPrimary: '#1D1D1F',
  textSecondary: '#6E6E73',
  primary: '#1976D2',
  primaryHover: '#1565C0',
  primaryActive: '#0D47A1',
  primaryContrast: '#FFFFFF',
};

const DARK: FcpPalette = {
  bg: '#121212',
  paper: '#1E1E1E',
  paperAlt: '#262626',
  divider: '#2E2E2E',
  textPrimary: '#F5F5F7',
  textSecondary: '#A1A1A6',
  primary: '#2DD4BF',
  primaryHover: '#5EEAD4',
  primaryActive: '#14B8A6',
  primaryContrast: '#062B27',
};

export const FCP_FONT_FAMILY = [
  '"Microsoft YaHei"',
  '"PingFang SC"',
  '"Hiragino Sans GB"',
  '"Noto Sans SC"',
  'system-ui',
  'sans-serif',
].join(',');

export function buildFcpTheme(mode: PaletteMode): Theme {
  const p = mode === 'dark' ? DARK : LIGHT;
  return createTheme({
    palette: {
      mode,
      primary: {
        main: p.primary,
        // Blue (light) buttons use white text; mint-green (dark) buttons use deep green text
        contrastText: p.primaryContrast,
        dark: p.primaryActive,
        light: p.primaryHover,
      },
      background: { default: p.bg, paper: p.paper, paperAlt: p.paperAlt },
      text: { primary: p.textPrimary, secondary: p.textSecondary },
      divider: p.divider,
      error: { main: '#FF3B30' },
      success: { main: '#34C759' },
      warning: { main: '#FF9F0A' },
      info: { main: '#0A84FF' },
      action: {
        hover: mode === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
        selected: mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
      },
    },
    typography: {
      fontFamily: FCP_FONT_FAMILY,
      fontWeightRegular: 400,
      fontWeightMedium: 500,
      fontWeightBold: 700,
      h4: { fontWeight: 700, letterSpacing: '-0.02em' },
      h5: { fontWeight: 700, letterSpacing: '-0.015em' },
      h6: { fontWeight: 700, letterSpacing: '-0.01em' },
      subtitle1: { fontWeight: 600 },
      subtitle2: { fontWeight: 600 },
      body1: { fontSize: 14 },
      body2: { fontSize: 13 },
      caption: { fontSize: 12 },
    },
    shape: { borderRadius: 8 },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { textTransform: 'none', fontWeight: 600, borderRadius: 8 },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: 'none' } },
      },
      MuiCssBaseline: {
        styleOverrides: { body: { fontFamily: FCP_FONT_FAMILY } },
      },
    },
  });
}
