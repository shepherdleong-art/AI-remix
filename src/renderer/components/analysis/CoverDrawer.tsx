import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Drawer, Box, Typography, Button, IconButton, useTheme } from '@mui/material';
import MovieIcon from '@mui/icons-material/Movie';
import CloseIcon from '@mui/icons-material/Close';
import { CoverEditor, CoverDraft } from '@/renderer/components/analysis/TimelineEditor';
import { useEditingStore } from '@/renderer/store/editing-store';

interface CoverDrawerProps {
  open: boolean;
  /** 取消 / ESC / 点击遮罩 → 关闭（草稿被丢弃，下次打开重新从 store 初始化） */
  onClose: () => void;
  /** 点「应用」→ 把草稿写回 store */
  onApply: (draft: CoverDraft) => void;
}

function buildDraft(): CoverDraft {
  const s = useEditingStore.getState();
  return {
    coverVideoPath: s.coverVideoPath,
    coverTime: s.coverTime,
    coverTitle: s.coverTitle,
    coverSubtitle: s.coverSubtitle,
    coverTitleX: s.coverTitleX,
    coverTitleY: s.coverTitleY,
    coverSubX: s.coverSubX,
    coverSubY: s.coverSubY,
    coverTitleSize: s.coverTitleSize,
    coverSubSize: s.coverSubSize,
    coverTitleColor: s.coverTitleColor,
    coverSubColor: s.coverSubColor,
    coverTitleStrokeColor: s.coverTitleStrokeColor,
    coverTitleStrokeWidth: s.coverTitleStrokeWidth,
    coverSubStrokeColor: s.coverSubStrokeColor,
    coverSubStrokeWidth: s.coverSubStrokeWidth,
    coverTitleItalic: s.coverTitleItalic,
    coverSubItalic: s.coverSubItalic,
    coverZoom: s.coverZoom,
    coverOffsetX: s.coverOffsetX,
    coverOffsetY: s.coverOffsetY,
    coverFont: s.coverFont,
    coverFontPath: s.coverFontPath,
  };
}

// 封面预览框高度封顶：避免矮窗口下预览框(原固定 640)把抽屉撑出滚动条。
// MAX = 理想最大高度；MIN = 下限（过矮失去编辑意义）；TOP_CHROME = body 内边距 +
// CoverEditor 卡片内边距/标题/间距（预览框上方固定占用，约 110px）。
const COVER_MAX_PREVIEW_H = 640;
const COVER_MIN_PREVIEW_H = 240;
const COVER_TOP_CHROME = 110;

/**
 * 视频封面二级界面：从右侧滑出的专用抽屉。
 * - 打开时从 store 拷贝封面字段到本地草稿；所有控件只改草稿（不碰 store），
 *   抽屉内预览实时跟草稿走。
 * - 「应用」把草稿写回 store 并关闭；「取消」/ESC/点遮罩丢弃草稿并关闭。
 */
const CoverDrawer: React.FC<CoverDrawerProps> = ({ open, onClose, onApply }) => {
  const theme = useTheme();
  const [draft, setDraft] = useState<CoverDraft | null>(null);
  const [previewH, setPreviewH] = useState(COVER_MAX_PREVIEW_H);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 按 body 可视高度动态封顶预览框，矮窗口下避免抽屉出现滚动条
  const recomputePreviewH = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const avail = el.clientHeight; // 已扣除 body 自身 padding
    const next = Math.max(
      COVER_MIN_PREVIEW_H,
      Math.min(COVER_MAX_PREVIEW_H, avail - COVER_TOP_CHROME),
    );
    setPreviewH(next);
  }, []);

  // open 变为 true 时：从 store 重新初始化草稿（自动丢弃上一次未应用的修改）
  // + 等布局稳定后按可用高度封顶预览框；并监听窗口缩放实时重算
  useEffect(() => {
    if (!open) return;
    setDraft(buildDraft());
    const raf = requestAnimationFrame(() => recomputePreviewH());
    window.addEventListener('resize', recomputePreviewH);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', recomputePreviewH);
    };
  }, [open, recomputePreviewH]);

  const patch = useCallback((p: Partial<CoverDraft>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }, []);

  const handleApply = useCallback(() => {
    if (draft) onApply(draft);
    onClose();
  }, [draft, onApply, onClose]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      transitionDuration={300}
      PaperProps={{
        sx: {
          width: { xs: '100vw', md: '68vw' },
          maxWidth: 1180,
          bgcolor: 'background.default',
        },
      }}
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Header */}
        <Box sx={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          px: 3, py: 2, borderBottom: 1, borderColor: 'divider', flexShrink: 0,
        }}>
          <Typography variant="h6" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <MovieIcon sx={{ color: 'primary.main' }} />
            视频封面设置
          </Typography>
          <IconButton onClick={onClose} size="small" title="关闭（取消修改）">
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Body（可滚动，预览框高度按可用空间封顶） */}
        <Box ref={bodyRef} sx={{ flex: 1, overflow: 'auto', p: 3 }}>
          {draft && <CoverEditor value={draft} onPatch={patch} previewH={previewH} />}
        </Box>

        {/* Footer：固定 取消 / 应用 双按钮 */}
        <Box sx={{
          display: 'flex', justifyContent: 'flex-end', gap: 1.5,
          px: 3, py: 2, borderTop: 1, borderColor: 'divider', flexShrink: 0,
          bgcolor: 'background.paper',
        }}>
          <Button onClick={onClose} color="inherit" sx={{ borderRadius: 2 }}>
            取消
          </Button>
          <Button
            onClick={handleApply}
            variant="contained"
            sx={{ borderRadius: 2, px: 3, boxShadow: `0 4px 14px ${theme.palette.primary.main}55` }}
          >
            应用
          </Button>
        </Box>
      </Box>
    </Drawer>
  );
};

export default CoverDrawer;
