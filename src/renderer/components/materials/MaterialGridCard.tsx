/**
 * MaterialGridCard component.
 *
 * A single material card in the grid view. Displays:
 * - Thumbnail with overlay info (name, duration/resolution)
 * - Selection state indicator (checkbox overlay)
 * - Status badge
 */
import React, { useCallback, useMemo } from 'react';
import {
  Card,
  CardMedia,
  CardContent,
  Box,
  Typography,
  Checkbox,
  Chip,
  Skeleton,
} from '@mui/material';
import VideocamIcon from '@mui/icons-material/Videocam';
import ImageIcon from '@mui/icons-material/Image';
import type { AnyMaterial } from '@/renderer/types/material';

export interface MaterialGridCardProps {
  /** The material data to display */
  material: AnyMaterial;
  /** Whether this card is currently selected */
  isSelected: boolean;
  /** Whether selection mode is active (at least one item selected) */
  selectionMode: boolean;
  /** Called when the card is clicked */
  onClick: (materialId: string, event: React.MouseEvent) => void;
  /** Called when the card is right-clicked */
  onContextMenu: (materialId: string, event: React.MouseEvent) => void;
  /** Called when the checkbox is toggled */
  onCheckToggle: (materialId: string) => void;
}

/**
 * A single card in the material grid.
 *
 * Features:
 * - Skeleton loading state for thumbnails
 * - Selection checkbox that appears on hover or when selected
 * - Type badge (video/image) with appropriate icon
 * - Status chip for non-ready states
 * - Info overlay showing name and duration/resolution
 */
const MaterialGridCard: React.FC<MaterialGridCardProps> = ({
  material,
  isSelected,
  selectionMode,
  onClick,
  onContextMenu,
  onCheckToggle,
}) => {
  const [imageLoaded, setImageLoaded] = React.useState<boolean>(false);
  const [imageError, setImageError] = React.useState<boolean>(false);

  const handleClick = useCallback(
    (event: React.MouseEvent): void => {
      onClick(material.id, event);
    },
    [material.id, onClick]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      onContextMenu(material.id, event);
    },
    [material.id, onContextMenu]
  );

  const handleCheckClick = useCallback(
    (event: React.MouseEvent): void => {
      event.stopPropagation();
      onCheckToggle(material.id);
    },
    [material.id, onCheckToggle]
  );

  const handleImageLoad = useCallback((): void => {
    setImageLoaded(true);
    setImageError(false);
  }, []);

  const handleImageError = useCallback((): void => {
    setImageError(true);
    setImageLoaded(true);
  }, []);

  const showCheckbox: boolean = selectionMode || isSelected;

  const statusChip = useMemo((): React.ReactNode | null => {
    if (material.status === 'ready') return null;
    const colorMap: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
      pending: 'default',
      importing: 'info',
      processing: 'warning',
      error: 'error',
    };
    const labelMap: Record<string, string> = {
      pending: '等待中',
      importing: '导入中',
      processing: '处理中',
      error: '导入失败',
    };
    return (
      <Chip
        label={labelMap[material.status] || material.status}
        color={colorMap[material.status] || 'default'}
        size="small"
        sx={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 2,
          fontSize: '0.7rem',
          height: 20,
        }}
      />
    );
  }, [material.status]);

  return (
    <Card
      elevation={isSelected ? 4 : 1}
      sx={{
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        position: 'relative',
        borderRadius: 2,
        overflow: 'hidden',
        border: isSelected ? '2px solid' : '2px solid transparent',
        borderColor: isSelected ? 'primary.main' : 'transparent',
        bgcolor: isSelected ? 'action.selected' : 'background.paper',
        '&:hover': {
          elevation: 3,
          '& .card-checkbox': {
            opacity: 1,
          },
          '& .card-overlay': {
            opacity: 1,
          },
        },
      }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Selection checkbox overlay */}
      <Box
        className="card-checkbox"
        sx={{
          position: 'absolute',
          top: 4,
          right: 4,
          zIndex: 3,
          opacity: showCheckbox ? 1 : 0,
          transition: 'opacity 0.15s ease',
        }}
      >
        <Checkbox
          checked={isSelected}
          onClick={handleCheckClick}
          size="small"
          sx={{
            p: 0.5,
            bgcolor: 'var(--fcp-cardbar)',
            borderRadius: 1,
            '&:hover': { bgcolor: 'var(--fcp-cardbar)' },
          }}
        />
      </Box>

      {/* Status chip */}
      {statusChip}

      {/* Thumbnail area */}
      <Box sx={{ position: 'relative', width: '100%', pt: '56.25%' /* 16:9 */ }}>
        {!imageLoaded && !imageError && (
          <Skeleton
            variant="rectangular"
            animation="wave"
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            }}
          />
        )}
        {material.thumbnail && !imageError ? (
          <CardMedia
            component="img"
            image={material.thumbnail}
            alt={material.fileName}
            onLoad={handleImageLoad}
            onError={handleImageError}
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: imageLoaded ? 'block' : 'none',
            }}
          />
        ) : (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              bgcolor: 'background.paperAlt',
            }}
          >
            {material.type === 'video' ? (
              <VideocamIcon sx={{ fontSize: 48, color: 'grey.400' }} />
            ) : (
              <ImageIcon sx={{ fontSize: 48, color: 'grey.400' }} />
            )}
          </Box>
        )}

        {/* Info overlay at bottom */}
        <Box
          className="card-overlay"
          sx={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            background: 'linear-gradient(transparent, rgba(0,0,0,0.7))',
            color: 'white',
            p: 1,
            opacity: 0,
            transition: 'opacity 0.15s ease',
          }}
        >
          <Typography variant="caption" noWrap sx={{ display: 'block', lineHeight: 1.3 }}>
            {material.duration}
          </Typography>
          <Typography variant="caption" noWrap sx={{ display: 'block', lineHeight: 1.3 }}>
            {material.resolution}
          </Typography>
        </Box>
      </Box>

      {/* File name */}
      <CardContent sx={{ p: 1, '&:last-child': { pb: 1 } }}>
        <Typography
          variant="caption"
          noWrap
          sx={{ display: 'block', fontWeight: 500 }}
          title={material.fileName}
        >
          {material.fileName}
        </Typography>
      </CardContent>
    </Card>
  );
};

export default MaterialGridCard;
