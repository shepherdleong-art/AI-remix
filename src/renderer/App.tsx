import React from 'react';
import {
  Container,
  Box,
  Typography,
  Paper,
  Stepper,
  Step,
  StepButton,
  Button,
  ThemeProvider,
  createTheme,
  CssBaseline,
  Alert,
  Snackbar,
} from '@mui/material';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import { useEditingStore } from '@/renderer/store/editing-store';
import { useAnalysisStore } from '@/renderer/store/analysis-store';
import { useRenderStore } from '@/renderer/store/render-store';
import MaterialsManager from '@/renderer/components/materials/MaterialsManager';
import AiScriptEditor from '@/renderer/components/analysis/AiScriptEditor';
import TimelineEditor from '@/renderer/components/analysis/TimelineEditor';
import ExportConfirm from '@/renderer/components/render/ExportConfirm';

/**
 * Application step definitions.
 */
const STEPS: string[] = [
  '导入素材',
  'AI智能创作',
  '预览调整',
  '导出渲染',
];

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
    background: {
      default: '#f5f5f5',
      paper: '#ffffff',
    },
  },
  typography: {
    fontFamily: [
      '"Microsoft YaHei"',
      '"PingFang SC"',
      '"Hiragino Sans GB"',
      '"Noto Sans SC"',
      'sans-serif',
    ].join(','),
  },
});

/**
 * Root application component.
 *
 * Provides the step-based workflow skeleton for the short video mashup tool.
 * Step 1 (智能分析) integrates the AnalysisOverview component.
 */
const App: React.FC = () => {
  const [activeStep, setActiveStep] = React.useState<number>(0);
  const [snackbarOpen, setSnackbarOpen] = React.useState<boolean>(false);
  const [snackbarMessage, setSnackbarMessage] = React.useState<string>('');

  // Cross-store state for validation
  const materials = useMaterialsStore((s) => s.materials);
  const editingRunning = useEditingStore((s) => s.running);
  const timeline = useEditingStore((s) => s.timeline);
  const isBatchRunning = useAnalysisStore((s) => s.isBatchRunning);
  const isRendering = useRenderStore((s) => s.isRendering);

  // Global busy state — any long-running operation
  const isBusy = editingRunning || isBatchRunning || isRendering;

  /** Show a validation message to the user. */
  const showWarning = (message: string): void => {
    setSnackbarMessage(message);
    setSnackbarOpen(true);
  };

  /**
   * Validate whether the user can navigate to a given step.
   * Returns true if navigation is allowed.
   */
  const canNavigateTo = (targetStep: number): boolean => {
    // Always allow going backward
    if (targetStep < activeStep) return true;

    // Block navigation during long-running operations
    if (isBusy && targetStep !== activeStep) {
      showWarning('当前有任务正在运行，请等待完成后再切换步骤');
      return false;
    }

    // Step 1 (AI创作): need at least 1 material imported
    if (targetStep >= 1 && materials.length === 0) {
      showWarning('请先导入至少一个素材文件');
      return false;
    }

    // Step 3 (导出渲染): need a timeline
    if (targetStep >= 3 && timeline.length === 0) {
      showWarning('请先在 AI 创作步骤生成时间线');
      return false;
    }

    return true;
  };

  const handleStepClick = (index: number): void => {
    if (canNavigateTo(index)) {
      setActiveStep(index);
    }
  };

  const handleNext = (): void => {
    const target = Math.min(activeStep + 1, STEPS.length - 1);
    if (canNavigateTo(target)) {
      setActiveStep(target);
    }
  };

  const handleBack = (): void => {
    setActiveStep((prev: number) => Math.max(prev - 1, 0));
  };

  // Cleanup polling timers on window unload
  React.useEffect(() => {
    const cleanup = (): void => {
      useAnalysisStore.getState().stopAllPolling();
      useRenderStore.getState().stopAllPolling();
    };
    window.addEventListener('beforeunload', cleanup);
    return () => {
      window.removeEventListener('beforeunload', cleanup);
    };
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="lg" sx={{ py: 4 }}>
        {/* Header */}
        <Box sx={{ mb: 4, textAlign: 'center' }}>
          <Typography variant="h4" component="h1" gutterBottom fontWeight={700}>
            短视频智能混剪工具
          </Typography>
          <Typography variant="body1" color="text.secondary">
            基于AI的短视频自动化剪辑平台 — 智能分析、自动匹配、一键导出
          </Typography>
        </Box>

        {/* Stepper */}
        <Paper elevation={1} sx={{ p: 3, mb: 4 }}>
          <Stepper activeStep={activeStep} alternativeLabel nonLinear>
            {STEPS.map((label: string, index: number) => (
              <Step key={label}>
                <StepButton onClick={() => handleStepClick(index)}>
                  {label}
                </StepButton>
              </Step>
            ))}
          </Stepper>
        </Paper>

        {/* Main content area */}
        <Paper
          elevation={1}
          sx={{
            p: 2,
            mb: 4,
            minHeight: 400,
          }}
        >
          {/* All steps are always mounted to preserve state across navigation */}
          <Box sx={{ display: activeStep === 0 ? 'block' : 'none' }}>
            <MaterialsManager />
          </Box>
          <Box sx={{ display: activeStep === 1 ? 'block' : 'none' }}>
            <AiScriptEditor />
          </Box>
          <Box sx={{ display: activeStep === 2 ? 'block' : 'none' }}>
            <TimelineEditor />
          </Box>
          <Box sx={{ display: activeStep === 3 ? 'block' : 'none' }}>
            <ExportConfirm />
          </Box>
        </Paper>

        {/* Navigation buttons */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button
            variant="outlined"
            onClick={handleBack}
            disabled={activeStep === 0}
          >
            上一步
          </Button>
          <Button
            variant="contained"
            onClick={handleNext}
            disabled={activeStep === STEPS.length - 1 || isBusy}
          >
            下一步
          </Button>
        </Box>

        {/* Validation messages */}
        <Snackbar
          open={snackbarOpen}
          autoHideDuration={4000}
          onClose={() => setSnackbarOpen(false)}
          anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        >
          <Alert
            onClose={() => setSnackbarOpen(false)}
            severity="warning"
            variant="filled"
            sx={{ width: '100%' }}
          >
            {snackbarMessage}
          </Alert>
        </Snackbar>
      </Container>
    </ThemeProvider>
  );
};

export default App;
