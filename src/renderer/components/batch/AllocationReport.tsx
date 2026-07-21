/**
 * 批量阶段三 · 分配报告摘要（AllocationReport，可展开折叠）。
 *
 * - 素材使用分布迷你条形图（usage_distribution，哈希 → 次数，映射文件名）
 * - 重复明细（D2 降级证据：哪些成片用了重复素材）
 * - BGM 分配表（D13 轮替结果 + 撞曲标记）
 * - 相似度超阈值片对（Jaccard）
 */
import React, { useMemo, useState } from 'react';
import {
  Box,
  Chip,
  Collapse,
  IconButton,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import AssessmentIcon from '@mui/icons-material/Assessment';

import { useBatchStore } from '@/renderer/store/batch-store';
import { fmtSec } from './utils';

const AllocationReport: React.FC = () => {
  const batch = useBatchStore((s) => s.batch);
  const [open, setOpen] = useState(false);

  const report = batch?.allocation_report;
  const materials = batch?.materials ?? [];
  const clips = batch?.clips ?? [];

  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const mat of materials) m.set(mat.file_hash, mat.filename);
    return (hash: string) => m.get(hash) ?? hash.slice(0, 8);
  }, [materials]);

  const usage = useMemo(() => {
    const dist = report?.usage_distribution ?? {};
    const rows = Object.entries(dist).map(([hash, count]) => ({ hash, count }));
    rows.sort((a, b) => b.count - a.count);
    const max = rows.reduce((a, r) => Math.max(a, r.count), 1);
    return { rows, max };
  }, [report]);

  if (!report) {
    return (
      <Paper elevation={0} sx={{ p: 2, bgcolor: 'background.paperAlt' }}>
        <Typography variant="body2" color="text.secondary">
          尚未运行分配。回到「脚本录入」点「开始分配」生成成片。
        </Typography>
      </Paper>
    );
  }

  const repeats = (report.repeats ?? []) as Array<Record<string, unknown>>;
  const jaccardPairs = report.jaccard_pairs_over_threshold ?? [];
  const bgmAssignments = report.bgm_assignments ?? [];

  return (
    <Paper elevation={0} sx={{ bgcolor: 'background.paperAlt', overflow: 'hidden' }}>
      {/* 摘要头（点击展开/收起） */}
      <Box
        onClick={() => setOpen((v) => !v)}
        sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } }}
      >
        <AssessmentIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2">分配报告</Typography>
        <Chip size="small" variant="outlined" label={`素材使用 ${report.materials_used}/${report.materials_total}`} />
        <Chip size="small" variant="outlined" label={`使用方差 ${(report.usage_variance ?? 0).toFixed(2)}`} />
        <Chip size="small" variant="outlined" color={repeats.length > 0 ? 'warning' : 'success'}
          label={`重复 ${repeats.length} 条`} />
        <Chip size="small" variant="outlined" color={jaccardPairs.length > 0 ? 'warning' : 'success'}
          label={`相似预警 ${jaccardPairs.length} 对`} />
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" sx={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }}>
          <ExpandMoreIcon />
        </IconButton>
      </Box>

      <Collapse in={open}>
        <Box sx={{ px: 2, pb: 2, display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {/* 素材使用分布 */}
          <Box sx={{ minWidth: 260, flex: 1 }}>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
              素材使用分布（每素材被用次数）
            </Typography>
            <Box sx={{ maxHeight: 220, overflow: 'auto', pr: 0.5 }}>
              {usage.rows.map((r) => (
                <Box key={r.hash} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Typography variant="caption" noWrap title={nameOf(r.hash)}
                    sx={{ width: 110, flexShrink: 0, color: 'text.secondary' }}>
                    {nameOf(r.hash)}
                  </Typography>
                  <Box sx={{ flex: 1, height: 10, borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden' }}>
                    <Box
                      sx={{
                        width: `${Math.round((r.count / usage.max) * 100)}%`,
                        height: '100%',
                        bgcolor: r.count > 1 ? 'warning.main' : 'primary.main',
                        borderRadius: 1,
                      }}
                    />
                  </Box>
                  <Typography variant="caption" sx={{ width: 20, textAlign: 'right' }}>{r.count}</Typography>
                </Box>
              ))}
            </Box>
          </Box>

          {/* 重复明细 */}
          <Box sx={{ minWidth: 240, flex: 1 }}>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
              重复明细（素材不足降级，D2）
            </Typography>
            {repeats.length === 0 ? (
              <Typography variant="caption" color="success.main">无重复，全部素材单次使用</Typography>
            ) : (
              <Box sx={{ maxHeight: 220, overflow: 'auto', pr: 0.5 }}>
                {repeats.map((r) => (
                  <Box key={String(r.file_hash)} sx={{ mb: 0.75 }}>
                    <Typography variant="caption" fontWeight={600} display="block">
                      {String(r.filename || r.file_hash)} × {String(r.count)} 次
                    </Typography>
                    {Array.isArray(r.detail) && r.detail.map((d, j) => {
                      const dd = d as Record<string, unknown>;
                      return (
                        <Typography key={j} variant="caption" display="block" color="text.secondary">
                          └ {String(dd.clip_id)} 段{Number(dd.segment_index ?? 0) + 1}（{fmtSec(Number(dd.in ?? 0))}–{fmtSec(Number(dd.out ?? 0))}）
                        </Typography>
                      );
                    })}
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          {/* BGM 分配表 */}
          <Box sx={{ minWidth: 220, flex: 1 }}>
            <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
              BGM 轮替分配（D13）
            </Typography>
            {bgmAssignments.length === 0 ? (
              <Typography variant="caption" color="text.secondary">未分配</Typography>
            ) : (
              <Box sx={{ maxHeight: 220, overflow: 'auto', pr: 0.5 }}>
                {bgmAssignments.map((a) => (
                  <Box key={a.clip_id} sx={{ display: 'flex', gap: 1, mb: 0.25 }}>
                    <Typography variant="caption" sx={{ width: 36, flexShrink: 0 }}>{a.clip_id}</Typography>
                    <Typography variant="caption" color={a.reused ? 'warning.main' : 'text.secondary'} noWrap>
                      {a.bgm_name}{a.reused ? '（撞曲）' : ''}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </Box>

          {/* 相似度片对 */}
          {jaccardPairs.length > 0 && (
            <Box sx={{ minWidth: 220, flex: 1 }}>
              <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
                相似度超阈值片对（Jaccard ≥ {(report.jaccard_threshold ?? 0.5).toFixed(2)}）
              </Typography>
              {jaccardPairs.map((p, i) => (
                <Tooltip key={i} title="两片素材集合重合度，卡片上有黄色预警标">
                  <Typography variant="caption" display="block" color="warning.main">
                    {p.clip_a} ↔ {p.clip_b}：{(p.similarity * 100).toFixed(0)}%
                  </Typography>
                </Tooltip>
              ))}
            </Box>
          )}
        </Box>
      </Collapse>
    </Paper>
  );
};

export default AllocationReport;
