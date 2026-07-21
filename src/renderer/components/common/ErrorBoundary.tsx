import React from 'react';
import { Box, Typography, Button, Paper } from '@mui/material';
import ReportProblemIcon from '@mui/icons-material/ReportProblem';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

/**
 * C3 — Global error boundary. Prevents a single component throw from
 * blanking the whole app. Shows an FCP-styled fallback with a retry.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, message: '' });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <Box
          sx={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            p: 3,
          }}
        >
          <Paper
            sx={{
              p: 4,
              maxWidth: 420,
              textAlign: 'center',
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 3,
            }}
          >
            <ReportProblemIcon sx={{ fontSize: 48, color: 'error.main', mb: 1 }} />
            <Typography variant="h6" gutterBottom>
              界面出现异常
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2, wordBreak: 'break-word' }}>
              {this.state.message || '发生未知错误，但你的数据通常未丢失。'}
            </Typography>
            <Button variant="contained" onClick={this.handleReset}>
              重试
            </Button>
          </Paper>
        </Box>
      );
    }
    return this.props.children;
  }
}
