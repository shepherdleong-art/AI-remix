/**
 * ViewModeToggle component.
 *
 * A toggle button group that switches between grid and list view modes
 * for the materials display.
 */
import React from 'react';
import {
  ToggleButtonGroup,
  ToggleButton,
  Tooltip,
} from '@mui/material';
import GridViewIcon from '@mui/icons-material/GridView';
import ViewListIcon from '@mui/icons-material/ViewList';

export interface ViewModeToggleProps {
  /** Current view mode */
  viewMode: 'grid' | 'list';
  /** Called when the user switches view mode */
  onViewModeChange: (mode: 'grid' | 'list') => void;
  /** Optional size variant */
  size?: 'small' | 'medium';
}

/**
 * Toggle button group for switching between grid and list views.
 *
 * Uses MUI ToggleButtonGroup with icons for visual clarity.
 * Displays tooltips on each button for accessibility.
 */
const ViewModeToggle: React.FC<ViewModeToggleProps> = ({
  viewMode,
  onViewModeChange,
  size = 'small',
}) => {
  const handleChange = (
    _event: React.MouseEvent<HTMLElement>,
    newMode: 'grid' | 'list' | null
  ): void => {
    if (newMode !== null) {
      onViewModeChange(newMode);
    }
  };

  return (
    <ToggleButtonGroup
      value={viewMode}
      exclusive
      onChange={handleChange}
      size={size}
      aria-label="视图模式切换"
    >
      <ToggleButton value="grid" aria-label="网格视图">
        <Tooltip title="网格视图">
          <GridViewIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
      <ToggleButton value="list" aria-label="列表视图">
        <Tooltip title="列表视图">
          <ViewListIcon fontSize="small" />
        </Tooltip>
      </ToggleButton>
    </ToggleButtonGroup>
  );
};

export default ViewModeToggle;
