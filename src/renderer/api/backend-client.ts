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
}

const DEFAULT_TIMEOUT_MS: number = 30000;

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
    // Try to discover port from global window var (set by start script), URL param, or default
    const port: number =
      (window as unknown as Record<string, number>).__BACKEND_PORT__ ||
      parseInt(new URLSearchParams(window.location.search).get('backend_port') || '') ||
      18000;
    const url: string = `http://127.0.0.1:${port}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

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
