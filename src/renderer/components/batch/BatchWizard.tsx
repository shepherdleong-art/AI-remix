/**
 * 批量模式 · 阶段容器（BatchWizard）。
 *
 * - 顶栏：返回模式选择 + 批次名 + 更新时间
 * - 阶段导航：上传 → 预修 → 脚本 → 分配审改 → 导出（点击自由往返，数据已持久化）
 * - 已完成格依据后端阶段机（batch.stage）点亮；分配审改/导出由 S6 组件承担
 * - 卸载时停止全部轮询（后端任务继续，重回批次自动恢复）
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import DescriptionIcon from '@mui/icons-material/Description';
import GridViewIcon from '@mui/icons-material/GridView';
import MovieIcon from '@mui/icons-material/Movie';
import type { SvgIconProps } from '@mui/material/SvgIcon';

import { ThemeSwitch } from '@/renderer/components/common/ThemeSwitch';
import { stopAllBatchPolling, useBatchStore } from '@/renderer/store/batch-store';
import BatchExportPanel from './BatchExportPanel';
import BatchUpload from './BatchUpload';
import ClipCardGrid from './ClipCardGrid';
import MaterialPrescan from './MaterialPrescan';
import ScriptBatchEditor from './ScriptBatchEditor';
import { WIZARD_STAGES, fmtTime, wizardIndexOfStage } from './utils';

const STAGE_ICONS: Array<React.ComponentType<SvgIconProps>> = [
  CloudUploadIcon,
  ContentCutIcon,
  DescriptionIcon,
  GridViewIcon,
  MovieIcon,
];

interface BatchWizardProps {
  /** 返回模式选择屏 */
  onExit: () => void;
}

const BatchWizard: React.FC<BatchWizardProps> = ({ onExit }) => {
  const batch = useBatchStore((s) => s.batch);
  const reachedIndex = useMemo(
    () => (batch ? wizardIndexOfStage(batch.stage) : 0),
    [batch],
  );
  const [activeStage, setActiveStage] = useState<number>(reachedIndex);

  /* 批次切换（断点恢复）时对齐到其后端阶段 */
  useEffect(() => {
    setActiveStage(reachedIndex);
  }, [batch?.id, reachedIndex]);

  /* 卸载停止轮询 */
  useEffect(() => () => stopAllBatchPolling(), []);

  if (!batch) {
    return (
      <Box sx={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 2 }}>
        <Typography color="text.secondary">未选择批次</Typography>
        <Button variant="contained" onClick={onExit}>返回模式选择</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default', overflow: 'hidden' }}>
      {/* ── 顶栏 ── */}
      <Box
        sx={{
          height: 56, flexShrink: 0, display: 'flex', alignItems: 'center',
          px: 2, gap: 2, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper',
        }}
      >
        <Tooltip title="返回模式选择">
          <IconButton size="small" onClick={onExit}>
            <ArrowBackIcon />
          </IconButton>
        </Tooltip>
        <Box
          sx={{
            width: 34, height: 34, borderRadius: 2, bgcolor: 'primary.main',
            color: 'primary.contrastText', display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexShrink: 0,
          }}
        >
          <AutoAwesomeIcon fontSize="small" />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
            批量生产
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {batch.name} · 更新于 {fmtTime(batch.updated_at)}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" variant="outlined" label={`素材 ${batch.materials.length}`} />
        <Chip size="small" variant="outlined" label={`脚本 ${batch.scripts.length}`} />
        <Chip size="small" variant="outlined" label={`成片 ${batch.clips.length}`} />
        <ThemeSwitch />
      </Box>

      {/* ── 阶段导航 ── */}
      <Box
        sx={{
          flexShrink: 0, display: 'flex', gap: 1, px: 2, py: 1.5,
          borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper',
        }}
      >
        {WIZARD_STAGES.map((st, i) => {
          const active = activeStage === i;
          const done = !active && i < reachedIndex;
          const Icon = STAGE_ICONS[i];
          return (
            <Box
              key={st.key}
              onClick={() => setActiveStage(i)}
              sx={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 1.25,
                px: 1.5, py: 1, borderRadius: 2, cursor: 'pointer',
                border: '1px solid',
                borderColor: active ? 'primary.main' : 'transparent',
                bgcolor: active ? 'action.selected' : 'transparent',
                transition: 'all .18s',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Box
                sx={{
                  width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '1.5px solid',
                  borderColor: active ? 'primary.main' : 'divider',
                  color: active ? 'primary.contrastText' : 'text.secondary',
                  bgcolor: active ? 'primary.main' : 'transparent',
                }}
              >
                {done ? (
                  <CheckCircleIcon fontSize="small" sx={{ color: 'success.main' }} />
                ) : (
                  <Icon fontSize="small" />
                )}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" fontWeight={active ? 700 : 500} noWrap
                  color={active ? 'primary.main' : 'text.primary'}>
                  {st.label}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap>{st.sub}</Typography>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* ── 阶段内容 ── */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 2 }}>
        {activeStage === 0 && <BatchUpload onNext={() => setActiveStage(1)} />}
        {activeStage === 1 && (
          <MaterialPrescan onNext={() => setActiveStage(2)} onBack={() => setActiveStage(0)} />
        )}
        {activeStage === 2 && (
          <ScriptBatchEditor onAdvance={() => setActiveStage(3)} onBack={() => setActiveStage(1)} />
        )}
        {activeStage === 3 && <ClipCardGrid onAdvance={() => setActiveStage(4)} />}
        {activeStage === 4 && <BatchExportPanel onBack={() => setActiveStage(3)} />}
      </Box>
    </Box>
  );
};

export default BatchWizard;
