import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { registerIpcHandlers } from './ipc-handlers';
import { PythonBridge, BackendStatus } from './python-bridge';
import {
  MAIN_WINDOW_CONFIG,
  PRELOAD_PATH,
  RENDERER_ENTRY,
  PYTHON_BACKEND_PATH,
  IPC_CHANNELS,
  setPythonPort,
} from './constants';

let mainWindow: BrowserWindow | null = null;
let pythonBridge: PythonBridge | null = null;

function notifyRenderer(status: BackendStatus, port: number | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.BACKEND_STATUS_CHANGED, {
      status,
      port,
    });
  }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...MAIN_WINDOW_CONFIG,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load renderer entry point
  if (process.env.NODE_ENV === 'development' || process.env.VITE_DEV_SERVER_URL) {
    const devUrl: string = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(RENDERER_ENTRY);
  }

  // Handle external links
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

async function startPythonBackend(): Promise<void> {
  pythonBridge = new PythonBridge({
    scriptPath: PYTHON_BACKEND_PATH,
    onStatusChange: (status: BackendStatus, port: number | null) => {
      if (status === 'running' && port) {
        setPythonPort(port);
        // Ensure the IPC handler is registered (may need re-registration after restart)
        try {
          ipcMain.removeHandler('app:get-python-port');
        } catch {
          // Handler may not exist yet
        }
        ipcMain.handle('app:get-python-port', () => {
          return port;
        });
      }
      notifyRenderer(status, port);
    },
  });

  try {
    const port: number = await pythonBridge.start();
    console.log(`[Main] Python backend started on port ${port}`);

    // Port is already synced and IPC handler registered via onStatusChange callback.
    // Additional explicit set here as a safety net.
    setPythonPort(port);
  } catch (error) {
    console.error('[Main] Failed to start Python backend:', error);
    // App can still open; the renderer will be notified via onStatusChange('error')
    notifyRenderer('error', null);
  }
}

async function stopPythonBackend(): Promise<void> {
  if (pythonBridge) {
    await pythonBridge.stop();
    pythonBridge = null;
  }
}

app.whenReady().then(async () => {
  // Register IPC handlers (must be before any invoke calls)
  registerIpcHandlers();

  // Create main window first so renderer can receive status updates
  mainWindow = createMainWindow();

  // Start Python backend
  await startPythonBackend();

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  await stopPythonBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  await stopPythonBackend();
});
