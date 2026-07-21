/**
 * HighlightsGrid — Grid of highlight moment cards.
 *
 * Displays detected highlight clips as cards with thumbnail,
 * timestamp, score, and reason. Cards are clickable to seek
 * to the corresponding time point.
 */
import React from 'react';
import {
  Box,
  Paper,
  Typography,
  Grid,
  Chip,
  Rating,
} from '@mui/material';
import StarIcon from '@mui/icons-material/Star';
import type { Highlight } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface HighlightsGridProps {
  /** Highlight entries to display */
  highlights: Highlight[];
  /** Callback when a highlight card is clicked */
  onHighlightClick?: (highlight: Highlight) => void;
  /** Whether there are no highlights */
  isEmpty?: boolean;
  /** Loading state */
  isLoading?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────

/** Format seconds to mm:ss */
function formatTime(seconds: number): string {
  const m: number = Math.floor(seconds / 60);
  const s: number = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Map score to color */
function scoreColor(score: number): 'success' | 'warning' | 'error' {
  if (score >= 70) return 'success';
  if (score >= 40) return 'warning';
  return 'error';
}

// ─── Component ──────────────────────────────────────────────

const HighlightsGrid: React.FC<HighlightsGridProps> = ({
  highlights,
  onHighlightClick,
  isEmpty = false,
  isLoading = false,
}) => {
  // Empty state
  if (isEmpty) {
    return (
      <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="body1" gutterBottom>
          暂无亮点数据
        </Typography>
        <Typography variant="body2">请先分析素材以发现亮点片段</Typography>
      </Box>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          正在识别亮点片段...
        </Typography>
      </Box>
    );
  }

  // No highlights
  if (highlights.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="body2">该素材未识别到高光片段</Typography>
      </Box>
    );
  }

  // Sort by score descending
  const sorted = [...highlights].sort(
    (a: Highlight, b: Highlight) => b.score - a.score,
  );

  return (
    <Grid container spacing={2}>
      {sorted.map((highlight: Highlight) => (
        <Grid item xs={12} sm={6} md={4} key={highlight.id}>
          <Paper
            elevation={0}
            variant="outlined"
            onClick={() => onHighlightClick?.(highlight)}
            sx={{
              cursor: onHighlightClick ? 'pointer' : 'default',
              overflow: 'hidden',
              borderRadius: 2,
              transition: 'all 0.2s',
              '&:hover': {
                boxShadow: 4,
                transform: 'translateY(-2px)',
                borderColor: 'primary.main',
              },
            }}
          >
            {/* Thumbnail */}
            <Box
              sx={{
                width: '100%',
                aspectRatio: '16/9',
                bgcolor: 'background.paperAlt',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {highlight.thumbnail ? (
                <Box
                  component="img"
                  src={`data:image/jpeg;base64,${highlight.thumbnail}`}
                  alt={highlight.reason}
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
                  }}
                >
                  <StarIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
                </Box>
              )}

              {/* Time overlay */}
              <Box
                sx={{
                  position: 'absolute',
                  bottom: 6,
                  left: 6,
                  bgcolor: 'rgba(0,0,0,0.7)',
                  color: 'white',
                  px: 1,
                  py: 0.3,
                  borderRadius: 1,
                  fontSize: '0.75rem',
                  fontFamily: 'monospace',
                }}
              >
                {formatTime(highlight.timeRange[0])} — {formatTime(highlight.timeRange[1])}
              </Box>

              {/* Score badge */}
              <Box
                sx={{
                  position: 'absolute',
                  top: 6,
                  right: 6,
                }}
              >
                <Chip
                  icon={<StarIcon sx={{ fontSize: 14 }} />}
                  label={highlight.score}
                  size="small"
                  color={scoreColor(highlight.score)}
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    height: 26,
                  }}
                />
              </Box>
            </Box>

            {/* Info footer */}
            <Box sx={{ px: 1.5, py: 1 }}>
              <Typography variant="body2" fontWeight={500} noWrap>
                {highlight.reason}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                时长: {(highlight.timeRange[1] - highlight.timeRange[0]).toFixed(1)}秒
              </Typography>
            </Box>
          </Paper>
        </Grid>
      ))}
    </Grid>
  );
};

export default HighlightsGrid;
