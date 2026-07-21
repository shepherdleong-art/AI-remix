import path from 'path';

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

// Python executable options
export const PYTHON_EXECUTABLE: string = 'C:\\Users\\11833\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe';

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
} as const;

// Platform info
export const PLATFORM: NodeJS.Platform = process.platform;
export const IS_WINDOWS: boolean = process.platform === 'win32';
export const IS_MAC: boolean = process.platform === 'darwin';
export const IS_LINUX: boolean = process.platform === 'linux';

// Temp directory (use os.tmpdir() to avoid electron module dependency)
import os from 'os';
export const TEMP_DIR: string = path.join(os.tmpdir(), 'short-video-mashup');
