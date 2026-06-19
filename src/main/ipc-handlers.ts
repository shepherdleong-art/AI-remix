import { ipcMain, dialog, BrowserWindow } from 'electron';
import http from 'http';
import { IPC_CHANNELS, PLATFORM, TEMP_DIR, pythonPort } from './constants';
import fs from 'fs';
import path from 'path';

/**
 * Register all IPC handlers for the main process.
 *
 * IPC Channel naming convention: {domain}:{action}
 */
export function registerIpcHandlers(): void {
  // ─── Dialog handlers ───────────────────────────────────────

  /**
   * Open a native folder selection dialog.
   * Channel: dialog:select-folder
   */
  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async (_event, options?: { defaultPath?: string }) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { code: 50001, message: 'No active window', data: null };

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      defaultPath: options?.defaultPath || undefined,
    });

    if (result.canceled) {
      return { code: 0, message: 'User cancelled', data: { canceled: true, paths: [] } };
    }

    return {
      code: 0,
      message: 'success',
      data: { canceled: false, paths: result.filePaths },
    };
  });

  /**
   * Open a native file selection dialog.
   * Channel: dialog:select-file
   */
  ipcMain.handle(
    IPC_CHANNELS.DIALOG_SELECT_FILE,
    async (_event, options?: { filters?: Array<{ name: string; extensions: string[] }>; defaultPath?: string }) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { code: 50001, message: 'No active window', data: null };

      const result = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: options?.filters || [
          { name: '媒体文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'jpg', 'jpeg', 'png', 'gif', 'bmp'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        defaultPath: options?.defaultPath || undefined,
      });

      if (result.canceled) {
        return { code: 0, message: 'User cancelled', data: { canceled: true, paths: [] } };
      }

      return {
        code: 0,
        message: 'success',
        data: { canceled: false, paths: result.filePaths },
      };
    }
  );

  // ─── App info handlers ─────────────────────────────────────

  /**
   * Get the current platform name.
   * Channel: app:get-platform
   */
  ipcMain.handle(IPC_CHANNELS.APP_GET_PLATFORM, () => {
    return {
      code: 0,
      message: 'success',
      data: { platform: PLATFORM },
    };
  });

  // Note: app:get-python-port is registered dynamically in main/index.ts
  // after the Python backend starts. This ensures the port is always available.

  // ─── Backend proxy handler ─────────────────────────────────

  /**
   * Proxy HTTP requests to the Python backend.
   * Channel: backend:request
   *
   * The renderer sends requests through IPC, and the main process forwards
   * them to the Python HTTP backend. This avoids CORS issues in production.
   */
  ipcMain.handle(
    IPC_CHANNELS.BACKEND_REQUEST,
    async (_event, options: {
      method: string;
      endpoint: string;
      body?: unknown;
      headers?: Record<string, string>;
    }) => {
      const port: number | null = pythonPort;

      if (!port) {
        return {
          code: 50001,
          message: 'Backend not available (Python service not started)',
          data: null,
        };
      }

      const requestBody: string = options.body
        ? JSON.stringify(options.body)
        : '';

      return new Promise<{
        code: number;
        message: string;
        data: unknown;
      }>((resolve) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: options.endpoint,
            method: options.method || 'GET',
            headers: {
              'Content-Type': 'application/json',
              ...(options.headers || {}),
              'Content-Length': Buffer.byteLength(requestBody),
            },
            timeout: 30000,
          },
          (res) => {
            let body: string = '';
            res.on('data', (chunk: Buffer) => {
              body += chunk.toString();
            });
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve({
                  code: 50001,
                  message: `Invalid response from backend: ${body.substring(0, 200)}`,
                  data: null,
                });
              }
            });
          }
        );

        req.on('error', (err: Error) => {
          resolve({
            code: 50001,
            message: `Backend request failed: ${err.message}`,
            data: null,
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({
            code: 50001,
            message: 'Backend request timeout',
            data: null,
          });
        });

        if (requestBody) {
          req.write(requestBody);
        }
        req.end();
      });
    }
  );

  // ─── Temp cleanup handler ──────────────────────────────────

  /**
   * Clean temporary files.
   * Channel: app:clean-temp
   */
  ipcMain.handle(IPC_CHANNELS.APP_CLEAN_TEMP, async () => {
    try {
      if (fs.existsSync(TEMP_DIR)) {
        const files: string[] = fs.readdirSync(TEMP_DIR);
        let deletedCount: number = 0;
        let failedCount: number = 0;

        for (const file of files) {
          try {
            const filePath: string = path.join(TEMP_DIR, file);
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
              fs.rmSync(filePath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(filePath);
            }
            deletedCount++;
          } catch {
            failedCount++;
          }
        }

        return {
          code: 0,
          message: 'success',
          data: { deletedCount, failedCount, tempDir: TEMP_DIR },
        };
      }

      return {
        code: 0,
        message: 'No temp files to clean',
        data: { deletedCount: 0, failedCount: 0, tempDir: TEMP_DIR },
      };
    } catch (error) {
      return {
        code: 50001,
        message: `Clean temp failed: ${(error as Error).message}`,
        data: null,
      };
    }
  });
}
