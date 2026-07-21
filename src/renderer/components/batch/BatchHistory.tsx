/**
 * 批量模式 · 批次历史（BatchHistory）。
 *
 * - 列出全部批量项目（类型标识「批量」Chip），updated_at 倒序
 * - 勾选删除 → DELETE /api/batch/delete（只删批次目录，不动原始素材）
 * - 点击条目 → 载入批次并进入批量向导（断点续作，恢复到离开时的阶段）
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import HistoryIcon from '@mui/icons-material/History';
import RefreshIcon from '@mui/icons-material/Refresh';

import { useBatchStore } from '@/renderer/store/batch-store';
import { STAGE_LABELS, fmtTime } from './utils';

interface BatchHistoryProps {
  /** 打开批次（进入批量向导） */
  onOpen: (id: string) => void;
}

const BatchHistory: React.FC<BatchHistoryProps> = ({ onOpen }) => {
  const summaries = useBatchStore((s) => s.summaries);
  const listBatches = useBatchStore((s) => s.listBatches);
  const deleteBatches = useBatchStore((s) => s.deleteBatches);

  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      await listBatches();
    } finally {
      setLoading(false);
    }
  }, [listBatches]);

  useEffect(() => { void refresh(); }, [refresh]);

  const toggle = useCallback((id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allChecked = summaries.length > 0 && checked.size === summaries.length;

  const toggleAll = useCallback(() => {
    setChecked((prev) => (prev.size === summaries.length ? new Set() : new Set(summaries.map((s) => s.id))));
  }, [summaries]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteBatches(Array.from(checked));
      setChecked(new Set());
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  }, [checked, deleteBatches]);

  return (
    <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <HistoryIcon fontSize="small" color="action" />
        <Typography variant="subtitle2">批量项目历史</Typography>
        {checked.size > 0 && (
          <Chip size="small" label={`已选 ${checked.size} 项`} onDelete={() => setChecked(new Set())} />
        )}
        <Box sx={{ flex: 1 }} />
        {checked.size > 0 && (
          <Button
            size="small" color="error" variant="outlined"
            startIcon={<DeleteSweepIcon />}
            onClick={() => setConfirmOpen(true)}
          >
            删除选中（{checked.size}）
          </Button>
        )}
        <Tooltip title="刷新">
          <IconButton size="small" onClick={() => { void refresh(); }} disabled={loading}>
            {loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>

      {summaries.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          {loading ? '加载中…' : '暂无批量项目，点击上方「批量生产」创建第一个批次'}
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 0.5, mb: 0.5 }}>
            <Checkbox size="small" checked={allChecked} indeterminate={checked.size > 0 && !allChecked} onChange={toggleAll} />
            <Typography variant="caption" color="text.secondary">全选</Typography>
          </Box>
          {summaries.map((b) => (
            <Paper
              key={b.id}
              elevation={0}
              sx={{
                p: 1, mb: 0.5, display: 'flex', alignItems: 'center', gap: 1,
                cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' },
              }}
              onClick={() => onOpen(b.id)}
            >
              <Checkbox
                size="small"
                checked={checked.has(b.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggle(b.id)}
              />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{b.name}</Typography>
                  <Chip label="批量" size="small" color="primary" variant="outlined" />
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="caption" color="text.secondary">{fmtTime(b.updated_at)}</Typography>
                  <Chip label={STAGE_LABELS[b.stage] ?? b.stage} size="small" variant="outlined" />
                  <Chip label={`素材 ${b.materials_count}`} size="small" variant="outlined" />
                  {b.clips_total > 0 && (
                    <Chip label={`成片 ${b.clips_done}/${b.clips_total}`} size="small" variant="outlined"
                      color={b.clips_done === b.clips_total ? 'success' : 'default'} />
                  )}
                </Box>
              </Box>
            </Paper>
          ))}
        </>
      )}

      <Dialog open={confirmOpen} onClose={() => !deleting && setConfirmOpen(false)}>
        <DialogTitle>删除 {checked.size} 个批量项目？</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            只删除批次记录与中间产物，原始素材文件不受影响。此操作不可撤销。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)} disabled={deleting}>取消</Button>
          <Button color="error" variant="contained" onClick={() => { void handleDelete(); }} disabled={deleting}>
            {deleting ? '删除中…' : '确认删除'}
          </Button>
        </DialogActions>
      </Dialog>
    </Paper>
  );
};

export default BatchHistory;
