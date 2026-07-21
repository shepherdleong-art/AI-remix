/**
 * AnalysisDashboard — Statistical overview dashboard for analysis results.
 *
 * Displays summary stat cards (analyzed/pending counts, average quality, total scenes)
 * and tab-based navigation for detail views.
 */
import React, { useState, useMemo } from 'react';
import { useTheme } from '@mui/material';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  Card,
  CardContent,
  Grid,
  Chip,
} from '@mui/material';
import AnalyticsIcon from '@mui/icons-material/Analytics';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import StarIcon from '@mui/icons-material/Star';
import MovieIcon from '@mui/icons-material/Movie';
import type { AnalysisResult } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface AnalysisDashboardProps {
  /** All current analysis results */
  results: AnalysisResult[];
  /** Currently selected tab */
  activeTab: number;
  /** Tab change handler */
  onTabChange: (tabIndex: number) => void;
  /** Children (tab content panels) */
  children?: React.ReactNode;
}

// ─── Stat Card Component ───────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  color: string;
}

const StatCard: React.FC<StatCardProps> = ({ icon, label, value, color }) => (
  <Card
    variant="outlined"
    sx={{
      flex: 1,
      minWidth: 140,
      borderColor: 'divider',
      '&:hover': { borderColor: color, boxShadow: 1 },
      transition: 'all 0.2s',
    }}
  >
    <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
        <Box sx={{ color }}>{icon}</Box>
        <Typography variant="caption" color="text.secondary" noWrap>
          {label}
        </Typography>
      </Box>
      <Typography variant="h5" fontWeight={700} sx={{ color }}>
        {value}
      </Typography>
    </CardContent>
  </Card>
);

// ─── Tabs ───────────────────────────────────────────────────

const TAB_LABELS: string[] = ['场景检测', '质量评分', '标签', '亮点'];

// ─── Component ──────────────────────────────────────────────

const AnalysisDashboard: React.FC<AnalysisDashboardProps> = ({
  results,
  activeTab,
  onTabChange,
  children,
}) => {
  const theme = useTheme();
  // Compute stats
  const stats = useMemo(() => {
    const completed = results.filter(
      (r: AnalysisResult) => r.status === 'done',
    );
    const pending = results.filter(
      (r: AnalysisResult) =>
        r.status === 'pending' || r.status === 'processing',
    );
    const avgQuality =
      completed.length > 0
        ? Math.round(
            completed.reduce(
              (sum: number, r: AnalysisResult) => sum + r.qualityScore,
              0,
            ) / completed.length,
          )
        : 0;
    const totalScenes = completed.reduce(
      (sum: number, r: AnalysisResult) => sum + r.sceneCount,
      0,
    );

    return { completed, pending, avgQuality, totalScenes };
  }, [results]);

  return (
    <Box>
      {/* Stats cards */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} sm={3}>
          <StatCard
            icon={<AnalyticsIcon />}
            label="已分析"
            value={stats.completed.length}
            color="#2e7d32"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            icon={<HourglassEmptyIcon />}
            label="待分析"
            value={stats.pending.length}
            color="#ed6c02"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            icon={<StarIcon />}
            label="平均质量分"
            value={stats.avgQuality}
            color={theme.palette.primary.main}
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <StatCard
            icon={<MovieIcon />}
            label="总场景数"
            value={stats.totalScenes}
            color="#9c27b0"
          />
        </Grid>
      </Grid>

      {/* Tab navigation */}
      <Paper elevation={0} variant="outlined" sx={{ mb: 2 }}>
        <Tabs
          value={activeTab}
          onChange={(_e: React.SyntheticEvent, newValue: number) =>
            onTabChange(newValue)
          }
          variant="fullWidth"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          {TAB_LABELS.map((label: string, index: number) => (
            <Tab key={label} label={label} id={`analysis-tab-${index}`} />
          ))}
        </Tabs>
      </Paper>

      {/* Tab content panels */}
      <Box role="tabpanel" hidden={activeTab !== 0}>
        {activeTab === 0 && children}
      </Box>
      <Box role="tabpanel" hidden={activeTab !== 1}>
        {activeTab === 1 && children}
      </Box>
      <Box role="tabpanel" hidden={activeTab !== 2}>
        {activeTab === 2 && children}
      </Box>
      <Box role="tabpanel" hidden={activeTab !== 3}>
        {activeTab === 3 && children}
      </Box>
    </Box>
  );
};

export default AnalysisDashboard;
