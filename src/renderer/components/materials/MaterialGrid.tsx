/**
 * MaterialGrid component.
 *
 * Displays materials in a responsive grid layout with:
 * - Card thumbnails with info overlays
 * - Multi-select support (Ctrl+Click, Shift+Click)
 * - Right-click context menu (delete, view details)
 * - Empty state when no materials exist
 */
import React, { useCallback } from 'react';
import {
  Box,
  Grid,
  Typography,
  Menu,
  MenuItem,
  ListItemIcon,
  ListItemText,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import InfoIcon from '@mui/icons-material/Info';
import VideoLibraryIcon from '@mui/icons-material/VideoLibrary';
import MaterialGridCard from './MaterialGridCard';
import type { AnyMaterial } from '@/renderer/types/material';

export interface MaterialGridProps {
  /** Filtered and sorted materials to display */
  materials: AnyMaterial[];
  /** Set of selected material IDs */
  selectedIds: Set<string>;
  /** Called when a card is clicked */
  onCardClick: (materialId: string, event: React.MouseEvent) => void;
  /** Called when a card's checkbox is toggled */
  onCheckToggle: (materialId: string) => void;
  /** Called to delete a material */
  onDelete: (materialId: string) => void;
  /** Called to view material details */
  onViewDetail: (materialId: string) => void;
}

/**
 * Context menu state.
 */
interface ContextMenuState {
  mouseX: number;
  mouseY: number;
  materialId: string;
}

/**
 * Responsive grid layout for material cards.
 *
 * Uses MUI Grid with responsive column counts:
 * - xs: 2 columns (12/6)
 * - sm: 3 columns (12/4)
 * - md: 4 columns (12/3)
 * - lg: 6 columns (12/2)
 */
const MaterialGrid: React.FC<MaterialGridProps> = ({
  materials,
  selectedIds,
  onCardClick,
  onCheckToggle,
  onDelete,
  onViewDetail,
}) => {
  const [contextMenu, setContextMenu] = React.useState<ContextMenuState | null>(null);

  const handleContextMenu = useCallback(
    (materialId: string, event: React.MouseEvent): void => {
      setContextMenu({
        mouseX: event.clientX,
        mouseY: event.clientY,
        materialId,
      });
    },
    []
  );

  const handleCloseContextMenu = useCallback((): void => {
    setContextMenu(null);
  }, []);

  const handleDeleteFromMenu = useCallback((): void => {
    if (contextMenu) {
      onDelete(contextMenu.materialId);
      setContextMenu(null);
    }
  }, [contextMenu, onDelete]);

  const handleViewDetailFromMenu = useCallback((): void => {
    if (contextMenu) {
      onViewDetail(contextMenu.materialId);
      setContextMenu(null);
    }
  }, [contextMenu, onViewDetail]);

  const selectionMode: boolean = selectedIds.size > 0;

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

  return (
    <Box sx={{ flex: 1, overflow: 'auto' }}>
      <Grid container spacing={2}>
        {materials.map((material: AnyMaterial) => (
          <Grid item xs={6} sm={4} md={3} lg={2} key={material.id}>
            <MaterialGridCard
              material={material}
              isSelected={selectedIds.has(material.id)}
              selectionMode={selectionMode}
              onClick={onCardClick}
              onContextMenu={handleContextMenu}
              onCheckToggle={onCheckToggle}
            />
          </Grid>
        ))}
      </Grid>

      {/* Context menu */}
      <Menu
        open={contextMenu !== null}
        onClose={handleCloseContextMenu}
        anchorReference="anchorPosition"
        anchorPosition={
          contextMenu !== null
            ? { top: contextMenu.mouseY, left: contextMenu.mouseX }
            : undefined
        }
        transitionDuration={0}
      >
        <MenuItem onClick={handleViewDetailFromMenu}>
          <ListItemIcon>
            <InfoIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>查看详情</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleDeleteFromMenu}>
          <ListItemIcon>
            <DeleteIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText sx={{ color: 'error.main' }}>删除素材</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
};

export default MaterialGrid;
