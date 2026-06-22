import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import path from 'path';
import http from 'http';
import {
  PYTHON_EXECUTABLE,
  PYTHON_HEALTH_CHECK_INTERVAL_MS,
  PYTHON_HEALTH_CHECK_TIMEOUT_MS,
  PYTHON_HEARTBEAT_INTERVAL_MS,
  PYTHON_PORT_RANGE_MIN,
  PYTHON_PORT_RANGE_MAX,
  PYTHON_MAX_RESTART_ATTEMPTS,
  PYTHON_RESTART_BACKOFF_BASE_MS,
  PYTHON_RESTART_BACKOFF_MAX_MS,
  PYTHON_HEARTBEAT_FAIL_THRESHOLD,
} from './constants';

export type BackendStatus = 'starting' | 'running' | 'stopped' | 'reconnecting' | 'error';

export interface PythonBridgeOptions {
  /** Path to the Python script to execute */
  scriptPath: string;
  /** Python executable (default: 'python') */
  pythonExecutable?: string;
  /** Additional command-line arguments */
  args?: string[];
  /** Callback invoked when backend status changes (for IPC notification to renderer) */
  onStatusChange?: (status: BackendStatus, port: number | null) => void;
}

/**
 * Manages the lifecycle of a Python backend child process.
 *
 * Responsibilities:
 * - Spawn Python subprocess
 * - Parse port number from stdout
 * - Health check polling until backend is ready
 * - Graceful shutdown via SIGTERM
 * - Heartbeat monitoring
 * - Auto-restart with exponential backoff on crash
 */
export class PythonBridge {
  private scriptPath: string;
  private pythonExecutable: string;
  private extraArgs: string[];
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private isRunning: boolean = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Auto-restart state
  private restartAttempts: number = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveHeartbeatFailures: number = 0;
  private intentionalShutdown: boolean = false;
  private onStatusChange: ((status: BackendStatus, port: number | null) => void) | null;

  constructor(options: PythonBridgeOptions) {
    this.scriptPath = options.scriptPath;
    this.pythonExecutable = options.pythonExecutable || PYTHON_EXECUTABLE;
    this.extraArgs = options.args || [];
    this.onStatusChange = options.onStatusChange || null;
  }

  /**
   * Notify listeners of a backend status change.
   */
  private _notifyStatus(status: BackendStatus): void {
    if (this.onStatusChange) {
      this.onStatusChange(status, this.port);
    }
  }

  /**
   * Start the Python backend subprocess.
   * Returns the port number once the backend is healthy.
   */
  async start(): Promise<number> {
    if (this.isRunning) {
      console.warn('[PythonBridge] Backend is already running');
      return this.port!;
    }

    this.intentionalShutdown = false;
    this._notifyStatus('starting');

    console.log('[PythonBridge] Starting Python backend...');

    const spawnOptions: SpawnOptions = {
      cwd: path.dirname(this.scriptPath),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    };

    const args: string[] = [this.scriptPath, ...this.extraArgs];

    this.process = spawn(this.pythonExecutable, args, spawnOptions);

    let stdoutBuffer: string = '';
    let stderrBuffer: string = '';

    // Collect stdout to find the port number
    this.process.stdout?.on('data', (data: Buffer) => {
      const text: string = data.toString();
      stdoutBuffer += text;
      console.log(`[Python stdout] ${text.trim()}`);

      // Try to parse port from stdout (expects format like "PORT:18080")
      if (!this.port) {
        const portMatch: RegExpMatchArray | null = text.match(/PORT:(\d{4,5})/);
        if (portMatch) {
          const parsedPort: number = parseInt(portMatch[1], 10);
          if (parsedPort >= PYTHON_PORT_RANGE_MIN && parsedPort <= PYTHON_PORT_RANGE_MAX) {
            this.port = parsedPort;
          }
        }
      }
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const text: string = data.toString();
      stderrBuffer += text;
      console.error(`[Python stderr] ${text.trim()}`);
    });

    this.process.on('error', (err: Error) => {
      console.error('[PythonBridge] Process error:', err.message);
      this.isRunning = false;
      this._handleProcessExit();
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      console.log(`[PythonBridge] Process exited with code=${code}, signal=${signal}`);
      this.isRunning = false;
      this.stopHeartbeat();
      if (!this.intentionalShutdown) {
        this._handleProcessExit();
      }
    });

    this.isRunning = true;

    // Wait for the backend to be healthy
    try {
      await this.waitForHealthy();
    } catch (err) {
      this.isRunning = false;
      this._notifyStatus('error');
      throw err;
    }

    // Reset restart counter on successful start
    this.restartAttempts = 0;
    this.consecutiveHeartbeatFailures = 0;

    // Start heartbeat once healthy
    this.startHeartbeat();

    this._notifyStatus('running');
    console.log(`[PythonBridge] Backend is ready on port ${this.port}`);
    return this.port!;
  }

  /**
   * Stop the Python backend gracefully.
   * Sends SIGTERM first, then SIGKILL after a timeout.
   */
  async stop(): Promise<void> {
    this.intentionalShutdown = true;

    // Cancel any pending restart
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process || !this.isRunning) {
      console.log('[PythonBridge] No process to stop');
      this._notifyStatus('stopped');
      return;
    }

    console.log('[PythonBridge] Stopping Python backend...');
    this.stopHeartbeat();

    return new Promise<void>((resolve) => {
      const killTimeout: ReturnType<typeof setTimeout> = setTimeout(() => {
        console.warn('[PythonBridge] Force killing process...');
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
        resolve();
      }, 5000);

      this.process!.on('exit', () => {
        clearTimeout(killTimeout);
        this.isRunning = false;
        this.process = null;
        this.port = null;
        this._notifyStatus('stopped');
        resolve();
      });

      // Try graceful shutdown first
      if (this.process && !this.process.killed) {
        const success: boolean = this.process.kill('SIGTERM');
        if (!success) {
          clearTimeout(killTimeout);
          resolve();
        }
      } else {
        clearTimeout(killTimeout);
        resolve();
      }
    });
  }

  /**
   * Get the current backend port.
   */
  getPort(): number | null {
    return this.port;
  }

  /**
   * Check if the backend is currently running.
   */
  getIsRunning(): boolean {
    return this.isRunning;
  }

  // ─── Auto-restart logic ─────────────────────────────────

  /**
   * Handle unexpected process exit — schedule a restart with backoff.
   */
  private _handleProcessExit(): void {
    // Clean up old process reference
    this.process = null;

    if (this.intentionalShutdown) {
      return;
    }

    if (this.restartAttempts >= PYTHON_MAX_RESTART_ATTEMPTS) {
      console.error(
        `[PythonBridge] Max restart attempts (${PYTHON_MAX_RESTART_ATTEMPTS}) reached. Giving up.`
      );
      this._notifyStatus('error');
      this.port = null;
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, ... capped
    const delay = Math.min(
      PYTHON_RESTART_BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts),
      PYTHON_RESTART_BACKOFF_MAX_MS
    );

    this.restartAttempts++;
    this.port = null;
    this._notifyStatus('reconnecting');

    console.log(
      `[PythonBridge] Scheduling restart attempt ${this.restartAttempts}/${PYTHON_MAX_RESTART_ATTEMPTS} in ${delay}ms`
    );

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.start();
        console.log(
          `[PythonBridge] Restart attempt ${this.restartAttempts} succeeded on port ${this.port}`
        );
      } catch (err) {
        console.error(
          `[PythonBridge] Restart attempt ${this.restartAttempts} failed:`,
          err
        );
        // _handleProcessExit will be called again from the error/exit handlers
        // when the failed start's process errors/exits
      }
    }, delay);
  }

  // ─── Health check ───────────────────────────────────────

  /**
   * Perform a health check request to the backend.
   */
  private healthCheck(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (!this.port) {
        resolve(false);
        return;
      }

      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/api/health',
          timeout: 2000,
        },
        (res) => {
          let body: string = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              resolve(data.code === 0);
            } catch {
              resolve(false);
            }
          });
        }
      );

      req.on('error', () => {
        resolve(false);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Poll health check endpoint until the backend is ready or timeout.
   */
  private async waitForHealthy(): Promise<void> {
    const startTime: number = Date.now();

    while (Date.now() - startTime < PYTHON_HEALTH_CHECK_TIMEOUT_MS) {
      const healthy: boolean = await this.healthCheck();
      if (healthy) {
        return;
      }
      await this.delay(PYTHON_HEALTH_CHECK_INTERVAL_MS);
    }

    throw new Error(
      `Python backend did not become healthy within ${PYTHON_HEALTH_CHECK_TIMEOUT_MS}ms`
    );
  }

  /**
   * Start periodic heartbeat checks.
   * Consecutive failures above threshold trigger a restart.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) return;
      const healthy: boolean = await this.healthCheck();
      if (!healthy) {
        this.consecutiveHeartbeatFailures++;
        console.warn(
          `[PythonBridge] Heartbeat check failed (${this.consecutiveHeartbeatFailures}/${PYTHON_HEARTBEAT_FAIL_THRESHOLD})`
        );
        if (this.consecutiveHeartbeatFailures >= PYTHON_HEARTBEAT_FAIL_THRESHOLD) {
          console.warn('[PythonBridge] Heartbeat failure threshold reached, restarting...');
          this.stopHeartbeat();
          this.isRunning = false;
          // Kill the (presumably hung) process if it still exists
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
            this.process = null;
          }
          this._handleProcessExit();
        }
      } else {
        // Reset on success
        if (this.consecutiveHeartbeatFailures > 0) {
          console.log('[PythonBridge] Heartbeat recovered');
        }
        this.consecutiveHeartbeatFailures = 0;
      }
    }, PYTHON_HEARTBEAT_INTERVAL_MS) as unknown as ReturnType<typeof setInterval>;
  }

  /**
   * Stop heartbeat checks.
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
