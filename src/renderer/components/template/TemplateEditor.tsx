/**
 * TemplateEditor component.
 *
 * Main container for the template editing workspace (Step 3 — "模板匹配").
 * Integrates all sub-components:
 * - Top toolbar (template name, save, duplicate, undo/redo, market button)
 * - Three-column layout (SegmentEditor | Timeline + Preview | TransitionPicker)
 * - Responsive: collapses to tab-based navigation on small screens
 * - TemplateMarket dialog
 * - Import/Export functionality
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  IconButton,
  Tooltip,
  Divider,
  Paper,
  Snackbar,
  Alert,
  Tabs,
  Tab,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import UndoIcon from '@mui/icons-material/Replay';
import RedoIcon from '@mui/icons-material/Redo';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import StorefrontIcon from '@mui/icons-material/Storefront';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import TimelineIcon from '@mui/icons-material/Schedule';
import SettingsIcon from '@mui/icons-material/Settings';
import PlayCircleIcon from '@mui/icons-material/PlayCircle';

import { useTemplateStore } from '@/renderer/store/template-store';
import SegmentEditor from './SegmentEditor';
import TemplateTimeline from './TemplateTimeline';
import TemplatePreview from './TemplatePreview';
import TransitionPicker from './TransitionPicker';
import TemplateMarket from './TemplateMarket';
import type { Template, Transition } from '@/renderer/types/template';

/**
 * Tab names for responsive collapsed mode.
 */
const RESPONSIVE_TABS: string[] = ['时间轴', '片段属性', '转场'];

/**
 * Template editor main container.
 *
 * Three-column layout:
 * - Left: SegmentEditor (segment property panel)
 * - Center: TemplateTimeline + TemplatePreview
 * - Right: TransitionPicker (transition editor)
 */
const TemplateEditor: React.FC = () => {
  const theme = useTheme();
  const isNarrow: boolean = useMediaQuery(theme.breakpoints.down('lg'));

  // Store
  const currentTemplate = useTemplateStore((s) => s.currentTemplate);
  const isDirty = useTemplateStore((s) => s.isDirty);
  const isEditing = useTemplateStore((s) => s.isEditing);
  const isMarketOpen = useTemplateStore((s) => s.isMarketOpen);
  const canUndo = useTemplateStore((s) => s.canUndo);
  const canRedo = useTemplateStore((s) => s.canRedo);

  const create = useTemplateStore((s) => s.create);
  const save = useTemplateStore((s) => s.save);
  const duplicate = useTemplateStore((s) => s.duplicate);
  const undo = useTemplateStore((s) => s.undo);
  const redo = useTemplateStore((s) => s.redo);
  const addSegment = useTemplateStore((s) => s.addSegment);
  const deleteCurrent = useTemplateStore((s) => s.deleteCurrent);
  const updateTemplateMeta = useTemplateStore((s) => s.updateTemplateMeta);
  const setTemplateTransition = useTemplateStore((s) => s.setTemplateTransition);
  const setMarketOpen = useTemplateStore((s) => s.setMarketOpen);
  const exportJson = useTemplateStore((s) => s.exportJson);
  const importJson = useTemplateStore((s) => s.importJson);

  const template = currentTemplate();

  // Local state
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' | 'info' }>({
    open: false,
    message: '',
    severity: 'info',
  });
  const [responsiveTab, setResponsiveTab] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ─── Toolbar Handlers ─────────────────────────────────

  const handleCreate = useCallback((): void => {
    create();
    setSnackbar({ open: true, message: '已创建新模板', severity: 'success' });
  }, [create]);

  const handleSave = useCallback(async (): Promise<void> => {
    const ok: boolean = await save();
    if (ok) {
      setSnackbar({ open: true, message: '模板已保存', severity: 'success' });
    } else {
      setSnackbar({ open: true, message: '保存失败，请重试', severity: 'error' });
    }
  }, [save]);

  const handleDuplicate = useCallback(async (): Promise<void> => {
    await duplicate();
    setSnackbar({ open: true, message: '模板已复制', severity: 'success' });
  }, [duplicate]);

  const handleUndo = useCallback((): void => {
    undo();
  }, [undo]);

  const handleRedo = useCallback((): void => {
    redo();
  }, [redo]);

  const handleAddSegment = useCallback((): void => {
    // Auto-create template if none exists
    if (!currentTemplate()) {
      create();
    }
    addSegment();
  }, [addSegment, create, currentTemplate]);

  const handleDeleteTemplate = useCallback(async (): Promise<void> => {
    await deleteCurrent();
    setSnackbar({ open: true, message: '模板已删除', severity: 'info' });
  }, [deleteCurrent]);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      updateTemplateMeta({ name: e.target.value });
    },
    [updateTemplateMeta],
  );

  const handleDescriptionChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      updateTemplateMeta({ description: e.target.value });
    },
    [updateTemplateMeta],
  );

  const handleTransitionChange = useCallback(
    (transition: Transition): void => {
      setTemplateTransition(transition);
    },
    [setTemplateTransition],
  );

  const handleOpenMarket = useCallback((): void => {
    setMarketOpen(true);
  }, [setMarketOpen]);

  const handleCloseMarket = useCallback((): void => {
    setMarketOpen(false);
  }, [setMarketOpen]);

  const handleExport = useCallback((): void => {
    const jsonStr: string = exportJson();
    const blob: Blob = new Blob([jsonStr], { type: 'application/json' });
    const url: string = URL.createObjectURL(blob);
    const a: HTMLAnchorElement = document.createElement('a');
    a.href = url;
    a.download = `${template?.name || 'template'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setSnackbar({ open: true, message: '模板已导出为 JSON 文件', severity: 'success' });
  }, [exportJson, template?.name]);

  const handleImportClick = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const handleImportFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const file: File | undefined = e.target.files?.[0];
      if (!file) return;

      const reader: FileReader = new FileReader();
      reader.onload = (): void => {
        const text: string = reader.result as string;
        importJson(text);
        setSnackbar({ open: true, message: '模板已导入', severity: 'success' });
      };
      reader.onerror = (): void => {
        setSnackbar({ open: true, message: '文件读取失败', severity: 'error' });
      };
      reader.readAsText(file);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [importJson],
  );

  const handleCloseSnackbar = useCallback((): void => {
    setSnackbar((prev) => ({ ...prev, open: false }));
  }, []);

  const handleResponsiveTabChange = useCallback(
    (_event: React.SyntheticEvent, newValue: number): void => {
      setResponsiveTab(newValue);
    },
    [],
  );

  // ─── No Template State ────────────────────────────────

  if (!isEditing || !template) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 280,
          gap: 2,
        }}
      >
        <Typography variant="h6" color="text.secondary">
          未选择模板
        </Typography>
        <Typography variant="body2" color="text.secondary">
          创建一个新模板或从模板市场中选取一个预设模板
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="contained" onClick={handleCreate} startIcon={<AddIcon />}>
            新建模板
          </Button>
          <Button variant="outlined" onClick={handleOpenMarket} startIcon={<StorefrontIcon />}>
            模板市场
          </Button>
        </Box>
      </Box>
    );
  }

  // ─── Render ───────────────────────────────────────────

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
      {/* ── Toolbar ───────────────────────────────────── */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {/* Template name */}
          <TextField
            size="small"
            value={template.name}
            onChange={handleNameChange}
            placeholder="模板名称"
            sx={{ minWidth: 180, flex: { xs: '1 1 100%', sm: '0 1 auto' } }}
            InputProps={{ sx: { fontWeight: 600 } }}
          />

          {/* Description */}
          <TextField
            size="small"
            value={template.description}
            onChange={handleDescriptionChange}
            placeholder="模板描述（可选）"
            sx={{ minWidth: 160, flex: { xs: '1 1 100%', sm: '1 1 auto' } }}
          />

          <Box sx={{ flex: 1 }} />

          {/* Action buttons */}
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Tooltip title="撤销 (Ctrl+Z)">
              <span>
                <IconButton size="small" onClick={handleUndo} disabled={!canUndo()}>
                  <UndoIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="重做 (Ctrl+Y)">
              <span>
                <IconButton size="small" onClick={handleRedo} disabled={!canRedo()}>
                  <RedoIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Box>

          <Divider orientation="vertical" flexItem />

          <Tooltip title="保存">
            <Button
              size="small"
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={handleSave}
              color={isDirty ? 'primary' : 'inherit'}
              sx={{ color: isDirty ? undefined : 'text.secondary' }}
            >
              保存{isDirty && ' *'}
            </Button>
          </Tooltip>

          <Tooltip title="另存为副本">
            <IconButton size="small" onClick={handleDuplicate}>
              <ContentCopyIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="导出 JSON">
            <IconButton size="small" onClick={handleExport}>
              <FileDownloadIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <Tooltip title="导入 JSON">
            <IconButton size="small" onClick={handleImportClick}>
              <FileUploadIcon fontSize="small" />
            </IconButton>
          </Tooltip>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleImportFile}
          />

          <Divider orientation="vertical" flexItem />

          <Tooltip title="从模板市场选择">
            <Button
              size="small"
              variant="outlined"
              startIcon={<StorefrontIcon />}
              onClick={handleOpenMarket}
            >
              模板市场
            </Button>
          </Tooltip>

          <Tooltip title="删除模板">
            <IconButton size="small" color="error" onClick={handleDeleteTemplate}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      </Paper>

      {/* ── Main Content ───────────────────────────────── */}
      {isNarrow ? (
        /* ── Narrow: Tabbed Layout ──────────────────── */
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Tabs
            value={responsiveTab}
            onChange={handleResponsiveTabChange}
            variant="fullWidth"
            sx={{ borderBottom: 1, borderColor: 'divider' }}
          >
            <Tab icon={<TimelineIcon />} label="时间轴" iconPosition="start" />
            <Tab icon={<SettingsIcon />} label="片段属性" iconPosition="start" />
          </Tabs>

          {responsiveTab === 0 && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* Add segment button */}
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AddIcon />}
                  onClick={handleAddSegment}
                  disabled={template.segments.length >= 100}
                >
                  添加片段
                </Button>
              </Box>
              <TemplateTimeline />
              <TemplatePreview />
              <TransitionPicker
                transition={template.transition}
                label="默认转场效果"
                onChange={handleTransitionChange}
              />
            </Box>
          )}

          {responsiveTab === 1 && <SegmentEditor />}
        </Box>
      ) : (
        /* ── Wide: Three-Column Layout ───────────────── */
        <Box
          sx={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: '280px 1fr 220px',
            gap: 2,
            minHeight: 0,
          }}
        >
          {/* Left: SegmentEditor */}
          <Box sx={{ overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
            <SegmentEditor />
          </Box>

          {/* Center: Timeline + Preview */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
            {/* Add segment button bar */}
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                size="small"
                variant="outlined"
                startIcon={<AddIcon />}
                onClick={handleAddSegment}
                disabled={template.segments.length >= 100}
              >
                添加片段
              </Button>
              <Typography variant="caption" color="text.secondary">
                拖拽片段进行排序 | 右键片段查看更多操作 | Delete 删除选中片段
              </Typography>
            </Box>

            <TemplateTimeline />
            <TemplatePreview />
          </Box>

          {/* Right: TransitionPicker */}
          <Box sx={{ overflowY: 'auto', maxHeight: 'calc(100vh - 280px)' }}>
            <TransitionPicker
              transition={template.transition}
              label="默认转场效果"
              onChange={handleTransitionChange}
            />
          </Box>
        </Box>
      )}

      {/* ── Template Market Dialog ─────────────────────── */}
      <TemplateMarket open={isMarketOpen} onClose={handleCloseMarket} />

      {/* ── Snackbar ───────────────────────────────────── */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={handleCloseSnackbar}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          onClose={handleCloseSnackbar}
          severity={snackbar.severity}
          variant="filled"
          sx={{ width: '100%' }}
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default TemplateEditor;
