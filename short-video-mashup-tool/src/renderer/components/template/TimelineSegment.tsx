/**
 * TimelineSegment component.
 *
 * A single draggable segment bar on the template timeline.
 * Displays the segment as a colored bar with duration-proportional width,
 * material type color coding, and selection highlight.
 */
import React, { useCallback, useRef } from 'react';
import { Box, Typography } from '@mui/material';
import type { Segment } from '@/renderer/types/template';
import { formatDuration } from '@/renderer/types/material';

interface TimelineSegmentProps {
  /** The segment data */
  segment: Segment;
  /** Whether this segment is currently selected */
  isSelected: boolean;
  /** Total timeline duration for proportional width calculation */
  totalDuration: number;
  /** Material type for color coding ('video' | 'image' | '') */
  materialType: string;
  /** Click handler */
  onClick: (segmentId: string, event: React.MouseEvent) => void;
  /** Right-click handler */
  onContextMenu: (segmentId: string, event: React.MouseEvent) => void;
  /** Drag start handler for reordering */
  onDragStart: (segmentId: string, event: React.DragEvent) => void;
  /** Drag over handler */
  onDragOver: (segmentId: string, event: React.DragEvent) => void;
  /** Drop handler */
  onDrop: (segmentId: string, event: React.DragEvent) => void;
  /** Pixels per second scale */
  pixelsPerSecond: number;
}

/**
 * Color map for different material types on the timeline.
 */
const MATERIAL_COLORS: Record<string, string> = {
  video: '#1976d2',   // primary blue
  image: '#9c27b0',   // purple
  '': '#bdbdbd',       // grey (no material assigned)
};

const MATERIAL_COLORS_LIGHT: Record<string, string> = {
  video: '#e3f2fd',
  image: '#f3e5f5',
  '': '#fafafa',
};

/**
 * A single segment bar on the timeline track.
 *
 * Supports HTML5 drag-and-drop for reordering. The bar width
 * is proportional to the segment duration relative to total duration.
 */
const TimelineSegment: React.FC<TimelineSegmentProps> = ({
  segment,
  isSelected,
  materialType,
  totalDuration,
  pixelsPerSecond,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
}) => {
  const barRef = useRef<HTMLDivElement>(null);

  // Calculate proportional width
  const segmentWidth: number = Math.max(
    segment.duration * pixelsPerSecond,
    40, // Minimum width in pixels
  );

  const color: string = MATERIAL_COLORS[materialType] || MATERIAL_COLORS[''];
  const bgColor: string = MATERIAL_COLORS_LIGHT[materialType] || MATERIAL_COLORS_LIGHT[''];

  const handleClick = useCallback(
    (e: React.MouseEvent): void => {
      e.stopPropagation();
      onClick(segment.id, e);
    },
    [segment.id, onClick],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(segment.id, e);
    },
    [segment.id, onContextMenu],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent): void => {
      e.dataTransfer.setData('text/plain', segment.id);
      e.dataTransfer.effectAllowed = 'move';
      onDragStart(segment.id, e);
    },
    [segment.id, onDragStart],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      onDragOver(segment.id, e);
    },
    [segment.id, onDragOver],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault();
      onDrop(segment.id, e);
    },
    [segment.id, onDrop],
  );

  return (
    <Box
      ref={barRef}
      draggable
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      sx={{
        height: 44,
        minWidth: `${segmentWidth}px`,
        width: `${segmentWidth}px`,
        backgroundColor: isSelected ? color : bgColor,
        border: `2px solid ${isSelected ? color : '#e0e0e0'}`,
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        userSelect: 'none',
        transition: 'border-color 0.15s, background-color 0.15s',
        position: 'relative',
        overflow: 'hidden',
        '&:hover': {
          borderColor: color,
          backgroundColor: isSelected ? color : `${bgColor}CC`,
        },
        '&:active': {
          cursor: 'grabbing',
        },
      }}
    >
      {/* Order number badge */}
      <Typography
        variant="caption"
        sx={{
          position: 'absolute',
          top: 1,
          left: 4,
          fontSize: 9,
          color: isSelected ? '#fff' : 'text.secondary',
          fontWeight: 600,
          lineHeight: 1,
        }}
      >
        #{segment.order + 1}
      </Typography>

      {/* Duration label */}
      <Typography
        variant="caption"
        sx={{
          fontSize: 10,
          color: isSelected ? '#fff' : 'text.primary',
          fontWeight: 500,
          mt: 1,
        }}
      >
        {formatDuration(segment.duration)}
      </Typography>
    </Box>
  );
};

export default TimelineSegment;
