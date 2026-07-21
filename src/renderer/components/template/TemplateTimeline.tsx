/**
 * TemplateTimeline component.
 *
 * Horizontal timeline track editor (similar to video editing software).
 * Each segment is displayed as a draggable colored bar with duration-proportional
 * width. Supports drag-and-drop reordering, ruler with second tick marks,
 * playhead dragging, keyboard shortcuts, and right-click context menu.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@mui/material';
import {
  Box,
  Typography,
  Menu,
  MenuItem,
  Divider,
} from '@mui/material';
import ContentCutIcon from '@mui/icons-material/ContentCut';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import TimelineSegment from './TimelineSegment';
import { useTemplateStore } from '@/renderer/store/template-store';
import { useMaterialsStore } from '@/renderer/store/materials-store';
import type { Segment } from '@/renderer/types/template';
import type { AnyMaterial } from '@/renderer/types/material';

/** Pixels per second scale factor for timeline rendering */
const DEFAULT_PX_PER_SECOND: number = 60;

/** Minimum pixels per second */
const MIN_PX_PER_SECOND: number = 20;

/** Maximum pixels per second */
const MAX_PX_PER_SECOND: number = 200;

/** Ruler height in pixels */
const RULER_HEIGHT: number = 24;

/** Track height in pixels */
const TRACK_HEIGHT: number = 56;

/** Default zoom step */
const ZOOM_STEP: number = 15;

/**
 * Format seconds to mm:ss or h:mm:ss display.
 */
function formatTimeCompact(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const h: number = Math.floor(seconds / 3600);
  const m: number = Math.floor((seconds % 3600) / 60);
  const s: number = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Timeline editor component.
 *
 * Provides a horizontal timeline track with draggable segments,
 * ruler ticks, playhead, zoom controls, and context menu.
 */
const TemplateTimeline: React.FC = () => {
  const theme = useTheme();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLCanvasElement>(null);

  // Store
  const currentTemplate = useTemplateStore((s) => s.currentTemplate);
  const selectedSegmentId = useTemplateStore((s) => s.selectedSegmentId);
  const selectSegment = useTemplateStore((s) => s.selectSegment);
  const removeSegment = useTemplateStore((s) => s.removeSegment);
  const reorderSegments = useTemplateStore((s) => s.reorderSegments);
  const duplicateSegment = useTemplateStore((s) => s.duplicateSegment);
  const materials = useMaterialsStore((s) => s.materials);

  const template = currentTemplate();
  const segments: Segment[] = template?.segments || [];
  const totalDuration: number = template?.totalDuration || 0;

  // Zoom level (pixels per second)
  const [pixelsPerSecond, setPixelsPerSecond] = useState<number>(DEFAULT_PX_PER_SECOND);

  // Playhead position in seconds
  const [playheadTime, setPlayheadTime] = useState<number>(0);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    mouseX: number;
    mouseY: number;
    segmentId: string;
  } | null>(null);

  // Drag state
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Total timeline width in pixels
  const timelineWidth: number = Math.max(
    (totalDuration || 30) * pixelsPerSecond,
    600, // Minimum visible width
  );

  // Build material lookup map for type detection
  const materialMap: Map<string, AnyMaterial> = useMemo(() => {
    const map = new Map<string, AnyMaterial>();
    for (const m of materials) {
      map.set(m.id, m);
    }
    return map;
  }, [materials]);

  /**
   * Get material type string for a segment's material.
   */
  const getMaterialType = useCallback(
    (segment: Segment): string => {
      if (!segment.materialId) return '';
      const mat = materialMap.get(segment.materialId);
      return mat?.type || '';
    },
    [materialMap],
  );

  /**
   * Draw ruler ticks on the canvas.
   */
  const drawRuler = useCallback((): void => {
    const canvas = rulerRef.current;
    if (!canvas) return;

    const dpr: number = window.devicePixelRatio || 1;
    const displayWidth: number = canvas.clientWidth;
    canvas.width = displayWidth * dpr;
    canvas.height = RULER_HEIGHT * dpr;
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${RULER_HEIGHT}px`;

    const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) return;

    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#f5f5f5';
    ctx.fillRect(0, 0, displayWidth, RULER_HEIGHT);

    const container = scrollRef.current;
    const scrollLeft: number = container?.scrollLeft || 0;

    // Determine tick interval based on zoom
    let tickInterval: number = 1; // seconds
    if (pixelsPerSecond < 30) tickInterval = 5;
    else if (pixelsPerSecond < 60) tickInterval = 2;
    else if (pixelsPerSecond >= 120) tickInterval = 0.5;

    const maxTime: number = totalDuration > 0 ? totalDuration : 30;

    // Draw ticks
    ctx.strokeStyle = '#bdbdbd';
    ctx.fillStyle = '#757575';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';

    for (let t: number = 0; t <= maxTime; t += tickInterval) {
      const x: number = t * pixelsPerSecond - scrollLeft;
      if (x < 0 || x > displayWidth) continue;

      // Major tick
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 8);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();

      // Label
      ctx.fillText(formatTimeCompact(t), x, RULER_HEIGHT - 10);

      // Sub ticks for intervals > 0.5s
      if (tickInterval >= 1) {
        const subInterval: number = tickInterval / (tickInterval >= 2 ? 2 : 2);
        for (let st: number = t + subInterval; st < t + tickInterval && st <= maxTime; st += subInterval) {
          const sx: number = st * pixelsPerSecond - scrollLeft;
          if (sx < 0 || sx > displayWidth) continue;
          ctx.beginPath();
          ctx.moveTo(sx, RULER_HEIGHT - 4);
          ctx.lineTo(sx, RULER_HEIGHT);
          ctx.stroke();
        }
      }
    }

    // Draw playhead line
    const playheadX: number = playheadTime * pixelsPerSecond - scrollLeft;
    if (playheadX >= 0 && playheadX <= displayWidth) {
      ctx.strokeStyle = '#f44336';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX, RULER_HEIGHT);
      ctx.stroke();

      // Playhead triangle
      ctx.fillStyle = '#f44336';
      ctx.beginPath();
      ctx.moveTo(playheadX, 0);
      ctx.lineTo(playheadX - 6, RULER_HEIGHT / 2);
      ctx.lineTo(playheadX + 6, RULER_HEIGHT / 2);
      ctx.closePath();
      ctx.fill();
    }
  }, [pixelsPerSecond, totalDuration, playheadTime]);

  // Redraw ruler on scroll/zoom/playhead changes
  useEffect(() => {
    drawRuler();
  }, [drawRuler]);

  // Sync ruler scroll with timeline scroll
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const handleScroll = (): void => {
      drawRuler();
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', drawRuler);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', drawRuler);
    };
  }, [drawRuler]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Delete selected segment
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedSegmentId) {
          e.preventDefault();
          removeSegment(selectedSegmentId);
        }
      }

      // Ctrl+Z / Ctrl+Y stubs (actual undo/redo handled by TemplateEditor toolbar)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        // Undo is handled at the TemplateEditor level
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        // Redo is handled at the TemplateEditor level
      }

      // Zoom with +/- keys (or scroll)
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        setPixelsPerSecond((prev: number) => Math.min(MAX_PX_PER_SECOND, prev + ZOOM_STEP));
      }
      if (e.key === '-') {
        e.preventDefault();
        setPixelsPerSecond((prev: number) => Math.max(MIN_PX_PER_SECOND, prev - ZOOM_STEP));
      }
    };

    const container = scrollRef.current;
    if (container) {
      container.addEventListener('keydown', handleKeyDown);
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (container) {
        container.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [selectedSegmentId, removeSegment]);

  // ─── Event Handlers ────────────────────────────────────

  const handleSegmentClick = useCallback(
    (segmentId: string, _event: React.MouseEvent): void => {
      selectSegment(segmentId);
    },
    [selectSegment],
  );

  const handleContextMenu = useCallback(
    (segmentId: string, event: React.MouseEvent): void => {
      event.preventDefault();
      setContextMenu({
        mouseX: event.clientX - 2,
        mouseY: event.clientY - 4,
        segmentId,
      });
    },
    [],
  );

  const handleCloseContextMenu = useCallback((): void => {
    setContextMenu(null);
  }, []);

  const handleContextDelete = useCallback((): void => {
    if (contextMenu) {
      removeSegment(contextMenu.segmentId);
      setContextMenu(null);
    }
  }, [contextMenu, removeSegment]);

  const handleContextDuplicate = useCallback((): void => {
    if (contextMenu) {
      duplicateSegment(contextMenu.segmentId);
      setContextMenu(null);
    }
  }, [contextMenu, duplicateSegment]);

  // ─── Drag-and-Drop Reordering ──────────────────────────

  const handleDragStart = useCallback(
    (segmentId: string, _event: React.DragEvent): void => {
      // Visual feedback could be added here
    },
    [],
  );

  const handleDragOver = useCallback(
    (segmentId: string, _event: React.DragEvent): void => {
      const idx: number = segments.findIndex((s: Segment) => s.id === segmentId);
      if (idx >= 0) {
        setDragOverIdx(idx);
      }
    },
    [segments],
  );

  const handleDrop = useCallback(
    (targetId: string, event: React.DragEvent): void => {
      event.preventDefault();
      setDragOverIdx(null);

      const sourceId: string = event.dataTransfer.getData('text/plain');
      const fromIdx: number = segments.findIndex((s: Segment) => s.id === sourceId);
      const toIdx: number = segments.findIndex((s: Segment) => s.id === targetId);

      if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
        reorderSegments(fromIdx, toIdx);
      }
    },
    [segments, reorderSegments],
  );

  const handleTimelineClick = useCallback(
    (e: React.MouseEvent): void => {
      // Click on empty timeline area to deselect
      if (e.target === e.currentTarget || (e.target as HTMLElement).closest('[data-timeline-track]')) {
        selectSegment(null);
      }

      // Calculate playhead time from click position
      const container = scrollRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const clickX: number = e.clientX - rect.left + container.scrollLeft;
        const time: number = Math.max(0, clickX / pixelsPerSecond);
        setPlayheadTime(time);
      }
    },
    [selectSegment, pixelsPerSecond],
  );

  // Wheel zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent): void => {
      if (e.ctrlKey) {
        e.preventDefault();
        setPixelsPerSecond((prev: number) => {
          const delta: number = e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP;
          return Math.max(MIN_PX_PER_SECOND, Math.min(MAX_PX_PER_SECOND, prev + delta));
        });
      }
    },
    [],
  );

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      {/* Ruler */}
      <Box sx={{ overflow: 'hidden', borderBottom: '1px solid', borderColor: 'divider' }}>
        <canvas
          ref={rulerRef}
          style={{
            width: '100%',
            height: RULER_HEIGHT,
            display: 'block',
          }}
        />
      </Box>

      {/* Timeline track */}
      <Box
        ref={scrollRef}
        tabIndex={0}
        onClick={handleTimelineClick}
        onWheel={handleWheel}
        data-timeline-track="true"
        sx={{
          overflowX: 'auto',
          overflowY: 'hidden',
          height: TRACK_HEIGHT,
          bgcolor: 'background.paperAlt',
          position: 'relative',
          outline: 'none',
          '&:focus-visible': {
            outline: `2px solid ${theme.palette.primary.main}`,
            outlineOffset: -2,
          },
        }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            height: TRACK_HEIGHT,
            minWidth: `${timelineWidth}px`,
            px: 1,
            gap: 0.5,
          }}
        >
          {segments.length === 0 ? (
            <Box
              sx={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography variant="body2" color="text.secondary">
                点击「添加片段」按钮或从素材库拖入素材开始编辑
              </Typography>
            </Box>
          ) : (
            segments.map((segment: Segment) => (
              <Box
                key={segment.id}
                sx={{
                  opacity: dragOverIdx !== null && dragOverIdx === segments.findIndex((s: Segment) => s.id === segment.id)
                    ? 0.5
                    : 1,
                  transition: 'opacity 0.15s',
                }}
              >
                <TimelineSegment
                  segment={segment}
                  isSelected={selectedSegmentId === segment.id}
                  totalDuration={totalDuration || 30}
                  materialType={getMaterialType(segment)}
                  pixelsPerSecond={pixelsPerSecond}
                  onClick={handleSegmentClick}
                  onContextMenu={handleContextMenu}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                />
              </Box>
            ))
          )}
        </Box>
      </Box>

      {/* Playhead time display */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1.5,
          py: 0.5,
          bgcolor: '#eeeeee',
          borderTop: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          {segments.length} 个片段
        </Typography>
        <Typography variant="caption" color="text.secondary">
          播放头: {formatTimeCompact(playheadTime)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          总时长: {formatTimeCompact(totalDuration)}
        </Typography>
      </Box>

      {/* Right-click context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
      >
        <MenuItem onClick={handleContextDuplicate} dense>
          <ContentCopyIcon sx={{ mr: 1, fontSize: 18 }} />
          复制片段
        </MenuItem>
        <MenuItem onClick={() => {
          if (contextMenu) {
            selectSegment(contextMenu.segmentId);
          }
          setContextMenu(null);
        }} dense>
          <ContentCutIcon sx={{ mr: 1, fontSize: 18 }} />
          编辑属性
        </MenuItem>
        <Divider />
        <MenuItem onClick={handleContextDelete} dense sx={{ color: 'error.main' }}>
          <DeleteIcon sx={{ mr: 1, fontSize: 18 }} />
          删除片段
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default TemplateTimeline;
