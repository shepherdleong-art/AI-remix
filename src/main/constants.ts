import path from 'path';
import fs from 'fs';
import os from 'os';

// Application-wide constants

// Python backend port (set dynamically by main/index.ts after backend starts)
export let pythonPort: number | null = null;

export function setPythonPort(port: number): void {
  pythonPort = port;
  console.log(`[Constants] Python port set to ${port}`);
}

/**
 * Get the app root directory.
 *
 * Uses process.cwd() at runtime to avoid module-load-time dependency
 * on the 'electron' module, which may not be available until the app
 * context is fully initialized.
 */
function getAppRoot(): string {
  return process.cwd();
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolvePythonExecutable(): string {
  const appRoot = getAppRoot();
  const envPython = process.env.MASHUP_PYTHON || process.env.PYTHON_EXECUTABLE;
  const candidates: string[] = [
    envPython || '',
    path.join(appRoot, 'backend', 'venv', 'bin', 'python'),
    path.join(appRoot, 'backend', 'venv', 'bin', 'python3'),
    path.join(appRoot, 'backend', 'venv', 'Scripts', 'python.exe'),
  ];

  const existing = firstExistingPath(candidates);
  if (existing) {
    return existing;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

// Renderer entry point (production build output from Vite)
export const RENDERER_ENTRY: string = path.join(getAppRoot(), 'dist', 'src', 'renderer', 'index.html');

// Preload script path (compiled by tsc into dist-electron/)
export const PRELOAD_PATH: string = path.join(__dirname, '..', 'preload', 'index.js');

// Python backend entry script
export const PYTHON_BACKEND_PATH: string = path.join(
  getAppRoot(),
  'backend',
  'main.py'
);

// Python backend process configuration
export const PYTHON_PORT_RANGE_MIN: number = 18000;
export const PYTHON_PORT_RANGE_MAX: number = 18999;

// Health check configuration
export const PYTHON_HEALTH_CHECK_INTERVAL_MS: number = 500;
export const PYTHON_HEALTH_CHECK_TIMEOUT_MS: number = 30000;
export const PYTHON_HEARTBEAT_INTERVAL_MS: number = 10000;

// Auto-restart configuration
export const PYTHON_MAX_RESTART_ATTEMPTS: number = 5;
export const PYTHON_RESTART_BACKOFF_BASE_MS: number = 1000;  // 1s → 2s → 4s → 8s → 16s
export const PYTHON_RESTART_BACKOFF_MAX_MS: number = 30000;   // cap at 30s
export const PYTHON_HEARTBEAT_FAIL_THRESHOLD: number = 3;     // consecutive failures → restart

// Python executable options
export const PYTHON_EXECUTABLE: string = resolvePythonExecutable();

// Window configuration
export const MAIN_WINDOW_CONFIG = {
  width: 1280,
  height: 800,
  minWidth: 960,
  minHeight: 640,
  title: '短视频智能混剪工具',
  show: false,
  backgroundColor: '#f5f5f5',
};

// IPC channel names
export const IPC_CHANNELS = {
  DIALOG_SELECT_FOLDER: 'dialog:select-folder',
  DIALOG_SELECT_FILE: 'dialog:select-file',
  APP_GET_PYTHON_PORT: 'app:get-python-port',
  APP_GET_PLATFORM: 'app:get-platform',
  BACKEND_REQUEST: 'backend:request',
  APP_CLEAN_TEMP: 'app:clean-temp',
  BACKEND_STATUS_CHANGED: 'backend:status-changed',
} as const;

// Platform info
export const PLATFORM: NodeJS.Platform = process.platform;
export const IS_WINDOWS: boolean = process.platform === 'win32';
export const IS_MAC: boolean = process.platform === 'darwin';
export const IS_LINUX: boolean = process.platform === 'linux';

export const TEMP_DIR: string = path.join(os.tmpdir(), 'short-video-mashup');
