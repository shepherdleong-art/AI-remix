/**
 * 入口模式选择屏（D9 双模式）。
 *
 * - 【单条精细】→ 现有四步流程（一行不动）
 * - 【批量生产】→ 新建批次（命名对话框）进入批量向导
 * - 下方为批量项目历史（类型标识「批量」，勾选删除，点入断点续作）
 */
import React, { useCallback, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import MovieIcon from '@mui/icons-material/Movie';

import { ThemeSwitch } from '@/renderer/components/common/ThemeSwitch';
import { useBatchStore } from '@/renderer/store/batch-store';
import BatchHistory from './BatchHistory';

/** 默认批次名：批量批次 MMDD-HHmm */
function defaultBatchName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `批量批次 ${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

interface ModeSelectorProps {
  onSelectMode: (mode: 'single' | 'batch') => void;
}

const ModeSelector: React.FC<ModeSelectorProps> = ({ onSelectMode }) => {
  const createBatch = useBatchStore((s) => s.createBatch);
  const loadBatch = useBatchStore((s) => s.loadBatch);
  const error = useBatchStore((s) => s.error);

  const [nameOpen, setNameOpen] = useState(false);
  const [batchName, setBatchName] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const b = await createBatch(batchName.trim() || defaultBatchName());
      if (b) {
        setNameOpen(false);
        setBatchName('');
        onSelectMode('batch');
      }
    } finally {
      setCreating(false);
    }
  }, [batchName, createBatch, onSelectMode]);

  const handleOpenBatch = useCallback(async (id: string) => {
    const b = await loadBatch(id);
    if (b) onSelectMode('batch');
  }, [loadBatch, onSelectMode]);

  return (
    <Box
      sx={{
        height: '100vh', overflow: 'auto', bgcolor: 'background.default',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        px: 3, py: 4,
      }}
    >
      {/* 顶栏 */}
      <Box sx={{ width: '100%', maxWidth: 880, display: 'flex', alignItems: 'center', gap: 1.25, mb: 4 }}>
        <Box
          sx={{
            width: 34, height: 34, borderRadius: 2, bgcolor: 'primary.main',
            color: 'primary.contrastText', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: 800, fontSize: 18,
          }}
        >
          剪
        </Box>
        <Box sx={{ flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
            短视频智能混剪
          </Typography>
          <Typography variant="caption" color="text.secondary">选择本次的工作模式</Typography>
        </Box>
        <ThemeSwitch />
      </Box>

      {/* 双模式卡片 */}
      <Box sx={{ width: '100%', maxWidth: 880, display: 'flex', gap: 2.5, mb: 3 }}>
        <Paper
          elevation={0}
          onClick={() => onSelectMode('single')}
          sx={{
            flex: 1, p: 3.5, cursor: 'pointer', bgcolor: 'background.paperAlt',
            border: '1.5px solid', borderColor: 'divider',
            transition: 'all .18s',
            '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
          }}
        >
          <MovieIcon sx={{ fontSize: 40, color: 'primary.main', mb: 1.5 }} />
          <Typography variant="h6" gutterBottom>单条精细</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            导入素材 → AI 智能创作 → 预览调整 → 导出渲染。
            逐条打磨，适合精品内容。
          </Typography>
          <Typography variant="caption" color="text.secondary">
            现有四步流程 · 逐段微调 · 封面精修
          </Typography>
        </Paper>

        <Paper
          elevation={0}
          onClick={() => { setBatchName(defaultBatchName()); setNameOpen(true); }}
          sx={{
            flex: 1, p: 3.5, cursor: 'pointer', bgcolor: 'background.paperAlt',
            border: '1.5px solid', borderColor: 'divider',
            transition: 'all .18s',
            '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 40, color: 'primary.main', mb: 1.5 }} />
          <Typography variant="h6" gutterBottom>批量生产</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            一次上传 8-80 条素材，批量录入脚本，
            智能分配 + 差异化对抗查重，一次产出多条成片。
          </Typography>
          <Typography variant="caption" color="text.secondary">
            电商矩阵铺量 · 素材预修 · BGM/封面自动差异化
          </Typography>
        </Paper>
      </Box>

      {error && (
        <Typography variant="body2" color="error.main" sx={{ mb: 1 }}>{error}</Typography>
      )}

      {/* 批量历史 */}
      <Box sx={{ width: '100%', maxWidth: 880 }}>
        <BatchHistory onOpen={(id) => { void handleOpenBatch(id); }} />
      </Box>

      {/* 新建批次命名对话框 */}
      <Dialog open={nameOpen} onClose={() => !creating && setNameOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>新建批量批次</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth label="批次名称"
            value={batchName}
            onChange={(e) => setBatchName(e.target.value)}
            placeholder="例如：618 主推款铺量"
            sx={{ mt: 1 }}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreate(); }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNameOpen(false)} disabled={creating}>取消</Button>
          <Button variant="contained" onClick={() => { void handleCreate(); }} disabled={creating}>
            {creating ? '创建中…' : '创建并进入'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ModeSelector;
