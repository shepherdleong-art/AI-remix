import React from 'react';
import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  Chip,
  Divider,
  LinearProgress,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import VideoFileIcon from '@mui/icons-material/VideoFile';
import ImageIcon from '@mui/icons-material/Image';
import { Panel } from './Panel';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import { useAnalysisStore } from '@/renderer/store/analysis-store';
import { useEditingStore } from '@/renderer/store/editing-store';
import type { AnyMaterial } from '@/renderer/types/material';
import MaterialReplaceList from '@/renderer/components/timeline/MaterialReplaceList';

/* ── Step 1: 素材库概览 ─────────────────────────────── */
const StepImportLeft: React.FC = () => {
  const materials = useMaterialsStore((s) => s.materials);
  return (
    <Panel title="素材库" emptyHint={materials.length === 0 ? '尚未导入任何素材' : undefined}>
      <Typography variant="caption" color="text.secondary">
        共 {materials.length} 个素材
      </Typography>
      <List dense sx={{ pt: 0.5 }}>
        {materials.slice(0, 50).map((m: AnyMaterial) => (
          <ListItem key={m.id} sx={{ px: 0.5, py: 0.25 }}>
            <ListItemIcon sx={{ minWidth: 32 }}>
              {m.type === 'video' ? (
                <VideoFileIcon fontSize="small" color="primary" />
              ) : (
                <ImageIcon fontSize="small" color="secondary" />
              )}
            </ListItemIcon>
            <ListItemText
              primary={m.fileName}
              secondary={m.resolution !== '--×--' ? `${m.resolution} · ${m.duration}` : m.duration}
              primaryTypographyProps={{ noWrap: true, title: m.fileName }}
              secondaryTypographyProps={{ variant: 'caption' }}
            />
          </ListItem>
        ))}
      </List>
    </Panel>
  );
};

/* ── Step 2: 分析概览 ───────────────────────────────── */
const StepAnalysisLeft: React.FC = () => {
  const completed = useAnalysisStore((s) => s.getCompletedCount());
  const scenes = useAnalysisStore((s) => s.getTotalSceneCount());
  const score = useAnalysisStore((s) => s.getAverageQualityScore());
  const progress = useAnalysisStore((s) => s.getOverallProgress());

  const Stat: React.FC<{ label: string; value: string | number }> = ({ label, value }) => (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        p: 1.25,
        borderRadius: 2,
        bgcolor: 'background.paperAlt',
        border: '1px solid',
        borderColor: 'divider',
      }}
    >
      <Typography variant="h6" fontWeight={700} lineHeight={1}>
        {value}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
        {label}
      </Typography>
    </Box>
  );

  return (
    <Panel title="分析概览">
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 1.5 }}>
        <Stat label="已完成分析" value={completed} />
        <Stat label="场景总数" value={scenes} />
        <Stat label="平均质量分" value={Math.round(score)} />
        <Stat label="总进度" value={`${Math.round(progress)}%`} />
      </Box>
      <LinearProgress variant="determinate" value={progress} sx={{ borderRadius: 1, mb: 1 }} />
      <Typography variant="caption" color="text.secondary">
        质量分基于画面构图、信息密度与匹配度综合评估。
      </Typography>
    </Panel>
  );
};

/* ── Step 3: 素材替换列表 ── */
const StepPreviewLeft: React.FC = () => {
  const timelineLen = useEditingStore((s) => s.timeline.length);
  return (
    <Panel
      title="素材替换"
      emptyHint={timelineLen === 0 ? '请先在「分析」步骤生成时间线' : undefined}
    >
      <MaterialReplaceList />
    </Panel>
  );
};

/* ── Step 4: 导出校验清单 ───────────────────────────── */
const StepExportLeft: React.FC = () => {
  const materialsCount = useMaterialsStore((s) => s.materials.length);
  const timelineLen = useEditingStore((s) => s.timeline.length);
  const script = useEditingStore((s) => s.script);
  const coverVideoPath = useEditingStore((s) => s.coverVideoPath);
  const outputPath = useEditingStore((s) => s.outputPath);

  const checks: Array<{ label: string; ok: boolean }> = [
    { label: '已导入素材', ok: materialsCount > 0 },
    { label: '已生成时间线', ok: timelineLen > 0 },
    { label: '已生成脚本', ok: script.trim().length > 0 },
    { label: '已设置封面', ok: coverVideoPath.trim().length > 0 },
    { label: '已指定输出路径', ok: outputPath !== null },
  ];
  const allOk = checks.every((c) => c.ok);

  return (
    <Panel title="导出校验">
      <List dense sx={{ pt: 0 }}>
        {checks.map((c) => (
          <ListItem key={c.label} sx={{ px: 0.5, py: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 32 }}>
              {c.ok ? (
                <CheckCircleIcon fontSize="small" sx={{ color: 'success.main' }} />
              ) : (
                <RadioButtonUncheckedIcon fontSize="small" color="disabled" />
              )}
            </ListItemIcon>
            <ListItemText
              primary={c.label}
              primaryTypographyProps={{
                variant: 'body2',
                color: c.ok ? 'text.primary' : 'text.secondary',
              }}
            />
          </ListItem>
        ))}
      </List>
      <Divider sx={{ my: 1 }} />
      <Chip
        label={allOk ? '可以导出' : '尚不满足条件'}
        color={allOk ? 'success' : 'default'}
        size="small"
        variant={allOk ? 'filled' : 'outlined'}
      />
    </Panel>
  );
};

const StepLeftPanel: React.FC<{ step: number }> = ({ step }) => {
  switch (step) {
    case 0:
      return <StepImportLeft />;
    case 1:
      return <StepAnalysisLeft />;
    case 2:
      return <StepPreviewLeft />;
    case 3:
      return <StepExportLeft />;
    default:
      return null;
  }
};

export default StepLeftPanel;
