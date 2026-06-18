/**
 * MaterialList component.
 *
 * Displays materials in a MUI Table-based list view with columns:
 * - Thumbnail / File Name / Type / Duration / Resolution / Size / Status / Actions
 *
 * Supports row selection, right-click context menu, and action buttons.
 */
import React, { useCallback } from 'react';
import {
  Box,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Checkbox,
  IconButton,
  Typography,
  Chip,
  Paper,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
  Tooltip,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import InfoIcon from '@mui/icons-material/Info';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VideocamIcon from '@mui/icons-material/Videocam';
import ImageIcon from '@mui/icons-material/Image';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import type { AnyMaterial, MaterialStatus } from '@/renderer/types/material';
import type { SortByField, SortDirection } from '@/renderer/store/materials-store';

export interface MaterialListProps {
  /** Filtered and sorted materials to display */
  materials: AnyMaterial[];
  /** Set of selected material IDs */
  selectedIds: Set<string>;
  /** Current sort field */
  sortBy: SortByField;
  /** Current sort direction */
  sortDirection: SortDirection;
  /** Called when a sort column header is clicked */
  onSortChange: (field: SortByField) => void;
  /** Called when a row is clicked */
  onRowClick: (materialId: string, event: React.MouseEvent) => void;
  /** Called when the row checkbox is toggled */
  onCheckToggle: (materialId: string) => void;
  /** Called to select/deselect all */
  onSelectAll: () => void;
  /** Called to delete a material */
  onDelete: (materialId: string) => void;
  /** Called to view material details */
  onViewDetail: (materialId: string) => void;
}

/** Column definition for the table header */
interface ColumnDef {
  id: SortByField | 'actions';
  label: string;
  sortable: boolean;
  width?: string;
  align?: 'left' | 'center' | 'right';
}

const COLUMNS: ColumnDef[] = [
  { id: 'name', label: '文件名', sortable: true, width: '25%' },
  { id: 'type', label: '类型', sortable: true, width: '8%', align: 'center' },
  { id: 'name', label: '时长', sortable: false, width: '10%', align: 'center' },
  { id: 'name', label: '分辨率', sortable: false, width: '12%', align: 'center' },
  { id: 'size', label: '大小', sortable: true, width: '10%', align: 'right' },
  { id: 'date', label: '状态', sortable: false, width: '10%', align: 'center' },
  { id: 'actions', label: '操作', sortable: false, width: '8%', align: 'center' },
];

/** Map status to display label */
const STATUS_LABELS: Record<MaterialStatus, string> = {
  pending: '等待中',
  importing: '导入中',
  ready: '就绪',
  error: '失败',
  processing: '处理中',
};

/** Map status to MUI chip color */
const STATUS_COLORS: Record<MaterialStatus, 'default' | 'info' | 'success' | 'warning' | 'error'> = {
  pending: 'default',
  importing: 'info',
  ready: 'success',
  error: 'error',
  processing: 'warning',
};

/**
 * Table-based material list view.
 *
 * Features:
 * - Sortable column headers
 * - Row selection with checkboxes
 * - Per-row action menu (MoreVert button)
 * - Empty state placeholder
 */
const MaterialList: React.FC<MaterialListProps> = ({
  materials,
  selectedIds,
  sortBy,
  sortDirection,
  onSortChange,
  onRowClick,
  onCheckToggle,
  onSelectAll,
  onDelete,
  onViewDetail,
}) => {
  const [actionMenuAnchor, setActionMenuAnchor] = React.useState<{
    element: HTMLElement;
    materialId: string;
  } | null>(null);

  const handleActionClick = useCallback(
    (event: React.MouseEvent<HTMLElement>, materialId: string): void => {
      event.stopPropagation();
      setActionMenuAnchor({ element: event.currentTarget, materialId });
    },
    []
  );

  const handleActionClose = useCallback((): void => {
    setActionMenuAnchor(null);
  }, []);

  const handleDeleteAction = useCallback((): void => {
    if (actionMenuAnchor) {
      onDelete(actionMenuAnchor.materialId);
      setActionMenuAnchor(null);
    }
  }, [actionMenuAnchor, onDelete]);

  const handleDetailAction = useCallback((): void => {
    if (actionMenuAnchor) {
      onViewDetail(actionMenuAnchor.materialId);
      setActionMenuAnchor(null);
    }
  }, [actionMenuAnchor, onViewDetail]);

  const allSelected: boolean =
    materials.length > 0 && selectedIds.size === materials.length;
  const someSelected: boolean =
    selectedIds.size > 0 && selectedIds.size < materials.length;

  // Empty state
  if (materials.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 300,
          color: 'text.secondary',
          py: 6,
        }}
      >
        <VideoLibraryIcon sx={{ fontSize: 64, mb: 2, color: 'grey.400' }} />
        <Typography variant="h6" color="text.secondary" gutterBottom>
          暂无素材
        </Typography>
        <Typography variant="body2" color="text.secondary">
          点击"导入素材"按钮或拖拽文件到此处开始添加
        </Typography>
      </Box>
    );
  }

  const sortableFields: SortByField[] = ['name', 'type', 'size', 'date'];
  const isSortable = (id: string): id is SortByField =>
    sortableFields.includes(id as SortByField);

  return (
    <TableContainer component={Paper} variant="outlined" sx={{ flex: 1 }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell padding="checkbox" sx={{ width: 48 }}>
              <Checkbox
                indeterminate={someSelected}
                checked={allSelected}
                onChange={onSelectAll}
                size="small"
              />
            </TableCell>
            {COLUMNS.map((col: ColumnDef) => (
              <TableCell
                key={col.id}
                align={col.align || 'left'}
                sx={{ width: col.width, fontWeight: 600 }}
              >
                {col.sortable && isSortable(col.id) ? (
                  <TableSortLabel
                    active={sortBy === col.id}
                    direction={sortBy === col.id ? sortDirection : 'asc'}
                    onClick={() => onSortChange(col.id as SortByField)}
                  >
                    {col.label}
                  </TableSortLabel>
                ) : (
                  col.label
                )}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {materials.map((material: AnyMaterial) => {
            const isItemSelected: boolean = selectedIds.has(material.id);

            return (
              <TableRow
                key={material.id}
                hover
                selected={isItemSelected}
                onClick={(event: React.MouseEvent) => onRowClick(material.id, event)}
                sx={{ cursor: 'pointer' }}
              >
                {/* Checkbox */}
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={isItemSelected}
                    onClick={(e: React.MouseEvent) => {
                      e.stopPropagation();
                      onCheckToggle(material.id);
                    }}
                    size="small"
                  />
                </TableCell>

                {/* File name with thumbnail icon */}
                <TableCell>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    {material.thumbnail ? (
                      <Box
                        component="img"
                        src={material.thumbnail}
                        alt={material.fileName}
                        sx={{
                          width: 36,
                          height: 36,
                          borderRadius: 0.5,
                          objectFit: 'cover',
                          flexShrink: 0,
                        }}
                      />
                    ) : (
                      <Box
                        sx={{
                          width: 36,
                          height: 36,
                          borderRadius: 0.5,
                          bgcolor: 'grey.200',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {material.type === 'video' ? (
                          <VideocamIcon sx={{ fontSize: 18, color: 'grey.500' }} />
                        ) : (
                          <ImageIcon sx={{ fontSize: 18, color: 'grey.500' }} />
                        )}
                      </Box>
                    )}
                    <Typography variant="body2" noWrap title={material.fileName}>
                      {material.fileName}
                    </Typography>
                  </Box>
                </TableCell>

                {/* Type */}
                <TableCell align="center">
                  <Chip
                    icon={material.type === 'video' ? <VideocamIcon /> : <ImageIcon />}
                    label={material.type === 'video' ? '视频' : '图片'}
                    size="small"
                    variant="outlined"
                  />
                </TableCell>

                {/* Duration */}
                <TableCell align="center">
                  <Typography variant="body2">{material.duration}</Typography>
                </TableCell>

                {/* Resolution */}
                <TableCell align="center">
                  <Typography variant="body2">{material.resolution}</Typography>
                </TableCell>

                {/* Size */}
                <TableCell align="right">
                  <Typography variant="body2">{material.size}</Typography>
                </TableCell>

                {/* Status */}
                <TableCell align="center">
                  <Chip
                    label={STATUS_LABELS[material.status] || material.status}
                    color={STATUS_COLORS[material.status] || 'default'}
                    size="small"
                  />
                </TableCell>

                {/* Actions */}
                <TableCell align="center">
                  <Tooltip title="更多操作">
                    <IconButton
                      size="small"
                      onClick={(e: React.MouseEvent<HTMLElement>) =>
                        handleActionClick(e, material.id)
                      }
                    >
                      <MoreVertIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Action menu */}
      <Menu
        anchorEl={actionMenuAnchor?.element}
        open={actionMenuAnchor !== null}
        onClose={handleActionClose}
        transitionDuration={0}
      >
        <MenuItem onClick={handleDetailAction}>
          <ListItemIcon>
            <InfoIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>查看详情</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDeleteAction}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText sx={{ color: 'error.main' }}>删除素材</ListItemText>
        </MenuItem>
      </Menu>
    </TableContainer>
  );
};

export default MaterialList;
