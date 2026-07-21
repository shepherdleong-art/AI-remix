/**
 * MaterialReplaceList — 步骤3 左栏「素材库（点击替换选中片段）」。
 *
 * 剪映式点选替换闭环：
 *  - 单击时间轴片段选中后，在此列表点新素材即替换（replaceSegmentVideo，
 *    保留原入点；新素材不够长时 store 自动钳位，此处对比前后入点给轻提示）
 *  - 已被时间轴使用的素材带「已用」角标
 *  - hover 行时懒挂载小窗静音循环播放素材预览（替换决策闭环）
 *  - 未选中片段时禁用并提示
 */
import React, { useMemo, useState } from 'react';
import { Box, Chip, Snackbar, Typography } from '@mui/material';
import { useEditingStore } from '@/renderer/store/editing-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { AnyMaterial, VideoMaterial } from '@/renderer/types/material';
import { useBackendUrl } from '@/renderer/api/use-backend-url';
import { thumbUrl, videoUrl, baseName } from './mediaUrl';

interface HoverPreview {
  path: string;
  top: number;
  left: number;
}

const PREVIEW_W = 140;
const PREVIEW_H = 200;

const MaterialReplaceList: React.FC = () => {
  const bu = useBackendUrl();
  const materials = useMaterialsStore((s) => s.materials);
  const timeline = useEditingStore((s) => s.timeline);
  const selectedIdx = useEditingStore((s) => s.selectedSegmentIndex);
  const replaceSegmentVideo = useEditingStore((s) => s.replaceSegmentVideo);
  const [hover, setHover] = useState<HoverPreview | null>(null);
  const [clampTip, setClampTip] = useState(false);

  const videos = useMemo(
    () => materials.filter((m: AnyMaterial): m is VideoMaterial => m.type === 'video'),
    [materials],
  );
  const usedPaths = useMemo(() => new Set(timeline.map((s) => s.video_path)), [timeline]);
  const noSelection = selectedIdx === null || selectedIdx >= timeline.length;

  const handleReplace = async (m: VideoMaterial) => {
    if (noSelection || selectedIdx === null || !m.filePath) return;
    const prevStart = timeline[selectedIdx]?.start_time ?? 0;
    let dur = m.durationSeconds || 0;
    if (!dur) {
      // 素材时长未知（探测失败/从未探测）：先懒探测。否则把 0 传给 store 会写入
      // source_duration=0 → 红色「!」误报，且入点被错误钳位到 0。
      // 探测失败则按 0 传，由 replaceSegmentVideo 的守卫兜底（不覆写、不钳位）。
      try {
        const r = await fetch(`${bu}/api/materials/probe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_path: m.filePath }),
        });
        const d = await r.json();
        const probed = Number(d?.data?.duration_seconds) || 0;
        if (d?.code === 0 && probed > 0) {
          dur = probed;
          useMaterialsStore.getState().updateMaterial(m.id, { durationSeconds: probed });
        }
      } catch { /* 探测失败按 0 走 store 守卫 */ }
    }
    replaceSegmentVideo(selectedIdx, m.filePath, dur);
    // 钳位轻提示：替换后入点被自动调整（新素材时长不足以保留原入点）
    const after = useEditingStore.getState().timeline[selectedIdx];
    if (after && Math.abs(after.start_time - prevStart) > 1e-6) setClampTip(true);
  };

  const handleEnter = (m: VideoMaterial, e: React.MouseEvent<HTMLDivElement>) => {
    if (!m.filePath) return;
    const r = e.currentTarget.getBoundingClientRect();
    // 默认放在行右侧；右侧空间不足时改放左侧，避免溢出视口
    const left = r.right + PREVIEW_W + 16 > window.innerWidth ? r.left - PREVIEW_W - 8 : r.right + 8;
    const top = Math.max(8, Math.min(r.top, window.innerHeight - PREVIEW_H - 8));
    setHover({ path: m.filePath, top, left });
  };

  if (videos.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary">
        素材库暂无视频素材，请先在步骤1导入
      </Typography>
    );
  }

  return (
    <Box>
      {noSelection && (
        <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 0.5 }}>
          先在中间时间轴点击选中一个片段
        </Typography>
      )}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, opacity: noSelection ? 0.55 : 1 }}>
        {videos.map((m) => {
          const used = usedPaths.has(m.filePath);
          return (
            <Box
              key={m.id}
              onClick={() => handleReplace(m)}
              onMouseEnter={(e) => handleEnter(m, e)}
              onMouseLeave={() => setHover((h) => (h && h.path === m.filePath ? null : h))}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, p: 0.5,
                borderRadius: 1, border: '1px solid', borderColor: 'divider',
                cursor: noSelection ? 'not-allowed' : 'pointer',
                '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
              }}
            >
              <Box sx={{ width: 40, height: 56, borderRadius: 0.5, overflow: 'hidden', flexShrink: 0, bgcolor: 'action.hover' }}>
                <img
                  src={thumbUrl(bu, m.filePath, 1)} alt="" loading="lazy"
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0'; }}
                />
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap title={m.fileName} sx={{ fontSize: '0.75rem' }}>
                  {m.fileName || baseName(m.filePath)}
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {(m.durationSeconds || 0).toFixed(1)}s
                </Typography>
              </Box>
              {used && <Chip label="已用" size="small" color="primary" variant="outlined" sx={{ height: 18, fontSize: '0.6rem', flexShrink: 0 }} />}
            </Box>
          );
        })}
      </Box>

      {/* hover 素材预览小窗（懒挂载，静音循环） */}
      {hover && (
        <Box
          sx={{
            position: 'fixed', top: hover.top, left: hover.left, zIndex: 1300,
            width: PREVIEW_W, height: PREVIEW_H, borderRadius: 1, overflow: 'hidden',
            boxShadow: 6, bgcolor: '#000', pointerEvents: 'none',
          }}
        >
          <video
            src={videoUrl(bu, hover.path)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            autoPlay muted loop playsInline
          />
        </Box>
      )}

      <Snackbar
        open={clampTip}
        autoHideDuration={2500}
        onClose={() => setClampTip(false)}
        message="入点已自动调整"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Box>
  );
};

export default MaterialReplaceList;
