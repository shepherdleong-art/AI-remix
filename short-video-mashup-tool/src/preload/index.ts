import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../main/constants';

/**
 * Electron API exposed to the renderer process via contextBridge.
 *
 * This provides a secure, type-safe interface between the renderer
 * and the main process. No direct Node.js or Electron APIs are
 * exposed to the renderer.
 */
export interface ElectronAPI {
  /** Open a native folder selection dialog */
  selectFolder: (defaultPath?: string) => Promise<{
    code: number;
    message: string;
    data: { canceled: boolean; paths: string[] } | null;
  }>;

  /** Open a native file selection dialog */
  selectFile: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
    defaultPath?: string;
  }) => Promise<{
    code: number;
    message: string;
    data: { canceled: boolean; paths: string[] } | null;
  }>;

  /** Get the Python backend port */
  getPythonPort: () => Promise<number | null>;

  /** Get the current platform */
  getPlatform: () => Promise<{
    code: number;
    message: string;
    data: { platform: string } | null;
  }>;

  /** Send a proxied request to the Python backend via IPC */
  backendRequest: (options: {
    method: string;
    endpoint: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<{
    code: number;
    message: string;
    data: unknown;
  }>;

  /** Clean temporary files */
  cleanTemp: () => Promise<{
    code: number;
    message: string;
    data: { deletedCount: number; failedCount: number; tempDir: string } | null;
  }>;
}

const electronAPI: ElectronAPI = {
  selectFolder: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER, { defaultPath }),

  selectFile: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
    defaultPath?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILE, options),

  getPythonPort: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PYTHON_PORT),

  getPlatform: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_PLATFORM),

  backendRequest: (options: {
    method: string;
    endpoint: string;
    body?: unknown;
    headers?: Record<string, string>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.BACKEND_REQUEST, options),

  cleanTemp: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLEAN_TEMP),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
