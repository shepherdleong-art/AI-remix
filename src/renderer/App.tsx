import React from 'react';
import { CssBaseline } from '@mui/material';
import { ThemeModeProvider } from '@/renderer/theme/ThemeContext';
import { ErrorBoundary } from '@/renderer/components/common/ErrorBoundary';
import AppShell from '@/renderer/components/layout/AppShell';
import ModeSelector from '@/renderer/components/batch/ModeSelector';
import BatchWizard from '@/renderer/components/batch/BatchWizard';

/**
 * 入口双模式（D9）：
 * - select：启动先选【单条精细】/【批量生产】
 * - single：现有四步流程（AppShell 原样渲染，行为不变）
 * - batch：批量生产向导（上传 → 预修 → 脚本 → 分配审改 → 导出）
 */
const App: React.FC = () => {
  const [mode, setMode] = React.useState<'select' | 'single' | 'batch'>('select');

  return (
    <ThemeModeProvider>
      <CssBaseline />
      <ErrorBoundary>
        {mode === 'single' ? (
          <AppShell />
        ) : mode === 'batch' ? (
          <BatchWizard onExit={() => setMode('select')} />
        ) : (
          <ModeSelector onSelectMode={setMode} />
        )}
      </ErrorBoundary>
    </ThemeModeProvider>
  );
};

export default App;
