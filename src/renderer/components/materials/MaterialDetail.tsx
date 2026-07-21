/**
 * MaterialDetail component.
 *
 * A right-side MUI Drawer that displays the full metadata of a selected material.
 * Includes:
 * - Large thumbnail preview
 * - Complete metadata fields
 * - Delete button
 * - Close button
 */
import React, { useCallback } from 'react';
import {
  Drawer,
  Box,
  Typography,
  IconButton,
  Button,
  Divider,
  Chip,
  Paper,
  Skeleton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import VideocamIcon from '@mui/icons-material/Videocam';
import ImageIcon from '@mui/icons-material/Image';
import type {
  AnyMaterial,
  VideoMaterial,
  ImageMaterial,
} from '@/renderer/types/material';

export interface MaterialDetailProps {
  /** The material to display details for, or null if drawer should be closed */
  material: AnyMaterial | null;
  /** Whether the drawer is open */
  open: boolean;
  /** Called to close the drawer */
  onClose: () => void;
  /** Called when the user requests deletion */
  onDelete: (materialId: string) => void;
}

/**
 * Metadata field row displayed in the detail panel.
 */
interface DetailFieldProps {
  label: string;
  value: string | number | undefined | null;
}

const DetailField: React.FC<DetailFieldProps> = ({ label, value }) => {
  if (value === undefined || value === null || value === '') return null;
  return (
    <Box sx={{ display: 'flex', py: 0.75 }}>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ minWidth: 100, flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
        {String(value)}
      </Typography>
    </Box>
  );
};

/**
 * Right-side drawer panel showing full material details.
 *
 * Layout:
 * - Header with close button
 * - Large thumbnail preview (16:9)
 * - Metadata section with key-value pairs
 * - Action buttons (delete)
 */
const MaterialDetail: React.FC<MaterialDetailProps> = ({
  material,
  open,
  onClose,
  onDelete,
}) => {
  const [imageLoaded, setImageLoaded] = React.useState<boolean>(false);

  const handleDelete = useCallback((): void => {
    if (material) {
      onDelete(material.id);
      onClose();
    }
  }, [material, onDelete, onClose]);

  const handleImageLoad = useCallback((): void => {
    setImageLoaded(true);
  }, []);

  // Reset image load state when material changes
  React.useEffect(() => {
    setImageLoaded(false);
  }, [material?.id]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      PaperProps={{
        sx: {
          width: { xs: '100%', sm: 400 },
          p: 0,
        },
      }}
    >
      {material ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* Header */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 2,
              py: 1.5,
              borderBottom: 1,
              borderColor: 'divider',
            }}
          >
            <Typography variant="h6" noWrap sx={{ flex: 1, mr: 1 }}>
              素材详情
            </Typography>
            <IconButton onClick={onClose} size="small" aria-label="关闭详情">
              <CloseIcon />
            </IconButton>
          </Box>

          {/* Thumbnail */}
          <Box sx={{ position: 'relative', width: '100%', pt: '56.25%', bgcolor: 'grey.900' }}>
            {!imageLoaded && (
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
            {material.thumbnail ? (
              <Box
                component="img"
                src={material.thumbnail}
                alt={material.fileName}
                onLoad={handleImageLoad}
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
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
                }}
              >
                {material.type === 'video' ? (
                  <VideocamIcon sx={{ fontSize: 64, color: 'grey.600' }} />
                ) : (
                  <ImageIcon sx={{ fontSize: 64, color: 'grey.600' }} />
                )}
              </Box>
            )}
          </Box>

          {/* Metadata */}
          <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              {material.fileName}
            </Typography>

            <Chip
              icon={material.type === 'video' ? <VideocamIcon /> : <ImageIcon />}
              label={material.type === 'video' ? '视频' : '图片'}
              size="small"
              sx={{ mb: 2 }}
            />

            <Divider sx={{ my: 1.5 }} />

            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              基本信息
            </Typography>
            <DetailField label="文件路径" value={material.filePath} />
            <DetailField label="文件大小" value={material.size} />
            <DetailField label="时长" value={material.duration} />
            <DetailField label="分辨率" value={material.resolution} />
            <DetailField label="状态" value={material.status} />
            <DetailField label="添加时间" value={material.addedAt} />

            {/* Video-specific metadata */}
            {material.type === 'video' && (
              <>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                  视频信息
                </Typography>
                <DetailField
                  label="时长(秒)"
                  value={(material as VideoMaterial).durationSeconds?.toFixed(2)}
                />
                <DetailField label="帧率" value={`${(material as VideoMaterial).fps} fps`} />
                <DetailField label="编码" value={(material as VideoMaterial).codec} />
                <DetailField
                  label="码率"
                  value={
                    (material as VideoMaterial).bitrate
                      ? `${((material as VideoMaterial).bitrate / 1_000_000).toFixed(2)} Mbps`
                      : undefined
                  }
                />
                <DetailField label="宽度" value={`${(material as VideoMaterial).width} px`} />
                <DetailField label="高度" value={`${(material as VideoMaterial).height} px`} />
              </>
            )}

            {/* Image-specific metadata */}
            {material.type === 'image' && (
              <>
                <Divider sx={{ my: 1.5 }} />
                <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                  图片信息
                </Typography>
                <DetailField label="宽度" value={`${(material as ImageMaterial).width} px`} />
                <DetailField label="高度" value={`${(material as ImageMaterial).height} px`} />
                <DetailField label="格式" value={(material as ImageMaterial).format} />
              </>
            )}
          </Box>

          {/* Actions */}
          <Box sx={{ px: 2, py: 2, borderTop: 1, borderColor: 'divider' }}>
            <Button
              variant="outlined"
              color="error"
              startIcon={<DeleteIcon />}
              fullWidth
              onClick={handleDelete}
            >
              删除素材
            </Button>
          </Box>
        </Box>
      ) : (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
          }}
        >
          <Typography color="text.secondary">未选择素材</Typography>
        </Box>
      )}
    </Drawer>
  );
};

export default MaterialDetail;
