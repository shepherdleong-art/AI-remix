/**
 * HTTP client wrapper for communicating with the Python backend.
 *
 * In Electron production mode, requests go through IPC (Main Process proxy).
 * In development/browser mode, requests go directly to the backend via fetch.
 *
 * All responses follow the unified format: { code: number, message: string, data: T | null }
 */

export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS: number = 30000;

/**
 * Fallback port when the dev-port endpoint is unavailable.
 * This matches PORT_RANGE_START in the backend config.
 */
const DEFAULT_DEV_PORT: number = 18000;

/**
 * Cached backend port for browser dev mode.
 * Set to null to force re-fetch on the next resolveDevPort() call.
 */
let cachedDevPort: number | null = null;

/**
 * In browser dev mode, fetch the backend's actual port from the Vite dev
 * server middleware at `/__dev_port`. The Python backend writes its chosen
 * port to a file at startup, and the Vite middleware reads it dynamically.
 *
 * Falls back to DEFAULT_DEV_PORT (18000) if the endpoint is unavailable or
 * returns invalid data.
 *
 * @returns The backend port to use for direct HTTP requests
 */
async function resolveDevPort(): Promise<number> {
  if (cachedDevPort !== null) {
    return cachedDevPort;
  }
  try {
    const response: Response = await fetch('/__dev_port');
    const data: { port?: unknown } = await response.json();
    const port: number =
      typeof data.port === 'number' && data.port >= 18000 && data.port <= 18999
        ? data.port
        : DEFAULT_DEV_PORT;
    cachedDevPort = port;
    return port;
  } catch {
    // Endpoint unavailable (e.g. not in Vite dev mode) — use default
    cachedDevPort = DEFAULT_DEV_PORT;
    return cachedDevPort;
  }
}

/**
 * Invalidate the cached dev port so the next request re-fetches it.
 * Called when a network error occurs, in case the backend restarted on
 * a different port.
 */
function invalidateDevPort(): void {
  cachedDevPort = null;
}

/**
 * Get the backend base URL for direct HTTP access (binary streams, file
 * uploads, media src attributes, etc.).
 *
 * - In Electron mode: returns `http://127.0.0.1:${port}` using the
 *   IPC-discovered port (same port used by the IPC proxy).
 * - In browser dev mode: returns `http://127.0.0.1:${port}` using the
 *   port resolved from the `/__dev_port` middleware (which reads the
 *   port file written by the backend). This relies on the backend's
 *   CORS (`allow_origins=["*"]`) permitting cross-origin requests.
 *
 * Both modes return an absolute URL — no Vite proxy is needed.
 *
 * @returns The base URL to prepend to API paths
 */
export async function getBackendBaseUrl(): Promise<string> {
  if (isElectron()) {
    const electronApi = getElectronAPI();
    if (electronApi) {
      try {
        const port: number | null = await electronApi.getPythonPort();
        if (port) {
          return `http://127.0.0.1:${port}`;
        }
      } catch {
        // IPC call failed — fall through to browser mode
      }
    }
  }
  // Browser dev mode: resolve port via /__dev_port middleware
  const port: number = await resolveDevPort();
  return `http://127.0.0.1:${port}`;
}

/**
 * Check if running inside Electron with the exposed electronAPI.
 */
function isElectron(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).electronAPI;
}

/**
 * Get the Electron API if available.
 */
function getElectronAPI() {
  return (window as unknown as Record<string, unknown>).electronAPI as {
    backendRequest: (options: {
      method: string;
      endpoint: string;
      body?: unknown;
      headers?: Record<string, string>;
    }) => Promise<ApiResponse>;
    getPythonPort: () => Promise<number | null>;
  } | undefined;
}

/**
 * Send a request to the Python backend.
 *
 * @param endpoint - API endpoint path, e.g. "/api/health"
 * @param options - Request configuration
 * @returns Promise resolving to the standardized API response
 */
export async function apiRequest<T = unknown>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, headers = {}, timeout = DEFAULT_TIMEOUT_MS } = options;

  // Electron mode: route through IPC main process proxy
  if (isElectron()) {
    const electronApi = getElectronAPI();
    if (electronApi) {
      try {
        const response = await electronApi.backendRequest({
          method,
          endpoint,
          body,
          headers,
        });
        return response as ApiResponse<T>;
      } catch (error) {
        return {
          code: 50001,
          message: `IPC backend request failed: ${(error as Error).message}`,
          data: null,
        };
      }
    }
  }

  // Fallback: direct HTTP fetch (development / browser mode)
  try {
    const port: number = await resolveDevPort();
    const url: string = `http://127.0.0.1:${port}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Allow an external abort signal (e.g. user-cancelled long task) to also
    // abort the internal controller, so both timeout and manual cancel work.
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      signal: controller.signal,
    };

    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        code: response.status,
        message: `HTTP ${response.status}: ${response.statusText}`,
        data: null,
      };
    }

    const data: ApiResponse<T> = await response.json();
    return data;
  } catch (error) {
    // Invalidate cached port in case the backend restarted on a different port
    invalidateDevPort();
    return {
      code: 50001,
      message: `Network error: ${(error as Error).message}`,
      data: null,
    };
  }
}

/**
 * Convenience methods for common HTTP verbs.
 */
export const api = {
  get: <T = unknown>(endpoint: string, options?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(endpoint, { ...options, method: 'GET' }),

  post: <T = unknown>(endpoint: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(endpoint, { ...options, method: 'POST', body }),

  put: <T = unknown>(endpoint: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(endpoint, { ...options, method: 'PUT', body }),

  patch: <T = unknown>(endpoint: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(endpoint, { ...options, method: 'PATCH', body }),

  delete: <T = unknown>(endpoint: string, options?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(endpoint, { ...options, method: 'DELETE' }),
};

export default api;
