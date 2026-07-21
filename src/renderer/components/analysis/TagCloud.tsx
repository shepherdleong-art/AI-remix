/**
 * TagCloud — Smart tag cloud with category grouping and clickable filter.
 *
 * Displays tags grouped by category (content/style/technical/scene)
 * using MUI Chips in a flowing layout. Clicking a tag toggles it as
 * an active filter.
 */
import React from 'react';
import {
  Box,
  Chip,
  Typography,
  Paper,
  Divider,
} from '@mui/material';
import type { Tag, TagCategory } from '@/renderer/types/analysis';
import { TAG_CATEGORY_LABELS } from '@/renderer/types/analysis';

// ─── Props ──────────────────────────────────────────────────

export interface TagCloudProps {
  /** All tags to display */
  tags: Tag[];
  /** Set of currently active/filtered tag IDs */
  activeFilterTags: string[];
  /** Callback when a tag is clicked/toggled */
  onTagClick?: (tagId: string) => void;
  /** Whether there are no tags */
  isEmpty?: boolean;
  /** Loading state */
  isLoading?: boolean;
}

// ─── Category Sorting ──────────────────────────────────────

const CATEGORY_ORDER: TagCategory[] = ['content', 'style', 'technical', 'scene'];

// ─── Component ──────────────────────────────────────────────

const TagCloud: React.FC<TagCloudProps> = ({
  tags,
  activeFilterTags,
  onTagClick,
  isEmpty = false,
  isLoading = false,
}) => {
  // Empty state
  if (isEmpty) {
    return (
      <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="body1" gutterBottom>
          暂无标签数据
        </Typography>
        <Typography variant="body2">请先分析素材以生成智能标签</Typography>
      </Box>
    );
  }

  // Loading state
  if (isLoading) {
    return (
      <Box sx={{ py: 4, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          正在生成标签...
        </Typography>
      </Box>
    );
  }

  // No tags
  if (tags.length === 0) {
    return (
      <Box sx={{ py: 4, textAlign: 'center', color: 'text.secondary' }}>
        <Typography variant="body2">该素材未生成标签</Typography>
      </Box>
    );
  }

  // Group tags by category
  const grouped = new Map<TagCategory, Tag[]>();
  for (const cat of CATEGORY_ORDER) {
    grouped.set(cat, []);
  }
  for (const tag of tags) {
    const arr = grouped.get(tag.category);
    if (arr) {
      arr.push(tag);
    } else {
      // Uncategorized — put in 'content'
      const contentArr = grouped.get('content')!;
      contentArr.push(tag);
    }
  }

  return (
    <Box>
      {CATEGORY_ORDER.map((category: TagCategory) => {
        const categoryTags = grouped.get(category) || [];
        if (categoryTags.length === 0) return null;

        return (
          <Box key={category} sx={{ mb: 2 }}>
            <Typography
              variant="caption"
              fontWeight={600}
              color="text.secondary"
              sx={{
                textTransform: 'uppercase',
                letterSpacing: 1,
                mb: 0.5,
                display: 'block',
              }}
            >
              {TAG_CATEGORY_LABELS[category]}
            </Typography>
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 1,
              }}
            >
              {categoryTags.map((tag: Tag) => {
                const isActive = activeFilterTags.includes(tag.id);
                return (
                  <Chip
                    key={tag.id}
                    label={tag.label}
                    size="small"
                    variant={isActive ? 'filled' : 'outlined'}
                    color={isActive ? 'primary' : 'default'}
                    onClick={() => onTagClick?.(tag.id)}
                    clickable
                    sx={{
                      fontWeight: isActive ? 600 : 400,
                      transition: 'all 0.2s',
                      '&:hover': {
                        transform: 'scale(1.05)',
                      },
                    }}
                  />
                );
              })}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};

export default TagCloud;
