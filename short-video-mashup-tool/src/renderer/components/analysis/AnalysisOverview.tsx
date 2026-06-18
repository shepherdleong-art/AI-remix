/**
 * AnalysisOverview — Main container for the smart analysis step (Step 2 in Stepper).
 *
 * Integrates the AnalysisDashboard with material selection list and analysis controls.
 * Displays individual material analysis progress and results through tabbed detail views.
 */
import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  IconButton,
  Chip,
  LinearProgress,
  Alert,
  AlertTitle,
  Divider,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  type SelectChangeEvent,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import RefreshIcon from '@mui/icons-material/Refresh';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import type { AnyMaterial } from '@/renderer/types/material';
import type { AnalysisResult, AnalysisStatus } from '@/renderer/types/analysis';
import { useAnalysisStore } from '@/renderer/store/analysis-store';
import AnalysisDashboard from './AnalysisDashboard';
import AnalysisProgress from './AnalysisProgress';
import SceneList from './SceneList';
import QualityCard from './QualityCard';
import TagCloud from './TagCloud';
import HighlightsGrid from './HighlightsGrid';

// ─── Props ──────────────────────────────────────────────────

export interface AnalysisOverviewProps {
  /** Available materials to analyze */
  materials: AnyMaterial[];
}

// ─── Status Icons ──────────────────────────────────────────

const STATUS_ICON_MAP: Record<AnalysisStatus, React.ReactElement> = {
  pending: <HourglassEmptyIcon fontSize="small" color="disabled" />,
  processing: <HourglassEmptyIcon fontSize="small" color="primary" />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  error: <ErrorIcon fontSize="small" color="error" />,
};

const STATUS_CHIP_COLOR_MAP: Record<AnalysisStatus, 'default' | 'primary' | 'success' | 'error'> = {
  pending: 'default',
  processing: 'primary',
  done: 'success',
  error: 'error',
};

const STATUS_LABEL_MAP: Record<AnalysisStatus, string> = {
  pending: '待分析',
  processing: '分析中',
  done: '已完成',
  error: '失败',
};

// ─── Component ──────────────────────────────────────────────

const AnalysisOverview: React.FC<AnalysisOverviewProps> = ({ materials }) => {
  // Store
  const analysisResults = useAnalysisStore((s) => s.analysisResults);
  const isBatchRunning = useAnalysisStore((s) => s.isBatchRunning);
  const analyzeAll = useAnalysisStore((s) => s.analyzeAll);
  const analyzeMaterial = useAnalysisStore((s) => s.analyzeMaterial);
  const clearResult = useAnalysisStore((s) => s.clearResult);
  const clearResults = useAnalysisStore((s) => s.clearResults);
  const getByMaterialId = useAnalysisStore((s) => s.getByMaterialId);
  const activeFilterTags = useAnalysisStore((s) => s.activeFilterTags);
  const toggleFilterTag = useAnalysisStore((s) => s.toggleFilterTag);
  const setActiveFilterTags = useAnalysisStore((s) => s.setActiveFilterTags);
  const overallProgress = useAnalysisStore((s) => s.getOverallProgress());

  // Local state
  const [selectedMaterialId, setSelectedMaterialId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<number>(0);

  // Derived
  const resultsArray: AnalysisResult[] = useMemo(
    () => Array.from(analysisResults.values()),
    [analysisResults],
  );

  const selectedResult: AnalysisResult | undefined = useMemo(
    () => (selectedMaterialId ? getByMaterialId(selectedMaterialId) : undefined),
    [selectedMaterialId, getByMaterialId],
  );

  // Materials that have at least one analysis result
  const analyzedMaterialIds = useMemo(
    () => new Set(resultsArray.map((r: AnalysisResult) => r.materialId)),
    [resultsArray],
  );

  // Materials that are ready for analysis (type='video', status='ready')
  const analyzableMaterials = useMemo(
    () =>
      materials.filter(
        (m: AnyMaterial) =>
          m.type === 'video' && (m.status === 'ready' || m.status === 'processing'),
      ),
    [materials],
  );

  // Auto-select first material if none selected
  React.useEffect(() => {
    if (!selectedMaterialId && analyzableMaterials.length > 0) {
      setSelectedMaterialId(analyzableMaterials[0].id);
    }
  }, [analyzableMaterials, selectedMaterialId]);

  // ─── Handlers ──────────────────────────────────────────

  const handleAnalyzeAll = useCallback((): void => {
    const items = analyzableMaterials.map((m: AnyMaterial) => ({
      materialId: m.id,
      filePath: m.filePath,
    }));
    analyzeAll(items);
  }, [analyzableMaterials, analyzeAll]);

  const handleAnalyzeSingle = useCallback(
    (materialId: string, filePath: string): void => {
      analyzeMaterial(materialId, filePath);
    },
    [analyzeMaterial],
  );

  const handleSelectMaterial = useCallback(
    (event: SelectChangeEvent<string>): void => {
      setSelectedMaterialId(event.target.value);
    },
    [],
  );

  const handleClearResults = useCallback((): void => {
    clearResults();
    setSelectedMaterialId('');
  }, [clearResults]);

  const handleTabChange = useCallback((tabIndex: number): void => {
    setActiveTab(tabIndex);
  }, []);

  const handleSceneClick = useCallback((_scene: unknown): void => {
    // Future: seek video player to scene time
  }, []);

  const handleHighlightClick = useCallback((_highlight: unknown): void => {
    // Future: seek video player to highlight time
  }, []);

  // ─── Empty State ───────────────────────────────────────

  if (analyzableMaterials.length === 0) {
    return (
      <Box sx={{ py: 6, textAlign: 'center' }}>
        <SmartToyIcon sx={{ fontSize: 64, color: 'grey.300', mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          暂无待分析素材
        </Typography>
        <Typography variant="body2" color="text.secondary">
          请在步骤1中导入视频素材后再进行分析
        </Typography>
      </Box>
    );
  }

  // ─── Render ────────────────────────────────────────────

  return (
    <Box>
      {/* Batch progress */}
      {isBatchRunning && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>批量分析进行中</AlertTitle>
          整体进度: {overallProgress}%
          <LinearProgress
            variant="determinate"
            value={overallProgress}
            sx={{ mt: 1 }}
          />
        </Alert>
      )}

      {/* Toolbar */}
      <Paper
        elevation={0}
        variant="outlined"
        sx={{ p: 2, mb: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
      >
        <FormControl size="small" sx={{ minWidth: 220 }}>
          <InputLabel id="material-select-label">选择素材</InputLabel>
          <Select
            labelId="material-select-label"
            value={selectedMaterialId}
            label="选择素材"
            onChange={handleSelectMaterial}
          >
            {analyzableMaterials.map((m: AnyMaterial) => {
              const result = getByMaterialId(m.id);
              return (
                <MenuItem key={m.id} value={m.id}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
                    <Typography variant="body2" noWrap sx={{ flexGrow: 1 }}>
                      {m.fileName}
                    </Typography>
                    {result && (
                      <Chip
                        label={STATUS_LABEL_MAP[result.status]}
                        size="small"
                        color={STATUS_CHIP_COLOR_MAP[result.status]}
                      />
                    )}
                  </Box>
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>

        <Button
          variant="contained"
          startIcon={<PlayArrowIcon />}
          onClick={handleAnalyzeAll}
          disabled={isBatchRunning}
          size="small"
        >
          全部分析
        </Button>

        {selectedMaterialId && (
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={() => {
              const mat = analyzableMaterials.find(
                (m: AnyMaterial) => m.id === selectedMaterialId,
              );
              if (mat) handleAnalyzeSingle(mat.id, mat.filePath);
            }}
            disabled={isBatchRunning}
            size="small"
          >
            分析当前
          </Button>
        )}

        <Box sx={{ flexGrow: 1 }} />

        {resultsArray.length > 0 && (
          <Button
            variant="text"
            color="error"
            startIcon={<DeleteIcon />}
            onClick={handleClearResults}
            size="small"
          >
            清除结果
          </Button>
        )}
      </Paper>

      {/* Progress for current material */}
      {selectedResult && selectedResult.status !== 'done' && (
        <AnalysisProgress
          subSteps={selectedResult.subSteps}
          overallProgress={selectedResult.progress}
          isRunning={selectedResult.status === 'processing'}
        />
      )}

      {/* Dashboard + Detail Views */}
      {selectedResult && selectedResult.status === 'done' && (
        <AnalysisDashboard
          results={resultsArray}
          activeTab={activeTab}
          onTabChange={handleTabChange}
        >
          {/* Tab 0: Scene detection */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              场景检测 ({selectedResult.scenes.length} 个场景)
            </Typography>
            <SceneList
              scenes={selectedResult.scenes}
              onSceneClick={handleSceneClick}
              isEmpty={!selectedResult}
            />
          </Box>

          {/* Tab 1: Quality score */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              质量评分
            </Typography>
            <QualityCard
              qualityReport={selectedResult.qualityReport}
              materialName={
                analyzableMaterials.find(
                  (m: AnyMaterial) => m.id === selectedResult.materialId,
                )?.fileName
              }
            />
          </Box>

          {/* Tab 2: Tags */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              智能标签 ({selectedResult.tags.length} 个标签)
            </Typography>
            <TagCloud
              tags={selectedResult.tags}
              activeFilterTags={activeFilterTags}
              onTagClick={toggleFilterTag}
              isEmpty={!selectedResult}
            />
          </Box>

          {/* Tab 3: Highlights */}
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              亮点片段 ({selectedResult.highlights.length} 个)
            </Typography>
            <HighlightsGrid
              highlights={selectedResult.highlights}
              onHighlightClick={handleHighlightClick}
              isEmpty={!selectedResult}
            />
          </Box>
        </AnalysisDashboard>
      )}

      {/* No result selected yet */}
      {!selectedResult && (
        <Paper
          elevation={0}
          variant="outlined"
          sx={{ p: 6, textAlign: 'center', minHeight: 300 }}
        >
          <SmartToyIcon sx={{ fontSize: 48, color: 'grey.300', mb: 1 }} />
          <Typography variant="h6" color="text.secondary" gutterBottom>
            选择素材并开始分析
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mb: 3 }}>
            AI 将自动检测场景、评估质量、生成标签和识别亮点片段
          </Typography>
          <Button
            variant="contained"
            startIcon={<PlayArrowIcon />}
            onClick={handleAnalyzeAll}
            disabled={isBatchRunning}
          >
            全部分析
          </Button>
        </Paper>
      )}

      {/* Material quick list */}
      {resultsArray.length > 0 && (
        <Paper elevation={0} variant="outlined" sx={{ mt: 3, p: 2 }}>
          <Typography variant="subtitle2" fontWeight={600} gutterBottom>
            分析结果列表
          </Typography>
          <List dense disablePadding>
            {resultsArray.map((result: AnalysisResult) => {
              const material = materials.find(
                (m: AnyMaterial) => m.id === result.materialId,
              );
              const isSelected = result.materialId === selectedMaterialId;
              return (
                <ListItem
                  key={result.materialId}
                  secondaryAction={
                    <IconButton
                      edge="end"
                      size="small"
                      onClick={() => clearResult(result.materialId)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  }
                  onClick={() => setSelectedMaterialId(result.materialId)}
                  sx={{
                    cursor: 'pointer',
                    borderRadius: 1,
                    mb: 0.5,
                    bgcolor: isSelected ? 'action.selected' : 'transparent',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    {STATUS_ICON_MAP[result.status]}
                  </ListItemIcon>
                  <ListItemText
                    primary={material?.fileName || result.materialId}
                    primaryTypographyProps={{
                      variant: 'body2',
                      noWrap: true,
                      fontWeight: isSelected ? 600 : 400,
                    }}
                    secondary={
                      result.status === 'done'
                        ? `质量: ${result.qualityScore} · 场景: ${result.sceneCount}`
                        : STATUS_LABEL_MAP[result.status]
                    }
                    secondaryTypographyProps={{ variant: 'caption' }}
                  />
                  <Chip
                    label={STATUS_LABEL_MAP[result.status]}
                    size="small"
                    color={STATUS_CHIP_COLOR_MAP[result.status]}
                    sx={{ mr: 5, minWidth: 56 }}
                  />
                </ListItem>
              );
            })}
          </List>
        </Paper>
      )}
    </Box>
  );
};

export default AnalysisOverview;
