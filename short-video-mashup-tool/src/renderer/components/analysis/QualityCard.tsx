/**
 * QualityCard — Radial progress quality score card with dimension bars.
 *
 * Displays overall quality score as a radial CircularProgress and
 * per-dimension bar charts with color coding (green/yellow/red).
 */
import React from 'react';
import {
  Box,
  Paper,
  Typography,
  CircularProgress,
  LinearProgress,
  Tooltip,
  Divider,
} from '@mui/material';
import type { QualityReport } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface QualityCardProps {
  /** Quality report data, or null if no analysis */
  qualityReport: QualityReport | null;
  /** Material name for display */
  materialName?: string;
  /** Whether analysis is in progress */
  isLoading?: boolean;
}

// ─── Dimension Definition ──────────────────────────────────

interface QualityDimension {
  key: keyof QualityReport;
  label: string;
  /** Max value for normalization to 0-100 */
  maxValue: number;
  /** Description tooltip */
  tooltip: string;
}

const DIMENSIONS: QualityDimension[] = [
  {
    key: 'brightness',
    label: '亮度',
    maxValue: 255,
    tooltip: '画面平均亮度，过低或过高都会影响观感',
  },
  {
    key: 'contrast',
    label: '对比度',
    maxValue: 128,
    tooltip: '像素标准差反映画面对比度，越高画面层次越丰富',
  },
  {
    key: 'sharpness',
    label: '清晰度',
    maxValue: 500,
    tooltip: 'Laplacian方差衡量画面细节，越高越清晰',
  },
  {
    key: 'stability',
    label: '稳定性',
    maxValue: 100,
    tooltip: '画面稳定程度，由帧间差异计算',
  },
  {
    key: 'audioQuality',
    label: '音频',
    maxValue: 100,
    tooltip: '音频质量评估，静音或噪音会影响分数',
  },
];

// ─── Color Helpers ──────────────────────────────────────────

function scoreColor(score: number): 'success' | 'warning' | 'error' {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'error';
}

function scoreHex(score: number): string {
  if (score >= 70) return '#2e7d32';
  if (score >= 40) return '#ed6c02';
  return '#d32f2f';
}

// ─── Component ──────────────────────────────────────────────

const QualityCard: React.FC<QualityCardProps> = ({
  qualityReport,
  materialName = '',
  isLoading = false,
}) => {
  // Loading state
  if (isLoading) {
    return (
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ p: 3, textAlign: 'center', minHeight: 280 }}
      >
        <CircularProgress size={48} sx={{ mb: 2 }} />
        <Typography variant="body2" color="text.secondary">
          正在评估质量...
        </Typography>
      </Paper>
    );
  }

  // No data state
  if (!qualityReport) {
    return (
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ p: 3, textAlign: 'center', minHeight: 280 }}
      >
        <Typography variant="body1" color="text.secondary" gutterBottom>
          暂无质量评分
        </Typography>
        <Typography variant="body2" color="text.disabled">
          {materialName ? `请先分析"${materialName}"` : '请先分析素材'}
        </Typography>
      </Paper>
    );
  }

  const overall: number = qualityReport.overallScore;
  const colorHex: string = scoreHex(overall);

  return (
    <Paper
      elevation={0}
      variant="outlined"
      sx={{ p: 3, minHeight: 280 }}
    >
      {/* Overall score — radial */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          mb: 2,
        }}
      >
        <Box sx={{ position: 'relative', display: 'inline-flex' }}>
          <CircularProgress
            variant="determinate"
            value={100}
            size={120}
            thickness={6}
            sx={{ color: 'grey.200', position: 'absolute' }}
          />
          <CircularProgress
            variant="determinate"
            value={overall}
            size={120}
            thickness={6}
            sx={{
              color: colorHex,
              '& .MuiCircularProgress-circle': {
                strokeLinecap: 'round',
                transition: 'stroke-dashoffset 0.8s ease',
              },
            }}
          />
          <Box
            sx={{
              top: 0,
              left: 0,
              bottom: 0,
              right: 0,
              position: 'absolute',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography
              variant="h4"
              fontWeight={700}
              sx={{ color: colorHex, lineHeight: 1 }}
            >
              {overall}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              总分
            </Typography>
          </Box>
        </Box>
      </Box>

      <Divider sx={{ mb: 2 }} />

      {/* Dimension bars */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {DIMENSIONS.map((dim: QualityDimension) => {
          const rawValue: number = Number(qualityReport[dim.key]) || 0;
          // Normalize to 0–100 range
          const normalized: number = Math.min(
            100,
            Math.round((rawValue / dim.maxValue) * 100),
          );
          const dimColor: string = scoreHex(normalized);

          return (
            <Box key={dim.key}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  mb: 0.3,
                }}
              >
                <Tooltip title={dim.tooltip} arrow placement="left">
                  <Typography variant="caption" color="text.secondary">
                    {dim.label}
                  </Typography>
                </Tooltip>
                <Typography variant="caption" fontWeight={600} sx={{ color: dimColor }}>
                  {dim.key === 'brightness' || dim.key === 'contrast' || dim.key === 'sharpness'
                    ? rawValue.toFixed(1)
                    : `${Math.round(rawValue)}`}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={normalized}
                sx={{
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: 'grey.100',
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 4,
                    backgroundColor: dimColor,
                    transition: 'transform 0.6s ease',
                  },
                }}
              />
            </Box>
          );
        })}
      </Box>
    </Paper>
  );
};

export default QualityCard;
