/**
 * React hook for resolving the backend base URL.
 *
 * Used by components that need synchronous access to the backend URL
 * (e.g. <video src>, <audio src>, <img src>).
 *
 * Returns an absolute URL in all modes:
 * - Initial value: `http://127.0.0.1:18000` (default port, correct in the
 *   common case where 18000 is free). This ensures media elements have a
 *   valid URL on first render.
 * - After mount: resolves the actual port via `getBackendBaseUrl()` and
 *   updates if different. In browser mode this reads the port file through
 *   the `/__dev_port` middleware; in Electron mode it uses IPC.
 *
 * All requests go directly to the backend (CORS allows `*`), no Vite
 * proxy is involved.
 */

import { useState, useEffect } from 'react';
import { getBackendBaseUrl } from './backend-client';

const DEFAULT_BACKEND_URL: string = 'http://127.0.0.1:18000';

export function useBackendUrl(): string {
  const [url, setUrl] = useState<string>(DEFAULT_BACKEND_URL);

  useEffect(() => {
    let cancelled: boolean = false;
    getBackendBaseUrl().then((resolved: string) => {
      if (!cancelled && resolved !== url) {
        setUrl(resolved);
      }
    });
    return (): void => {
      cancelled = true;
    };
  }, []);

  return url;
}

export default useBackendUrl;
