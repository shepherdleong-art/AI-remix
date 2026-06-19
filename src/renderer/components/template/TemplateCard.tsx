/**
 * TemplateCard component.
 *
 * A card displaying a single template in the market browser.
 * Shows thumbnail, name, duration, category badge, and built-in/custom indicator.
 */
import React, { useCallback } from 'react';
import {
  Card,
  CardMedia,
  CardContent,
  CardActions,
  CardActionArea,
  Typography,
  Chip,
  Box,
  Tooltip,
} from '@mui/material';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import SegmentIcon from '@mui/icons-material/Segment';
import BookmarkIcon from '@mui/icons-material/Bookmark';
import BuildIcon from '@mui/icons-material/Build';
import type { Template } from '@/renderer/types/template';
import { TEMPLATE_CATEGORIES } from '@/renderer/types/template';
import { formatDuration } from '@/renderer/types/material';

interface TemplateCardProps {
  /** The template to display */
  template: Template;
  /** Whether this template is currently selected */
  isSelected: boolean;
  /** Click handler for using this template */
  onUse: (template: Template) => void;
  /** Click handler for previewing this template */
  onPreview: (template: Template) => void;
}

/**
 * Get a color for a template category chip.
 */
function getCategoryColor(categoryId: string): 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info' | 'default' {
  const colorMap: Record<string, 'primary' | 'secondary' | 'success' | 'error' | 'warning' | 'info' | 'default'> = {
    'fast-paced': 'error',
    'vlog': 'primary',
    'product': 'success',
    'tutorial': 'info',
    'festival': 'warning',
    'slideshow': 'secondary',
    'custom': 'default',
  };
  return colorMap[categoryId] || 'default';
}

/**
 * Get category display name.
 */
function getCategoryName(categoryId: string): string {
  const cat = TEMPLATE_CATEGORIES.find((c) => c.id === categoryId);
  return cat?.name || categoryId;
}

/**
 * Default background colors for template thumbnails based on category.
 */
const CATEGORY_THUMBNAIL_BG: Record<string, string> = {
  'fast-paced': 'linear-gradient(135deg, #ff1744 0%, #ff6e40 100%)',
  'vlog': 'linear-gradient(135deg, #2979ff 0%, #00b0ff 100%)',
  'product': 'linear-gradient(135deg, #00c853 0%, #69f0ae 100%)',
  'tutorial': 'linear-gradient(135deg, #651fff 0%, #7c4dff 100%)',
  'festival': 'linear-gradient(135deg, #ff9100 0%, #ffd740 100%)',
  'slideshow': 'linear-gradient(135deg, #c51162 0%, #ff4081 100%)',
  'custom': 'linear-gradient(135deg, #546e7a 0%, #90a4ae 100%)',
};

/**
 * Individual template card for use in the TemplateMarket browser.
 */
const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  isSelected,
  onUse,
  onPreview,
}) => {
  const handleUse = useCallback((): void => {
    onUse(template);
  }, [template, onUse]);

  const handlePreview = useCallback((): void => {
    onPreview(template);
  }, [template, onPreview]);

  const categoryName: string = getCategoryName(template.category);
  const categoryColor = getCategoryColor(template.category);
  const bgGradient: string = CATEGORY_THUMBNAIL_BG[template.category] || CATEGORY_THUMBNAIL_BG.custom;

  return (
    <Card
      variant="outlined"
      sx={{
        transition: 'box-shadow 0.2s, border-color 0.2s',
        borderColor: isSelected ? 'primary.main' : 'divider',
        boxShadow: isSelected ? '0 0 0 2px #1976d2' : 'none',
        '&:hover': {
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        },
      }}
    >
      <CardActionArea onClick={handlePreview}>
        {/* Thumbnail area */}
        {template.thumbnail ? (
          <CardMedia
            component="img"
            height="120"
            image={template.thumbnail}
            alt={template.name}
            sx={{ objectFit: 'cover' }}
          />
        ) : (
          <Box
            sx={{
              height: 120,
              background: bgGradient,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Typography
              variant="h6"
              sx={{ color: '#fff', fontWeight: 700, textShadow: '0 1px 4px rgba(0,0,0,0.3)' }}
            >
              {template.name.substring(0, 6)}
            </Typography>
          </Box>
        )}

        <CardContent sx={{ pb: 0.5, pt: 1.5 }}>
          {/* Template name */}
          <Typography variant="subtitle2" noWrap fontWeight={600} sx={{ mb: 0.5 }}>
            {template.name}
          </Typography>

          {/* Description */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{
              mb: 1,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: 1.3,
            }}
          >
            {template.description || '暂无描述'}
          </Typography>

          {/* Meta info row */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              <AccessTimeIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                {formatDuration(template.totalDuration)}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.3 }}>
              <SegmentIcon sx={{ fontSize: 12, color: 'text.secondary' }} />
              <Typography variant="caption" color="text.secondary">
                {template.segments.length} 片段
              </Typography>
            </Box>
          </Box>

          {/* Category chip + builtin indicator */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Chip
              label={categoryName}
              size="small"
              color={categoryColor}
              variant="outlined"
              sx={{ height: 20, fontSize: 10 }}
            />
            <Tooltip title={template.isBuiltin ? '内置模板' : '自定义模板'}>
              {template.isBuiltin ? (
                <BookmarkIcon sx={{ fontSize: 14, color: 'warning.main' }} />
              ) : (
                <BuildIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              )}
            </Tooltip>
          </Box>
        </CardContent>
      </CardActionArea>

      <CardActions sx={{ pt: 0, px: 1.5, pb: 1 }}>
        <Box sx={{ flex: 1 }} />
        <Chip
          label="使用此模板"
          size="small"
          color="primary"
          variant="filled"
          onClick={handleUse}
          clickable
          sx={{ height: 24, fontSize: 11 }}
        />
      </CardActions>
    </Card>
  );
};

export default TemplateCard;
