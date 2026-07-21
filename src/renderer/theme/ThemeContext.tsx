import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { buildFcpTheme } from './fcpTheme';

export type ThemeMode = 'light' | 'dark' | 'system';
type ResolvedMode = 'light' | 'dark';

interface ThemeModeContextValue {
  mode: ThemeMode;
  resolvedMode: ResolvedMode;
  setMode: (m: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

const STORAGE_KEY = 'fcp-theme-mode';

function getSystemMode(): ResolvedMode {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const ThemeModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'light';
  });
  const [systemMode, setSystemMode] = useState<ResolvedMode>(getSystemMode);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent): void =>
      setSystemMode(e.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const resolvedMode: ResolvedMode = mode === 'system' ? systemMode : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-fcp-theme', resolvedMode);
  }, [resolvedMode]);

  const setMode = (m: ThemeMode): void => {
    setModeState(m);
    localStorage.setItem(STORAGE_KEY, m);
  };

  const theme = useMemo(() => buildFcpTheme(resolvedMode), [resolvedMode]);
  const value = useMemo(() => ({ mode, resolvedMode, setMode }), [mode, resolvedMode]);

  return (
    <ThemeModeContext.Provider value={value}>
      <ThemeProvider theme={theme}>{children}</ThemeProvider>
    </ThemeModeContext.Provider>
  );
};

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used within ThemeModeProvider');
  return ctx;
}
