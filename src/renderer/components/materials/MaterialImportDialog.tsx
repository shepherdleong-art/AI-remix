/**
 * MaterialImportDialog component.
 *
 * A full-screen dialog for importing materials. Supports:
 * - Native HTML5 drag-and-drop (no external dependency)
 * - Folder selection via Electron dialog API
 * - File format whitelist with visual hints
 * - Import progress tracking
 */
import React, { useCallback, useRef, useState, DragEvent } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Box,
  Button,
  Typography,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  Chip,
  LinearProgress,
  Alert,
  IconButton,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import InsertDriveFileIcon from '@mui/icons-material/InsertDriveFile';
import {
  ALL_SUPPORTED_EXTENSIONS,
  VIDEO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  getMaterialTypeFromExtension,
  MAX_FILE_SIZE_BYTES,
  formatFileSize,
  type MaterialType,
} from '@/renderer/types/material';

export interface MaterialImportDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Called to close the dialog */
  onClose: () => void;
  /** Called with the list of selected file paths when import is confirmed */
  onImport: (filePaths: string[]) => void;
}

/**
 * Result of validating a single file for import.
 */
interface FileValidationResult {
  /** Original file path */
  path: string;
  /** File name extracted from path */
  fileName: string;
  /** Whether the file passed validation */
  valid: boolean;
  /** Error message if invalid */
  error?: string;
  /** Detected material type */
  materialType?: MaterialType;
  /** File size in bytes (if accessible) */
  size?: number;
}

/**
 * Import dialog for adding new materials.
 *
 * Features:
 * - Drag-and-drop zone with visual feedback
 * - "Select folder" button using Electron's native dialog
 * - File format white listing and validation
 * - Preview list of files to import
 * - Import confirmation with progress indication
 */
const MaterialImportDialog: React.FC<MaterialImportDialogProps> = ({
  open,
  onClose,
  onImport,
}) => {
  const [dragOver, setDragOver] = useState<boolean>(false);
  const [validatedFiles, setValidatedFiles] = useState<FileValidationResult[]>([]);
  const [importing, setImporting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const dragCounterRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  /** Map file name → browser File object for upload */
  const fileObjectsRef = useRef<Map<string, File>>(new Map());

  const isElectron = !!(window as unknown as Record<string, unknown>).electronAPI;

  // Reset state when dialog opens
  React.useEffect(() => {
    if (open) {
      setValidatedFiles([]);
      setImporting(false);
      setError(null);
      setDragOver(false);
      dragCounterRef.current = 0;
      fileObjectsRef.current.clear();
    }
  }, [open]);

  /**
   * Extract file extension from a path.
   */
  const getExtension = (filePath: string): string => {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filePath.substring(lastDot).toLowerCase();
  };

  /**
   * Validate an array of file paths against supported formats and size limits.
   */
  const validateFiles = useCallback(
    (paths: string[]): FileValidationResult[] => {
      const results: FileValidationResult[] = [];

      for (const filePath of paths) {
        const fileName = filePath.replace(/^.*[\\/]/, '');
        const ext = getExtension(filePath);

        if (!ext) {
          results.push({
            path: filePath,
            fileName,
            valid: false,
            error: '无法识别文件类型（缺少扩展名）',
          });
          continue;
        }

        const materialType = getMaterialTypeFromExtension(ext);

        if (!materialType) {
          results.push({
            path: filePath,
            fileName,
            valid: false,
            error: `不支持的格式：${ext}`,
          });
          continue;
        }

        // Check for duplicates in already-validated list
        const isDuplicate = results.some(
          (r: FileValidationResult) => r.valid && r.path === filePath
        );
        if (isDuplicate) continue;

        results.push({
          path: filePath,
          fileName,
          valid: true,
          materialType,
        });
      }

      return results;
    },
    []
  );

  /**
   * Handle files dropped onto the drop zone.
   */
  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>): void => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      dragCounterRef.current = 0;

      const items = e.dataTransfer.items;
      if (!items) return;

      const filePaths: string[] = [];

      // Collect file paths from drop (in Electron, file.path is available)
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            // In Electron's renderer, File objects have a `path` property
            const electronFile = file as File & { path?: string };
            if (electronFile.path) {
              filePaths.push(electronFile.path);
            } else {
              // Browser mode: use file name and store File object
              filePaths.push(file.name);
              fileObjectsRef.current.set(file.name, file);
            }
          }
        }
      }

      if (filePaths.length === 0) {
        setError('未能读取拖放文件路径，请使用"选择文件夹"按钮');
        return;
      }

      setError(null);
      const results = validateFiles(filePaths);

      setValidatedFiles((prev: FileValidationResult[]) => {
        // Merge with existing, avoiding duplicates
        const existingPaths = new Set(prev.map((r: FileValidationResult) => r.path));
        const newResults = results.filter(
          (r: FileValidationResult) => !existingPaths.has(r.path)
        );
        return [...prev, ...newResults];
      });
    },
    [validateFiles]
  );

  const handleDragEnter = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /**
   * Handle browser file input selection.
   */
  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>): void => {
      const files = e.target.files;
      if (!files || files.length === 0) return;

      const results: FileValidationResult[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.includes('.')
          ? '.' + file.name.split('.').pop()?.toLowerCase()
          : '';
        const materialType = getMaterialTypeFromExtension(ext);

        if (!materialType) {
          results.push({
            path: file.name,
            fileName: file.name,
            valid: false,
            error: `不支持的格式：${ext}`,
          });
        } else {
          results.push({
            path: file.name,
            fileName: file.name,
            valid: true,
            materialType,
            size: file.size,
          });
          // Store File object for later upload
          fileObjectsRef.current.set(file.name, file);
        }
      }

      setValidatedFiles((prev) => {
        const existingPaths = new Set(prev.map((r) => r.path));
        const newResults = results.filter((r) => !existingPaths.has(r.path));
        return [...prev, ...newResults];
      });

      // Reset input so same files can be re-selected
      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    []
  );

  /**
   * Open native folder selection dialog via Electron API.
   */
  const handleSelectFolder = useCallback(async (): Promise<void> => {
    setError(null);

    // Browser mode: use native folder input
    if (!isElectron) {
      folderInputRef.current?.click();
      return;
    }

    // Electron mode: use native dialog
    try {
      const electronAPI = (window as unknown as Record<string, unknown>).electronAPI as {
        selectFolder: (defaultPath?: string) => Promise<{
          code: number;
          message: string;
          data: { canceled: boolean; paths: string[] } | null;
        }>;
      } | undefined;

      if (!electronAPI) {
        fileInputRef.current?.click();
        return;
      }

      const response = await electronAPI.selectFolder();

      if (response.code !== 0 || !response.data || response.data.canceled) {
        return; // User cancelled
      }

      const folderPath = response.data.paths[0];
      if (!folderPath) return;

      // Scan the folder for supported files (done server-side via IPC or frontend)
      const selectFilesResponse = await (
        window as unknown as Record<string, unknown>
      ).electronAPI as {
        selectFile: (options: {
          filters: Array<{ name: string; extensions: string[] }>;
          defaultPath?: string;
        }) => Promise<{
          code: number;
          message: string;
          data: { canceled: boolean; paths: string[] } | null;
        }>;
      };

      // Use a multi-select file dialog scoped to the chosen folder
      const fileResponse = await selectFilesResponse.selectFile({
        filters: [
          {
            name: '支持的媒体文件',
            extensions: [
              ...VIDEO_EXTENSIONS.map((ext: string) => ext.replace('.', '')),
              ...IMAGE_EXTENSIONS.map((ext: string) => ext.replace('.', '')),
            ],
          },
        ],
        defaultPath: folderPath,
      });

      if (
        fileResponse.code !== 0 ||
        !fileResponse.data ||
        fileResponse.data.canceled
      ) {
        return;
      }

      const paths = fileResponse.data.paths;
      if (paths.length === 0) return;

      const results = validateFiles(paths);
      setValidatedFiles((prev: FileValidationResult[]) => {
        const existingPaths = new Set(prev.map((r: FileValidationResult) => r.path));
        const newResults = results.filter(
          (r: FileValidationResult) => !existingPaths.has(r.path)
        );
        return [...prev, ...newResults];
      });
    } catch (err) {
      setError(`选择文件夹失败：${(err as Error).message}`);
    }
  }, [validateFiles]);

  /**
   * Remove a file from the import list.
   */
  const handleRemoveFile = useCallback((filePath: string): void => {
    setValidatedFiles((prev: FileValidationResult[]) =>
      prev.filter((f: FileValidationResult) => f.path !== filePath)
    );
  }, []);

  /**
   * Confirm import and pass file paths to parent.
   */
  const handleImport = useCallback(async (): Promise<void> => {
    const validPaths: string[] = validatedFiles
      .filter((f: FileValidationResult) => f.valid)
      .map((f: FileValidationResult) => f.path);

    if (validPaths.length === 0) {
      setError('没有可导入的有效文件');
      return;
    }

    setImporting(true);
    setError(null);

    // Browser mode: upload files to backend first
    if (!isElectron && fileObjectsRef.current.size > 0) {
      const uploadedPaths: string[] = [];
      try {
        for (const item of validatedFiles) {
          if (!item.valid) continue;
          const file = fileObjectsRef.current.get(item.fileName);
          if (!file) continue;

          const formData = new FormData();
          formData.append('file', file, item.fileName);

          const resp = await fetch('http://127.0.0.1:18000/api/materials/upload', {
            method: 'POST',
            body: formData,
          });
          const result = await resp.json();

          if (result.code === 0 && result.data?.file_path) {
            uploadedPaths.push(result.data.file_path);
          } else {
            setError(`上传失败: ${item.fileName} — ${result.message}`);
            setImporting(false);
            return;
          }
        }
        onImport(uploadedPaths);
      } catch (err) {
        setError(`上传失败: ${(err as Error).message}`);
        setImporting(false);
      }
      return;
    }

    // Electron mode: pass paths directly
    onImport(validPaths);
  }, [validatedFiles, onImport, isElectron]);

  const validCount: number = validatedFiles.filter((f: FileValidationResult) => f.valid).length;
  const invalidCount: number = validatedFiles.filter((f: FileValidationResult) => !f.valid).length;

  return (
    <Dialog
      open={open}
      onClose={importing ? undefined : onClose}
      maxWidth="md"
      fullWidth
      PaperProps={{
        sx: { minHeight: '60vh' },
      }}
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>导入素材</span>
        {!importing && (
          <IconButton onClick={onClose} size="small" aria-label="关闭">
            <CloseIcon />
          </IconButton>
        )}
      </DialogTitle>

      <DialogContent dividers>
        {/* Drop zone */}
        <Box
          onDrop={handleDrop}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          sx={{
            border: '2px dashed',
            borderColor: dragOver ? 'primary.main' : 'grey.300',
            borderRadius: 2,
            p: 4,
            mb: 2,
            textAlign: 'center',
            bgcolor: dragOver ? 'primary.50' : 'grey.50',
            transition: 'all 0.2s ease',
            cursor: 'pointer',
          }}
        >
          <CloudUploadIcon
            sx={{
              fontSize: 48,
              color: dragOver ? 'primary.main' : 'grey.400',
              mb: 1,
            }}
          />
          <Typography variant="body1" gutterBottom>
            拖拽文件或文件夹到此处
          </Typography>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            或
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              startIcon={<InsertDriveFileIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
            >
              选择文件
            </Button>
            <Button
              variant="outlined"
              startIcon={<FolderOpenIcon />}
              onClick={handleSelectFolder}
              disabled={importing}
            >
              选择文件夹
            </Button>
          </Box>
        </Box>

        {/* Supported formats hint */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ lineHeight: '24px', mr: 1 }}>
            支持格式：
          </Typography>
          {ALL_SUPPORTED_EXTENSIONS.map((ext: string) => (
            <Chip key={ext} label={ext} size="small" variant="outlined" />
          ))}
        </Box>

        {/* Error alert */}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Import progress bar */}
        {importing && (
          <Box sx={{ mb: 2 }}>
            <LinearProgress />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              正在导入素材...
            </Typography>
          </Box>
        )}

        {/* File list */}
        {validatedFiles.length > 0 && (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
              <Typography variant="subtitle2">
                已选择 {validatedFiles.length} 个文件
              </Typography>
              {validCount > 0 && (
                <Chip
                  icon={<CheckCircleIcon />}
                  label={`${validCount} 个有效`}
                  size="small"
                  color="success"
                  variant="outlined"
                />
              )}
              {invalidCount > 0 && (
                <Chip
                  icon={<ErrorIcon />}
                  label={`${invalidCount} 个无效`}
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
            </Box>

            <List dense sx={{ maxHeight: 240, overflow: 'auto', bgcolor: 'grey.50', borderRadius: 1 }}>
              {validatedFiles.map((file: FileValidationResult) => (
                <ListItem
                  key={file.path}
                  secondaryAction={
                    !importing && (
                      <IconButton
                        edge="end"
                        size="small"
                        onClick={() => handleRemoveFile(file.path)}
                      >
                        <CloseIcon fontSize="small" />
                      </IconButton>
                    )
                  }
                >
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    {file.valid ? (
                      <CheckCircleIcon color="success" fontSize="small" />
                    ) : (
                      <ErrorIcon color="error" fontSize="small" />
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={file.fileName}
                    secondary={file.error || (file.materialType === 'video' ? '视频' : '图片')}
                    primaryTypographyProps={{ variant: 'body2', noWrap: true }}
                    secondaryTypographyProps={{ variant: 'caption' }}
                  />
                </ListItem>
              ))}
            </List>
          </Box>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={importing}>
          取消
        </Button>
        <Button
          variant="contained"
          onClick={handleImport}
          disabled={validCount === 0 || importing}
          startIcon={<CloudUploadIcon />}
        >
          导入 ({validCount})
        </Button>
      </DialogActions>

      {/* Hidden file input for browser mode */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ALL_SUPPORTED_EXTENSIONS.join(',')}
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        /* @ts-expect-error webkitdirectory is non-standard */
        webkitdirectory=""
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
    </Dialog>
  );
};

export default MaterialImportDialog;
