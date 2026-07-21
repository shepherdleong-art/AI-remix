/**
 * 批量阶段三 · 卡片队列审改（ClipCardGrid，D5/D6）。
 *
 * - 顶部：分配报告（可展开）+ 状态筛选 chips + 确认全部 / 导出已确认
 * - 卡片网格：悬停预览、状态着色、相似度预警（点击查看撞车明细）、
 *   待重新分配「重跑分配」（O3）、已确认/已导出锁定（点击先解锁）
 * - 点卡片 → 右侧抽屉浓缩编辑器（ClipDrawerEditor）
 */
import React, { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Typography,
} from '@mui/material';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';

import { useBatchStore } from '@/renderer/store/batch-store';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import type { BatchClip } from '@/renderer/types/batch';
import AllocationReport from './AllocationReport';
import ClipCard, { isClipLocked } from './ClipCard';
import ClipDrawerEditor from './ClipDrawerEditor';
import { fmtSec } from './utils';

type FilterKey = 'all' | '待确认' | '待重新分配' | '已确认' | '已完成';

const FILTERS: FilterKey[] = ['all', '待确认', '待重新分配', '已确认', '已完成'];

interface ClipCardGridProps {
  /** 去阶段五（导出面板） */
  onAdvance: () => void;
}

const ClipCardGrid: React.FC<ClipCardGridProps> = ({ onAdvance }) => {
  const bu = useBackendUrl();
  const batch = useBatchStore((s) => s.batch);
  const confirmAll = useBatchStore((s) => s.confirmAll);
  const unlockClip = useBatchStore((s) => s.unlockClip);
  const reallocateClip = useBatchStore((s) => s.reallocateClip);
  const exportSelected = useBatchStore((s) => s.exportSelected);
  const refreshBatch = useBatchStore((s) => s.refreshBatch);
  const storeError = useBatchStore((s) => s.error);
  const setError = useBatchStore((s) => s.setError);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [editClipId, setEditClipId] = useState<string | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<BatchClip | null>(null);
  const [simTarget, setSimTarget] = useState<BatchClip | null>(null);
  const [reallocatingId, setReallocatingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);

  const clips = useMemo(() => batch?.clips ?? [], [batch]);
  const scripts = useMemo(() => batch?.scripts ?? [], [batch]);
  const materials = useMemo(() => batch?.materials ?? [], [batch]);

  const scriptLabel = useCallback((clip: BatchClip): string => {
    const s = scripts.find((x) => x.id === clip.script_id);
    if (!s) return clip.script_id;
    const t = s.text.trim();
    return t.length > 30 ? `${t.slice(0, 30)}…` : t;
  }, [scripts]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: clips.length };
    for (const k of FILTERS.slice(1)) c[k] = clips.filter((x) => x.status === k).length;
    return c;
  }, [clips]);

  const shown = useMemo(
    () => (filter === 'all' ? clips : clips.filter((c) => c.status === filter)),
    [clips, filter],
  );

  const confirmedCount = counts['已确认'] ?? 0;

  /** 点卡片：锁定片先弹解锁确认，否则直接进抽屉 */
  const handleOpen = useCallback((clip: BatchClip) => {
    if (isClipLocked(clip.status)) setUnlockTarget(clip);
    else setEditClipId(clip.id);
  }, []);

  const handleUnlock = useCallback(async () => {
    if (!unlockTarget) return;
    const ok = await unlockClip(unlockTarget.id);
    if (ok) setEditClipId(unlockTarget.id);
    setUnlockTarget(null);
  }, [unlockTarget, unlockClip]);

  const handleReallocate = useCallback(async (clipId: string) => {
    setReallocatingId(clipId);
    try {
      await reallocateClip(clipId);
    } finally {
      setReallocatingId(null);
    }
  }, [reallocateClip]);

  const handleConfirmAll = useCallback(async () => {
    setConfirming(true);
    try {
      await confirmAll();
    } finally {
      setConfirming(false);
    }
  }, [confirmAll]);

  const handleExportConfirmed = useCallback(async () => {
    setExporting(true);
    try {
      const ok = await exportSelected('confirmed');
      if (ok) onAdvance();
    } finally {
      setExporting(false);
    }
  }, [exportSelected, onAdvance]);

  /** 撞车明细：两片素材集合交集（按 file_hash），列出各自在第几段 */
  const similarityDetail = useMemo(() => {
    if (!simTarget) return [];
    const otherIds = new Set((simTarget.similarity_flags ?? []).map((f) => f.other_clip));
    return clips.filter((c) => otherIds.has(c.id)).map((other) => {
      const myHashes = new Set(simTarget.segments.map((s) => s.file_hash));
      const otherHashes = new Set(other.segments.map((s) => s.file_hash));
      const shared = [...myHashes].filter((h) => otherHashes.has(h));
      const nameOf = (h: string) => materials.find((m) => m.file_hash === h)?.filename ?? h.slice(0, 8);
      const segInfo = (clip: BatchClip, h: string) => {
        const idx = clip.segments.findIndex((s) => s.file_hash === h);
        const seg = clip.segments[idx];
        return `段${idx + 1}（${fmtSec(seg?.in ?? 0)}–${fmtSec(seg?.out ?? 0)}）`;
      };
      const sim = (simTarget.similarity_flags ?? []).find((f) => f.other_clip === other.id)?.similarity ?? 0;
      return { other, sim, shared, nameOf, segInfo };
    });
  }, [simTarget, clips, materials]);

  if (!batch) return null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <AllocationReport />

      {/* ── 操作栏 ── */}
      <Paper elevation={0} sx={{ p: 1.5, bgcolor: 'background.paperAlt', display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {FILTERS.map((k) => (
          <Chip
            key={k}
            label={`${k === 'all' ? '全部' : k} ${counts[k] ?? 0}`}
            size="small"
            color={filter === k ? 'primary' : 'default'}
            variant={filter === k ? 'filled' : 'outlined'}
            onClick={() => setFilter(k)}
          />
        ))}
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          variant="outlined"
          startIcon={<DoneAllIcon />}
          disabled={confirming || (counts['待确认'] ?? 0) === 0}
          onClick={() => { void handleConfirmAll(); }}
        >
          {confirming ? '确认中…' : `确认全部（${counts['待确认'] ?? 0}）`}
        </Button>
        <Button
          size="small"
          variant="contained"
          startIcon={<LocalShippingIcon />}
          disabled={exporting || confirmedCount === 0}
          onClick={() => { void handleExportConfirmed(); }}
        >
          {exporting ? '入队中…' : `导出已确认（${confirmedCount}）`}
        </Button>
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => { void refreshBatch(); }}>
          刷新
        </Button>
      </Paper>

      {storeError && <Alert severity="warning" onClose={() => setError(null)}>{storeError}</Alert>}

      {clips.length === 0 ? (
        <Paper elevation={0} sx={{ p: 4, bgcolor: 'background.paperAlt', textAlign: 'center' }}>
          <Typography color="text.secondary">
            还没有成片。回到「脚本录入」点击「开始分配」生成初剪卡片。
          </Typography>
        </Paper>
      ) : shown.length === 0 ? (
        <Typography variant="body2" color="text.secondary">该状态下没有成片。</Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))',
            gap: 1.5,
          }}
        >
          {shown.map((clip) => (
            <ClipCard
              key={clip.id}
              batchId={batch.id}
              clip={clip}
              scriptLabel={scriptLabel(clip)}
              baseUrl={bu}
              onOpen={() => handleOpen(clip)}
              onShowSimilarity={() => setSimTarget(clip)}
              onReallocate={() => { void handleReallocate(clip.id); }}
              reallocating={reallocatingId === clip.id}
            />
          ))}
        </Box>
      )}

      {/* ── 解锁确认 ── */}
      <Dialog open={!!unlockTarget} onClose={() => setUnlockTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>成片已锁定</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            「{unlockTarget?.cover?.title || unlockTarget?.id}」当前状态为 {unlockTarget?.status}。
            编辑前需先解锁（状态回到「待确认」）。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setUnlockTarget(null)}>取消</Button>
          <Button variant="contained" onClick={() => { void handleUnlock(); }}>解锁并编辑</Button>
        </DialogActions>
      </Dialog>

      {/* ── 撞车明细 ── */}
      <Dialog open={!!simTarget} onClose={() => setSimTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberIcon color="warning" />
          相似度预警：{simTarget?.id}
        </DialogTitle>
        <DialogContent dividers>
          {similarityDetail.length === 0 ? (
            <Typography variant="body2" color="text.secondary">没有撞车明细。</Typography>
          ) : (
            similarityDetail.map(({ other, sim, shared, nameOf, segInfo }) => (
              <Box key={other.id} sx={{ mb: 2 }}>
                <Typography variant="body2" fontWeight={600}>
                  与 {other.id}（{other.cover?.title || other.script_id}）重合 {(sim * 100).toFixed(0)}%
                </Typography>
                {shared.length === 0 ? (
                  <Typography variant="caption" color="text.secondary">（集合相似但无共同素材哈希）</Typography>
                ) : (
                  shared.map((h) => (
                    <Typography key={h} variant="caption" display="block" color="text.secondary" sx={{ ml: 1 }}>
                      {nameOf(h)}：本片 {simTarget ? segInfo(simTarget, h) : ''} · 对方 {segInfo(other, h)}
                    </Typography>
                  ))
                )}
              </Box>
            ))
          )}
          <Typography variant="caption" color="text.secondary">
            建议：进入抽屉编辑，替换其中一片的重复素材或调整入点区间。
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSimTarget(null)}>知道了</Button>
        </DialogActions>
      </Dialog>

      {/* ── 抽屉编辑器 ── */}
      <ClipDrawerEditor
        clipId={editClipId}
        open={!!editClipId}
        onClose={() => setEditClipId(null)}
      />
    </Box>
  );
};

export default ClipCardGrid;
