/**
 * TemplateMarket component.
 *
 * Browser for preset and custom templates with category filtering,
 * search, and card grid display.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Box,
  TextField,
  Chip,
  Typography,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  InputAdornment,
  IconButton,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import CloseIcon from '@mui/icons-material/Close';
import TemplateCard from './TemplateCard';
import { useTemplateStore } from '@/renderer/store/template-store';
import type { Template } from '@/renderer/types/template';
import { TEMPLATE_CATEGORIES } from '@/renderer/types/template';
import type { TemplateCategory } from '@/renderer/types/template';

interface TemplateMarketProps {
  /** Whether the market dialog is open */
  open: boolean;
  /** Close handler */
  onClose: () => void;
}

/**
 * Template market browser component.
 *
 * Displays all available templates in a card grid with category
 * chip filtering and text search. Users can preview a template
 * and click "use" to copy it as the current editing template.
 */
const TemplateMarket: React.FC<TemplateMarketProps> = ({
  open,
  onClose,
}) => {
  const templates = useTemplateStore((s) => s.templates);
  const loadAll = useTemplateStore((s) => s.loadAll);
  const loadBuiltin = useTemplateStore((s) => s.loadBuiltin);
  const useTemplate = useTemplateStore((s) => s.useTemplate);
  const setCurrentTemplate = useTemplateStore((s) => s.setCurrentTemplate);
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [previewTemplate, setPreviewTemplate] = useState<Template | null>(null);

  // Load templates on mount
  useEffect(() => {
    if (open) {
      setLoading(true);
      Promise.all([loadAll(), loadBuiltin()]).finally(() => setLoading(false));
    }
  }, [open, loadAll, loadBuiltin]);

  // Filter templates by category and search
  const filteredTemplates: Template[] = useMemo(() => {
    let results: Template[] = templates;

    if (activeCategory !== 'all') {
      results = results.filter((t: Template) => t.category === activeCategory);
    }

    if (searchQuery.trim()) {
      const q: string = searchQuery.trim().toLowerCase();
      results = results.filter(
        (t: Template) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag: string) => tag.toLowerCase().includes(q)),
      );
    }

    return results;
  }, [templates, activeCategory, searchQuery]);

  const handleCategoryClick = useCallback((categoryId: string): void => {
    setActiveCategory(categoryId);
  }, []);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      setSearchQuery(e.target.value);
    },
    [],
  );

  const handleClearSearch = useCallback((): void => {
    setSearchQuery('');
  }, []);

  const handleUse = useCallback(
    (template: Template): void => {
      useTemplate(template);
      onClose();
    },
    [useTemplate, onClose],
  );

  const handlePreview = useCallback(
    (template: Template): void => {
      setPreviewTemplate(template);
    },
    [],
  );

  const handleClosePreview = useCallback((): void => {
    setPreviewTemplate(null);
  }, []);

  // Category counts
  const categoryCounts: Record<string, number> = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const cat of TEMPLATE_CATEGORIES) {
      if (cat.id === 'all') {
        counts[cat.id] = templates.length;
      } else {
        counts[cat.id] = templates.filter((t: Template) => t.category === cat.id).length;
      }
    }
    return counts;
  }, [templates]);

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        maxWidth="md"
        fullWidth
        PaperProps={{ sx: { height: '85vh' } }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6" fontWeight={600}>
              模板市场
            </Typography>
            <IconButton size="small" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>

        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: '8px !important' }}>
          {/* Search bar */}
          <TextField
            size="small"
            placeholder="搜索模板名称、描述或标签..."
            value={searchQuery}
            onChange={handleSearchChange}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              endAdornment: searchQuery ? (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={handleClearSearch}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ) : null,
            }}
          />

          {/* Category chips */}
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {TEMPLATE_CATEGORIES.map((cat: TemplateCategory) => (
              <Chip
                key={cat.id}
                label={`${cat.name} (${categoryCounts[cat.id] ?? 0})`}
                size="small"
                color={activeCategory === cat.id ? 'primary' : 'default'}
                variant={activeCategory === cat.id ? 'filled' : 'outlined'}
                onClick={() => handleCategoryClick(cat.id)}
                clickable
              />
            ))}
          </Box>

          {/* Templates grid */}
          {loading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={32} />
            </Box>
          ) : filteredTemplates.length === 0 ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6 }}>
              <Typography variant="body2" color="text.secondary">
                没有找到匹配的模板
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 2,
                pb: 2,
                overflowY: 'auto',
                flex: 1,
              }}
            >
              {filteredTemplates.map((template: Template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  isSelected={false}
                  onUse={handleUse}
                  onPreview={handlePreview}
                />
              ))}
            </Box>
          )}
        </DialogContent>
      </Dialog>

      {/* Preview dialog */}
      <Dialog open={!!previewTemplate} onClose={handleClosePreview} maxWidth="sm" fullWidth>
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="h6">{previewTemplate?.name || ''}</Typography>
            <IconButton size="small" onClick={handleClosePreview}>
              <CloseIcon />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent>
          {previewTemplate && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Typography variant="body2">{previewTemplate.description}</Typography>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                <Chip
                  label={`${previewTemplate.segments.length} 个片段`}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  label={`总时长 ${previewTemplate.totalDuration.toFixed(1)}s`}
                  size="small"
                  variant="outlined"
                />
                {previewTemplate.tags.map((tag: string) => (
                  <Chip key={tag} label={tag} size="small" variant="outlined" />
                ))}
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Chip
                  label="使用此模板"
                  color="primary"
                  clickable
                  onClick={() => {
                    if (previewTemplate) {
                      handleUse(previewTemplate);
                    }
                  }}
                />
              </Box>
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TemplateMarket;
