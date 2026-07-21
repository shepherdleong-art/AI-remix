import React from 'react';
import { Box, Typography, Paper } from '@mui/material';

interface PanelProps {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  emptyHint?: string;
}

/**
 * Shared container for the left/right workspace side panels.
 * Title header + scrollable body. Theme-token based (no hardcoded colors).
 */
export const Panel: React.FC<PanelProps> = ({ title, children, action, emptyHint }) => (
  <Paper
    sx={{
      p: 2,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      border: '1px solid',
      borderColor: 'divider',
      borderRadius: 3,
      overflow: 'hidden',
      bgcolor: 'background.paper',
    }}
  >
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        mb: 1.5,
        flexShrink: 0,
      }}
    >
      <Typography variant="subtitle2" fontWeight={700}>
        {title}
      </Typography>
      {action}
    </Box>
    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      {emptyHint ? (
        <Box
          sx={{
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            px: 2,
          }}
        >
          <Typography variant="body2" color="text.secondary">
            {emptyHint}
          </Typography>
        </Box>
      ) : (
        children
      )}
    </Box>
  </Paper>
);
