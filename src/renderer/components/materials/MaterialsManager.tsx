/**
 * MaterialsManager component.
 *
 * Main container for the material management module. Composes:
 * - Toolbar: import button, view mode toggle, search box, filter dropdowns
 * - MaterialGrid or MaterialList (based on view mode)
 * - MaterialImportDialog
 * - MaterialDetail drawer
 *
 * This is the top-level component for Step 1 ("选择文件夹") of the workflow.
 */
import React, { useCallback, useMemo, useRef } from 'react';
import {
  Box,
  Button,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Chip,
  IconButton,
  Tooltip,
  Typography,
  InputAdornment,
  alpha,
} from '@mui/material';
import type { DragEvent } from 'react';
import AddIcon from '@mui/icons-material/Add';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import SearchIcon from '@mui/icons-material/Search';
import FilterListIcon from '@mui/icons-material/FilterList';
import DeleteSweepIcon from '@mui/icons-material/DeleteSweep';
import ClearIcon from '@mui/icons-material/Clear';
import type { SelectChangeEvent } from '@mui/material';

import ViewModeToggle from './ViewModeToggle';
import MaterialGrid from './MaterialGrid';
import MaterialList from './MaterialList';
import MaterialImportDialog from './MaterialImportDialog';
import MaterialDetail from './MaterialDetail';
import ProjectHistory from './ProjectHistory';
import {
  useMaterialsStore,
  type SortByField,
} from '@/renderer/store/materials-store';
import type {
  AnyMaterial,
  MaterialType,
  MaterialStatus,
} from '@/renderer/types/material';
import api from '@/renderer/api/backend-client';
import {
  formatFileSize,
  formatDuration,
} from '@/renderer/types/material';

/**
 * Top-level container for material management.
 *
 * Manages the orchestration of child components and delegates
 * state to the Zustand materials store.
 */
const MaterialsManager: React.FC = () => {
  // ─── Store ───────────────────────────────────────────────

  const materials = useMaterialsStore((s) => s.materials);
  const selectedIds = useMaterialsStore((s) => s.selectedIds);
  const filter = useMaterialsStore((s) => s.filter);
  const sort = useMaterialsStore((s) => s.sort);
  const isImportDialogOpen = useMaterialsStore((s) => s.isImportDialogOpen);
  const viewMode = useMaterialsStore((s) => s.viewMode);

  const addMaterials = useMaterialsStore((s) => s.addMaterials);
  const removeMaterial = useMaterialsStore((s) => s.removeMaterial);
  const removeMaterials = useMaterialsStore((s) => s.removeMaterials);
  const updateMaterial = useMaterialsStore((s) => s.updateMaterial);
  const clearAll = useMaterialsStore((s) => s.clearAll);
  const toggleSelect = useMaterialsStore((s) => s.toggleSelect);
  const selectSingle = useMaterialsStore((s) => s.selectSingle);
  const selectRange = useMaterialsStore((s) => s.selectRange);
  const selectAll = useMaterialsStore((s) => s.selectAll);
  const deselectAll = useMaterialsStore((s) => s.deselectAll);
  const setFilter = useMaterialsStore((s) => s.setFilter);
  const setSort = useMaterialsStore((s) => s.setSort);
  const setViewMode = useMaterialsStore((s) => s.setViewMode);
  const setImportDialogOpen = useMaterialsStore((s) => s.setImportDialogOpen);
  const getFilteredMaterials = useMaterialsStore((s) => s.getFilteredMaterials);

  // ─── Local State ─────────────────────────────────────────

  const [detailMaterial, setDetailMaterial] = React.useState<AnyMaterial | null>(null);
  const [detailOpen, setDetailOpen] = React.useState<boolean>(false);

  // ─── Drag-and-Drop State ─────────────────────────────────
  const [isDragOver, setIsDragOver] = React.useState<boolean>(false);
  const dragCounterRef = useRef<number>(0);

  // ─── Derived Data ────────────────────────────────────────

  const filteredMaterials: AnyMaterial[] = getFilteredMaterials();
  const filteredIds: string[] = useMemo(
    () => filteredMaterials.map((m: AnyMaterial) => m.id),
    [filteredMaterials]
  );

  // ─── Import Handling ─────────────────────────────────────

  const handleOpenImport = useCallback((): void => {
    setImportDialogOpen(true);
  }, [setImportDialogOpen]);

  const handleCloseImport = useCallback((): void => {
    setImportDialogOpen(false);
  }, [setImportDialogOpen]);

  /**
   * Process imported file paths: probe each file via backend API
   * and add valid materials to the store.
   */
  const handleImport = useCallback(
    async (filePaths: string[]): Promise<void> => {
      for (const filePath of filePaths) {
        // Determine type from extension
        const fileName: string = filePath.replace(/^.*[\\/]/, '');
        const ext = fileName.includes('.')
          ? `.${fileName.split('.').pop()?.toLowerCase()}`
          : '';

        // Create a temporary pending material
        const tempId: string = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        const tempMaterial: AnyMaterial = {
          id: tempId,
          fileName,
          filePath,
          type: 'video', // Will be updated after probe
          duration: '--:--',
          resolution: '--×--',
          size: '0 B',
          thumbnail: '',
          status: 'importing',
          addedAt: new Date().toISOString(),
        } as AnyMaterial;

        addMaterials([tempMaterial]);

        try {
          // Validate the file
          const validateResp = await api.post<{ valid: boolean; type: string }>(
            '/api/materials/validate',
            { file_path: filePath }
          );

          if (validateResp.code !== 0 || !validateResp.data?.valid) {
            updateMaterial(tempId, {
              status: 'error',
            });
            continue;
          }

          const materialType: MaterialType =
            (validateResp.data.type as MaterialType) || 'video';

          // Probe the file for metadata (non-fatal if probe fails)
          const probeResp = await api.post<Record<string, unknown>>(
            '/api/materials/probe',
            { file_path: filePath }
          );

          const probeData: Record<string, unknown> =
            (probeResp.code === 0 && probeResp.data) ? (probeResp.data as Record<string, unknown>) : {};

          const d = probeData;

          // Build updated material data
          const updatedFields: Partial<AnyMaterial> = {
            type: materialType,
            status: 'ready',
            duration: formatDuration((d.duration_seconds as number) || 0),
            resolution: `${d.width || 0}×${d.height || 0}`,
            size: formatFileSize((d.file_size as number) || 0),
          };

          if (materialType === 'video') {
            Object.assign(updatedFields, {
              durationSeconds: (d.duration_seconds as number) || 0,
              fps: (d.fps as number) || 0,
              codec: (d.codec as string) || 'unknown',
              bitrate: (d.bitrate as number) || 0,
              width: (d.width as number) || 0,
              height: (d.height as number) || 0,
            });
          } else {
            Object.assign(updatedFields, {
              width: (d.width as number) || 0,
              height: (d.height as number) || 0,
              format: (d.format as string) || 'unknown',
            });
          }

          updateMaterial(tempId, updatedFields);

          // Request thumbnail generation
          const thumbResp = await api.get<{ thumbnail: string }>(
            `/api/materials/thumbnail/${tempId}?file_path=${encodeURIComponent(filePath)}`
          );

          if (thumbResp.code === 0 && thumbResp.data?.thumbnail) {
            updateMaterial(tempId, {
              thumbnail: `data:image/jpeg;base64,${thumbResp.data.thumbnail}`,
            });
          }
        } catch (err) {
          updateMaterial(tempId, {
            status: 'error',
          });
        }
      }

      setImportDialogOpen(false);
    },
    [addMaterials, updateMaterial, setImportDialogOpen]
  );

  // ─── Card/Row Click Handling ─────────────────────────────

  const handleCardClick = useCallback(
    (materialId: string, event: React.MouseEvent): void => {
      const isCtrl: boolean = event.ctrlKey || event.metaKey;
      const isShift: boolean = event.shiftKey;

      if (isShift && selectedIds.size > 0) {
        selectRange(materialId, filteredIds);
      } else if (isCtrl) {
        selectSingle(materialId, true);
      } else {
        selectSingle(materialId, false);
      }
    },
    [selectedIds, filteredIds, selectRange, selectSingle]
  );

  const handleCheckToggle = useCallback(
    (materialId: string): void => {
      toggleSelect(materialId);
    },
    [toggleSelect]
  );

  // ─── Delete Handling ─────────────────────────────────────

  const handleDelete = useCallback(
    (materialId: string): void => {
      removeMaterial(materialId);
      if (detailMaterial?.id === materialId) {
        setDetailMaterial(null);
        setDetailOpen(false);
      }
    },
    [removeMaterial, detailMaterial]
  );

  const handleDeleteSelected = useCallback((): void => {
    removeMaterials(Array.from(selectedIds));
  }, [selectedIds, removeMaterials]);

  // ─── Detail Panel ────────────────────────────────────────

  const handleViewDetail = useCallback(
    (materialId: string): void => {
      const m = materials.find((mat: AnyMaterial) => mat.id === materialId);
      if (m) {
        setDetailMaterial(m);
        setDetailOpen(true);
      }
    },
    [materials]
  );

  const handleCloseDetail = useCallback((): void => {
    setDetailOpen(false);
    setDetailMaterial(null);
  }, []);

  // ─── Sort Change ─────────────────────────────────────────

  const handleSortChange = useCallback(
    (field: SortByField): void => {
      if (sort.sortBy === field) {
        setSort({ sortDirection: sort.sortDirection === 'asc' ? 'desc' : 'asc' });
      } else {
        setSort({ sortBy: field, sortDirection: 'asc' });
      }
    },
    [sort, setSort]
  );

  // ─── Select All ──────────────────────────────────────────

  const handleSelectAll = useCallback((): void => {
    if (selectedIds.size === filteredIds.length) {
      deselectAll();
    } else {
      selectAll(filteredIds);
    }
  }, [selectedIds, filteredIds, deselectAll, selectAll]);

  // ─── Filter Handlers ─────────────────────────────────────

  const handleFilterTypeChange = useCallback(
    (event: SelectChangeEvent): void => {
      setFilter({ filterType: event.target.value as MaterialType | 'all' });
    },
    [setFilter]
  );

  const handleFilterStatusChange = useCallback(
    (event: SelectChangeEvent): void => {
      setFilter({ filterStatus: event.target.value as MaterialStatus | 'all' });
    },
    [setFilter]
  );

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>): void => {
      setFilter({ searchQuery: event.target.value });
    },
    [setFilter]
  );

  const handleClearFilters = useCallback((): void => {
    setFilter({
      filterType: 'all',
      filterStatus: 'all',
      searchQuery: '',
    });
  }, [setFilter]);

  const hasActiveFilters: boolean =
    filter.filterType !== 'all' ||
    filter.filterStatus !== 'all' ||
    filter.searchQuery.trim() !== '';

  // ─── Drag-and-Drop Handlers ───────────────────────────────

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      const filePaths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i] as File & { path?: string };
        if (file.path) {
          filePaths.push(file.path);
        }
      }

      if (filePaths.length > 0) {
        handleImport(filePaths);
      }
    },
    [handleImport]
  );

  // ─── Render ──────────────────────────────────────────────

  return (
    <Box
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 2,
        position: 'relative',
      }}
    >
      {/* ── Drag Overlay ────────────────────────────────── */}
      {isDragOver && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: (theme) => alpha(theme.palette.primary.main, 0.12),
            border: '3px dashed',
            borderColor: 'primary.main',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        >
          <CloudUploadIcon sx={{ fontSize: 64, color: 'primary.main', mb: 1 }} />
          <Typography variant="h6" color="primary.main" fontWeight="bold">
            释放以导入素材
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            支持 MP4、MOV、AVI、WebM 等视频格式
          </Typography>
        </Box>
      )}

      {/* ── Toolbar ─────────────────────────────────────── */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1.5,
          flexWrap: 'wrap',
        }}
      >
        {/* Import button */}
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={handleOpenImport}
          size="small"
        >
          导入素材
        </Button>

        {/* Selected count + batch delete */}
        {selectedIds.size > 0 && (
          <>
            <Chip
              label={`已选 ${selectedIds.size} 项`}
              size="small"
              onDelete={deselectAll}
            />
            <Tooltip title="删除选中">
              <IconButton
                size="small"
                color="error"
                onClick={handleDeleteSelected}
              >
                <DeleteSweepIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </>
        )}

        {/* Spacer */}
        <Box sx={{ flex: 1 }} />

        {/* Search */}
        <TextField
          size="small"
          placeholder="搜索素材..."
          value={filter.searchQuery}
          onChange={handleSearchChange}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: filter.searchQuery ? (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  onClick={() => setFilter({ searchQuery: '' })}
                >
                  <ClearIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : null,
          }}
          sx={{ width: 200 }}
        />

        {/* Type filter */}
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>类型</InputLabel>
          <Select
            value={filter.filterType}
            label="类型"
            onChange={handleFilterTypeChange}
          >
            <MenuItem value="all">全部</MenuItem>
            <MenuItem value="video">视频</MenuItem>
            <MenuItem value="image">图片</MenuItem>
          </Select>
        </FormControl>

        {/* Status filter */}
        <FormControl size="small" sx={{ minWidth: 100 }}>
          <InputLabel>状态</InputLabel>
          <Select
            value={filter.filterStatus}
            label="状态"
            onChange={handleFilterStatusChange}
          >
            <MenuItem value="all">全部</MenuItem>
            <MenuItem value="ready">就绪</MenuItem>
            <MenuItem value="importing">导入中</MenuItem>
            <MenuItem value="pending">等待中</MenuItem>
            <MenuItem value="error">失败</MenuItem>
          </Select>
        </FormControl>

        {/* Clear filters */}
        {hasActiveFilters && (
          <Tooltip title="清除筛选">
            <IconButton size="small" onClick={handleClearFilters}>
              <FilterListIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}

        {/* View mode toggle */}
        <ViewModeToggle viewMode={viewMode} onViewModeChange={setViewMode} />

        {/* Material count */}
        <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
          {materials.length} 个素材
          {hasActiveFilters && ` (显示 ${filteredMaterials.length} 个)`}
        </Typography>
      </Box>

      {/* ── Main Content ────────────────────────────────── */}
      {viewMode === 'grid' ? (
        <MaterialGrid
          materials={filteredMaterials}
          selectedIds={selectedIds}
          onCardClick={handleCardClick}
          onCheckToggle={handleCheckToggle}
          onDelete={handleDelete}
          onViewDetail={handleViewDetail}
        />
      ) : (
        <MaterialList
          materials={filteredMaterials}
          selectedIds={selectedIds}
          sortBy={sort.sortBy}
          sortDirection={sort.sortDirection}
          onSortChange={handleSortChange}
          onRowClick={handleCardClick}
          onCheckToggle={handleCheckToggle}
          onSelectAll={handleSelectAll}
          onDelete={handleDelete}
          onViewDetail={handleViewDetail}
        />
      )}

      {/* ── Import Dialog ───────────────────────────────── */}
      <MaterialImportDialog
        open={isImportDialogOpen}
        onClose={handleCloseImport}
        onImport={handleImport}
      />

      {/* ── Project History ────────────────────────────── */}
      <Box sx={{ mt: 3 }}>
        <ProjectHistory />
      </Box>

      {/* ── Detail Drawer ───────────────────────────────── */}
      <MaterialDetail
        material={detailMaterial}
        open={detailOpen}
        onClose={handleCloseDetail}
        onDelete={handleDelete}
      />
    </Box>
  );
};

export default MaterialsManager;
