/**
 * AnalysisProgress — Step-based progress stepper for analysis pipeline.
 *
 * Shows the four analysis sub-steps (场景检测→质量分析→标签生成→亮点识别)
 * with their individual statuses and an overall percentage progress bar.
 */
import React from 'react';
import {
  Box,
  Stepper,
  Step,
  StepLabel,
  StepIconProps,
  LinearProgress,
  Typography,
  Chip,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import type { SubStepProgress, SubStepStatus } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface AnalysisProgressProps {
  /** Sub-step progress entries */
  subSteps: SubStepProgress[];
  /** Overall progress percentage (0-100) */
  overallProgress: number;
  /** Whether analysis is currently running */
  isRunning: boolean;
}

// ─── Status Icon Component ─────────────────────────────────

const SUB_STEP_ICON_MAP: Record<SubStepStatus, React.ReactElement> = {
  pending: <HourglassEmptyIcon fontSize="small" color="disabled" />,
  processing: <HourglassEmptyIcon fontSize="small" color="primary" />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  error: <ErrorIcon fontSize="small" color="error" />,
};

function StepIconComponent(props: StepIconProps): React.ReactElement {
  const { active, completed, error } = props;
  if (error) return <ErrorIcon color="error" fontSize="small" />;
  if (completed) return <CheckCircleIcon color="success" fontSize="small" />;
  if (active) return <HourglassEmptyIcon color="primary" fontSize="small" />;
  return <HourglassEmptyIcon color="disabled" fontSize="small" />;
}

// ─── Component ──────────────────────────────────────────────

const AnalysisProgress: React.FC<AnalysisProgressProps> = ({
  subSteps,
  overallProgress,
  isRunning,
}) => {
  // Determine active step
  const activeSubStepIndex: number = subSteps.findIndex(
    (s: SubStepProgress) => s.status === 'processing',
  );

  return (
    <Box sx={{ mb: 3 }}>
      {/* Overall progress bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <LinearProgress
            variant="determinate"
            value={overallProgress}
            sx={{
              height: 10,
              borderRadius: 5,
              backgroundColor: 'action.hover',
              '& .MuiLinearProgress-bar': {
                borderRadius: 5,
                transition: 'transform 0.4s ease',
              },
            }}
          />
        </Box>
        <Typography
          variant="body2"
          fontWeight={600}
          color={overallProgress === 100 ? 'success.main' : 'text.secondary'}
          sx={{ minWidth: 48, textAlign: 'right' }}
        >
          {overallProgress}%
        </Typography>
      </Box>

      {/* Status chips */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        {subSteps.map((s: SubStepProgress) => (
          <Chip
            key={s.step}
            icon={SUB_STEP_ICON_MAP[s.status]}
            label={s.label}
            size="small"
            variant={s.status === 'processing' ? 'filled' : 'outlined'}
            color={
              s.status === 'done'
                ? 'success'
                : s.status === 'error'
                  ? 'error'
                  : s.status === 'processing'
                    ? 'primary'
                    : 'default'
            }
            sx={{ fontWeight: s.status === 'processing' ? 600 : 400 }}
          />
        ))}
      </Box>

      {/* Stepper */}
      <Stepper
        activeStep={activeSubStepIndex >= 0 ? activeSubStepIndex : -1}
        alternativeLabel
        sx={{ '& .MuiStepLabel-label': { fontSize: '0.8rem' } }}
      >
        {subSteps.map((s: SubStepProgress) => (
          <Step
            key={s.step}
            completed={s.status === 'done'}
            active={s.status === 'processing'}
          >
            <StepLabel
              StepIconComponent={StepIconComponent}
              error={s.status === 'error'}
            >
              <Typography
                variant="caption"
                sx={{
                  color:
                    s.status === 'done'
                      ? 'success.main'
                      : s.status === 'error'
                        ? 'error.main'
                        : s.status === 'processing'
                          ? 'primary.main'
                          : 'text.disabled',
                }}
              >
                {s.label}
              </Typography>
            </StepLabel>
          </Step>
        ))}
      </Stepper>
    </Box>
  );
};

export default AnalysisProgress;
