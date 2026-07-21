import React from 'react';
import {
  Box,
  Typography,
  IconButton,
} from '@mui/material';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';
import MovieIcon from '@mui/icons-material/Movie';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';

import { ThemeSwitch } from '@/renderer/components/common/ThemeSwitch';
import { GlobalAspectControl } from './GlobalAspectControl';
import StepLeftPanel from './StepLeftPanel';
import StepRightPanel from './StepRightPanel';

import MaterialsManager from '@/renderer/components/materials/MaterialsManager';
import AiScriptEditor from '@/renderer/components/analysis/AiScriptEditor';
import TimelineEditor from '@/renderer/components/analysis/TimelineEditor';
import ExportConfirm from '@/renderer/components/render/ExportConfirm';

/* ─── Layout persistence ────────────────────────────── */
interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}
const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 264,
  rightWidth: 320,
  leftCollapsed: false,
  rightCollapsed: false,
};
const LAYOUT_KEY = 'fcp-layout';

const clamp = (v: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, v));

const loadLayout = (): LayoutState => {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
};

/* ─── Nav definition ────────────────────────────────── */
const NAV: Array<{
  label: string;
  sub: string;
  Icon: React.ComponentType<SvgIconProps>;
}> = [
  { label: '导入素材', sub: '选择文件夹', Icon: CloudUploadIcon },
  { label: 'AI 智能创作', sub: '分析 · 脚本', Icon: AutoAwesomeIcon },
  { label: '预览调整', sub: '时间线 · 封面', Icon: PlayCircleIcon },
  { label: '导出渲染', sub: '成片输出', Icon: MovieIcon },
];

/* ─── Column resizer ────────────────────────────────── */
const Resizer: React.FC<{ onResize: (dx: number) => void }> = ({ onResize }) => {
  const [dragging, setDragging] = React.useState(false);
  const startX = React.useRef(0);

  const onPointerDown = (e: React.PointerEvent) => {
    setDragging(true);
    startX.current = e.clientX;
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    onResize(e.clientX - startX.current);
    startX.current = e.clientX;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDragging(false);
    try {
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  return (
    <Box
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      sx={{
        width: 6,
        flexShrink: 0,
        cursor: 'col-resize',
        bgcolor: dragging ? 'primary.main' : 'transparent',
        transition: 'background-color .15s',
        '&:hover': { bgcolor: dragging ? 'primary.main' : 'action.hover' },
      }}
    />
  );
};

/* ─── App shell ─────────────────────────────────────── */
const AppShell: React.FC = () => {
  const [activeStep, setActiveStep] = React.useState<number>(0);
  const [visited, setVisited] = React.useState<Set<number>>(
    () => new Set<number>([0]),
  );
  const [layout, setLayout] = React.useState<LayoutState>(loadLayout);
  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = layout;

  const goToStep = (i: number): void => {
    setActiveStep(i);
    setVisited((prev) => {
      if (prev.has(i)) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  };

  const update = (patch: Partial<LayoutState>): void =>
    setLayout((prev) => ({ ...prev, ...patch }));

  React.useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  }, [layout]);

  const onLeftResize = (dx: number): void =>
    update({ leftWidth: clamp(leftWidth + dx, 200, 440) });
  const onRightResize = (dx: number): void =>
    update({ rightWidth: clamp(rightWidth - dx, 240, 500) });

  const steps = [MaterialsManager, AiScriptEditor, TimelineEditor, ExportConfirm];

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        overflow: 'hidden',
      }}
    >
      {/* ── Top bar ─────────────────────────────────── */}
      <Box
        sx={{
          height: 56,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          px: 2,
          gap: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexShrink: 0 }}>
          <Box
            sx={{
              width: 34,
              height: 34,
              borderRadius: 2,
              bgcolor: 'primary.main',
              color: 'primary.contrastText',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            剪
          </Box>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.1 }}>
              短视频智能混剪
            </Typography>
            <Typography variant="caption" color="text.secondary">
              AI 分析 · 自动匹配 · 一键导出
            </Typography>
          </Box>
        </Box>

        <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center' }}>
          <GlobalAspectControl />
        </Box>

        <Box sx={{ flexShrink: 0 }}>
          <ThemeSwitch />
        </Box>
      </Box>

      {/* ── Body: nav + workspace ───────────────────── */}
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left nav */}
        <Box
          sx={{
            width: 208,
            flexShrink: 0,
            borderRight: '1px solid',
            borderColor: 'divider',
            bgcolor: 'background.paper',
            p: 1.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {NAV.map((item, i) => {
            const active = activeStep === i;
            const done = !active && visited.has(i);
            return (
              <Box
                key={item.label}
                onClick={() => goToStep(i)}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  p: 1.25,
                  borderRadius: 2,
                  cursor: 'pointer',
                  position: 'relative',
                  border: '1px solid',
                  borderColor: active ? 'primary.main' : 'transparent',
                  bgcolor: active ? 'action.selected' : 'transparent',
                  transition: 'all .18s cubic-bezier(0.16,1,0.3,1)',
                  '&:hover': {
                    bgcolor: 'action.hover',
                  },
                }}
              >
                {active && (
                  <Box
                    sx={{
                      position: 'absolute',
                      left: 0,
                      top: 10,
                      bottom: 10,
                      width: 3,
                      borderRadius: 2,
                      bgcolor: 'primary.main',
                    }}
                  />
                )}
                <Box
                  sx={{
                    width: 34,
                    height: 34,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    border: '1.5px solid',
                    borderColor: active ? 'primary.main' : 'divider',
                    color: active ? 'primary.main' : 'text.secondary',
                    bgcolor: active ? 'primary.main' : 'transparent',
                  }}
                >
                  {done ? (
                    <CheckCircleIcon fontSize="small" sx={{ color: 'success.main' }} />
                  ) : (
                    <item.Icon fontSize="small" sx={active ? { color: 'primary.contrastText' } : {}} />
                  )}
                </Box>
                <Box sx={{ minWidth: 0 }}>
                  <Typography
                    variant="body2"
                    fontWeight={active ? 700 : 500}
                    noWrap
                    color={active ? 'primary.main' : 'text.primary'}
                  >
                    {item.label}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {item.sub}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* Workspace */}
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            p: 1.5,
            gap: 1.5,
            position: 'relative',
          }}
        >
          {/* Left panel column */}
          {!leftCollapsed && (
            <>
              <Box sx={{ position: 'relative', width: leftWidth, flexShrink: 0, minHeight: 0 }}>
                <StepLeftPanel step={activeStep} />
                <IconButton
                  size="small"
                  onClick={() => update({ leftCollapsed: true })}
                  sx={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    zIndex: 2,
                    bgcolor: 'background.paper',
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <ChevronLeftIcon fontSize="small" />
                </IconButton>
              </Box>
              <Resizer onResize={onLeftResize} />
            </>
          )}
          {leftCollapsed && (
            <Box
              sx={{
                width: 36,
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'center',
                pt: 1,
              }}
            >
              <IconButton size="small" onClick={() => update({ leftCollapsed: false })}>
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </Box>
          )}

          {/* Center: step main component (all mounted, display toggled) */}
          <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
            {steps.map((StepComp, i) => (
              <Box key={i} sx={{ display: activeStep === i ? 'block' : 'none' }}>
                <StepComp />
              </Box>
            ))}
          </Box>

          {/* Right panel column */}
          {!rightCollapsed && (
            <>
              <Resizer onResize={onRightResize} />
              <Box sx={{ position: 'relative', width: rightWidth, flexShrink: 0, minHeight: 0 }}>
                <StepRightPanel step={activeStep} />
                <IconButton
                  size="small"
                  onClick={() => update({ rightCollapsed: true })}
                  sx={{
                    position: 'absolute',
                    top: 6,
                    right: 6,
                    zIndex: 2,
                    bgcolor: 'background.paper',
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                >
                  <ChevronRightIcon fontSize="small" />
                </IconButton>
              </Box>
            </>
          )}
          {rightCollapsed && (
            <Box
              sx={{
                width: 36,
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'center',
                pt: 1,
              }}
            >
              <IconButton size="small" onClick={() => update({ rightCollapsed: false })}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
};

export default AppShell;
