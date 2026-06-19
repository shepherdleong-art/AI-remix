/**
 * SceneList — Timeline thumbnail list for detected scenes.
 *
 * Uses MUI ImageList to display scene thumbnails in a responsive grid.
 * Clicking a scene card can seek to the corresponding time point.
 * Hover reveals confidence score and description.
 */
import React, { useState } from 'react';
import {
  Box,
  ImageList,
  ImageListItem,
  ImageListItemBar,
  Typography,
  Chip,
  Tooltip,
} from '@mui/material';
import type { Scene } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface SceneListProps {
  /** Detected scenes to display */
  scenes: Scene[];
  /** Callback when a scene thumbnail is clicked */
  onSceneClick?: (scene: Scene) => void;
  /** Whether there are no scenes to display */
  isEmpty?: boolean;
  /** Loading state */
  isLoading?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Format seconds to mm:ss format */
function formatTime(seconds: number): string {
  const m: number = Math.floor(seconds / 60);
  const s: number = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Determine confidence color */
function confidenceColor(confidence: number): 'success' | 'warning' | 'error' {
  if (confidence >= 0.8) return 'success';
  if (confidence >= 0.5) return 'warning';
  return 'error';
}

// ─── Component ──────────────────────────────────────────────

const SceneList: React.FC<SceneListProps> = ({
  scenes,
  onSceneClick,
  isEmpty = false,
  isLoading = false,
}) => {
  const [hoveredSceneId, setHoveredSceneId] = useState<string | null>(null);

  // Empty state
  if (isEmpty) {
    return (
      <Box
        sx={{
          py: 6,
          textAlign: 'center',
          color: 'text.secondary',
        }}
      >
        <Typography variant="body1" gutterBottom>
          暂无场景检测结果
        </Typography>
        <Typography variant="body2">
          请先分析素材以生成场景列表
        </Typography>
      </Box>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          正在检测场景...
        </Typography>
      </Box>
    );
  }

  // No scenes
  if (scenes.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="body2">该素材未检测到场景变化</Typography>
      </Box>
    );
  }

  return (
    <ImageList
      cols={4}
      gap={12}
      sx={{
        maxHeight: 400,
        overflowY: 'auto',
        '&::-webkit-scrollbar': { width: 6 },
        '&::-webkit-scrollbar-thumb': {
          backgroundColor: 'grey.300',
          borderRadius: 3,
        },
      }}
    >
      {scenes.map((scene: Scene) => {
        const isHovered = hoveredSceneId === scene.id;

        return (
          <ImageListItem
            key={scene.id}
            onMouseEnter={() => setHoveredSceneId(scene.id)}
            onMouseLeave={() => setHoveredSceneId(null)}
            onClick={() => onSceneClick?.(scene)}
            sx={{
              cursor: onSceneClick ? 'pointer' : 'default',
              borderRadius: 1,
              overflow: 'hidden',
              border: '2px solid',
              borderColor: isHovered ? 'primary.main' : 'transparent',
              transition: 'all 0.2s ease',
              '&:hover': {
                transform: 'scale(1.03)',
                boxShadow: 3,
              },
              bgcolor: 'grey.100',
              aspectRatio: '16/9',
              position: 'relative',
            }}
          >
            {scene.thumbnail ? (
              <Box
                component="img"
                src={`data:image/jpeg;base64,${scene.thumbnail}`}
                alt={scene.description || `场景 ${formatTime(scene.startTime)}`}
                loading="lazy"
                sx={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                }}
              />
            ) : (
              <Box
                sx={{
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'grey.200',
                }}
              >
                <Typography variant="caption" color="text.disabled">
                  {formatTime(scene.startTime)}
                </Typography>
              </Box>
            )}

            {/* Time overlay */}
            <Box
              sx={{
                position: 'absolute',
                bottom: 4,
                left: 4,
                bgcolor: 'rgba(0,0,0,0.65)',
                color: 'white',
                px: 0.8,
                py: 0.2,
                borderRadius: 0.5,
                fontSize: '0.7rem',
                fontFamily: 'monospace',
              }}
            >
              {formatTime(scene.startTime)}
            </Box>

            {/* Hover info */}
            {isHovered && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 4,
                  right: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 0.5,
                  alignItems: 'flex-end',
                }}
              >
                <Tooltip title={scene.description || '无描述'} arrow>
                  <Chip
                    label={`${Math.round(scene.confidence * 100)}%`}
                    size="small"
                    color={confidenceColor(scene.confidence)}
                    sx={{
                      fontWeight: 600,
                      fontSize: '0.7rem',
                      height: 22,
                    }}
                  />
                </Tooltip>
              </Box>
            )}

            <ImageListItemBar
              subtitle={
                <Typography variant="caption" noWrap>
                  {scene.description || `${formatTime(scene.startTime)} - ${formatTime(scene.endTime)}`}
                </Typography>
              }
              sx={{
                '& .MuiImageListItemBar-subtitle': {
                  fontSize: '0.7rem',
                },
              }}
            />
          </ImageListItem>
        );
      })}
    </ImageList>
  );
};

export default SceneList;
