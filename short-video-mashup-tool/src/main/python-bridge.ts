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
} from './constants';

export interface PythonBridgeOptions {
  /** Path to the Python script to execute */
  scriptPath: string;
  /** Python executable (default: 'python') */
  pythonExecutable?: string;
  /** Additional command-line arguments */
  args?: string[];
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
 */
export class PythonBridge {
  private scriptPath: string;
  private pythonExecutable: string;
  private extraArgs: string[];
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private isRunning: boolean = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PythonBridgeOptions) {
    this.scriptPath = options.scriptPath;
    this.pythonExecutable = options.pythonExecutable || PYTHON_EXECUTABLE;
    this.extraArgs = options.args || [];
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
    });

    this.process.on('exit', (code: number | null, signal: string | null) => {
      console.log(`[PythonBridge] Process exited with code=${code}, signal=${signal}`);
      this.isRunning = false;
      this.stopHeartbeat();
    });

    this.isRunning = true;

    // Wait for the backend to be healthy
    await this.waitForHealthy();

    // Start heartbeat once healthy
    this.startHeartbeat();

    console.log(`[PythonBridge] Backend is ready on port ${this.port}`);
    return this.port!;
  }

  /**
   * Stop the Python backend gracefully.
   * Sends SIGTERM first, then SIGKILL after a timeout.
   */
  async stop(): Promise<void> {
    if (!this.process || !this.isRunning) {
      console.log('[PythonBridge] No process to stop');
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
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) return;
      const healthy: boolean = await this.healthCheck();
      if (!healthy) {
        console.warn('[PythonBridge] Heartbeat check failed');
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
