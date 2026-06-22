/**
 * Zustand store for render job management.
 *
 * Manages:
 * - Render job queue (add, start, cancel, retry, remove)
 * - Global render configuration
 * - HTTP polling for render progress (500ms interval)
 * - Derived computed values
 */
import { create } from 'zustand';
import type {
  RenderJob,
  RenderConfig,
  RenderStatus,
  ExportProgress,
  OutputFormat,
  ResolutionOption,
  FpsOption,
  QualityPreset,
  RenderJobResponse,
  ExportProgressResponse,
} from '@/renderer/types/renderer';
import {
  DEFAULT_RENDER_CONFIG,
  responseToRenderJob,
  renderConfigToSnakeCase,
  generateRenderId,
} from '@/renderer/types/renderer';
import { apiRequest } from '@/renderer/api/backend-client';

// ─── Polling Interval ─────────────────────────────────────────

/** Interval in milliseconds between render status polls */
const POLL_INTERVAL_MS: number = 500;

/** Maximum number of completed jobs to keep in memory */
const MAX_COMPLETED_HISTORY: number = 50;

// ─── Store State ──────────────────────────────────────────────

export interface RenderState {
  // ─── State ────────────────────────────────────────────

  /** All render jobs (active + history) */
  jobs: RenderJob[];

  /** ID of the currently selected/focused job */
  selectedJobId: string | null;

  /** Whether any job is currently rendering */
  isRendering: boolean;

  /** Global render configuration */
  config: RenderConfig;

  /** Current export progress for the active job */
  currentProgress: ExportProgress | null;

  /** Saved render configuration presets */
  presets: Array<{ id: string; name: string; config: RenderConfig }>;

  /** Whether to open the output folder after render completes */
  openFolderOnComplete: boolean;

  // ─── Polling Internals ────────────────────────────────

  /** Active polling timer IDs (keyed by jobId) */
  _pollTimers: Record<string, ReturnType<typeof setInterval>>;

  // ─── Actions ───────────────────────────────────────────

  /** Add a new render job from template ID and config */
  addJob: (templateId: string, templateName: string, config?: RenderConfig) => string;

  /** Start rendering a job (sends to backend, starts polling) */
  startRender: (jobId: string, template?: Record<string, unknown>, materials?: Array<Record<string, unknown>>) => Promise<void>;

  /** Cancel an active render job */
  cancelRender: (jobId: string) => Promise<void>;

  /** Retry a failed render job */
  retryJob: (jobId: string) => Promise<void>;

  /** Remove a job from the queue (only non-active jobs) */
  removeJob: (jobId: string) => Promise<void>;

  /** Stop all active polling timers without clearing job data */
  stopAllPolling: () => void;

  /** Clear all completed/cancelled/failed jobs */
  clearCompleted: () => Promise<void>;

  /** Update the global render configuration */
  updateConfig: (updates: Partial<RenderConfig>) => void;

  /** Select a job for viewing */
  selectJob: (jobId: string | null) => void;

  /** Load all jobs from the backend */
  loadJobs: () => Promise<void>;

  /** Save a render configuration as a named preset */
  savePreset: (name: string) => void;

  /** Delete a saved preset by ID */
  deletePreset: (presetId: string) => void;

  /** Apply a saved preset to the current config */
  applyPreset: (presetId: string) => void;

  /** Set open folder on complete preference */
  setOpenFolderOnComplete: (value: boolean) => void;

  /** Start polling for a specific job's progress */
  _startPolling: (jobId: string) => void;

  /** Stop polling for a specific job */
  _stopPolling: (jobId: string) => void;

  /** Update a job's state from poll response */
  _updateJobFromPoll: (jobId: string) => Promise<void>;

  // ─── Derived ───────────────────────────────────────────

  /** Get the currently active (processing/queued) job */
  activeJob: () => RenderJob | undefined;

  /** Get all completed jobs */
  completedJobs: () => RenderJob[];

  /** Get all failed jobs */
  failedJobs: () => RenderJob[];

  /** Get the number of jobs waiting in queue */
  queueLength: () => number;

  /** Get a job by ID */
  getJobById: (jobId: string) => RenderJob | undefined;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * Serialize a preset config for localStorage persistence.
 */
function presetsToJson(
  presets: Array<{ id: string; name: string; config: RenderConfig }>,
): string {
  return JSON.stringify(presets);
}

/**
 * Deserialize presets from localStorage.
 */
function presetsFromJson(
  json: string,
): Array<{ id: string; name: string; config: RenderConfig }> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (p: unknown) =>
          p !== null &&
          typeof p === 'object' &&
          typeof (p as Record<string, unknown>).id === 'string' &&
          typeof (p as Record<string, unknown>).name === 'string' &&
          (p as Record<string, unknown>).config !== undefined,
      ) as Array<{ id: string; name: string; config: RenderConfig }>;
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/**
 * Load presets from localStorage.
 */
function loadPresets(): Array<{ id: string; name: string; config: RenderConfig }> {
  if (typeof window === 'undefined') return [];
  const raw: string | null = localStorage.getItem('mashup_render_presets');
  if (!raw) return [];
  return presetsFromJson(raw);
}

/**
 * Save presets to localStorage.
 */
function savePresetsToStorage(
  presets: Array<{ id: string; name: string; config: RenderConfig }>,
): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem('mashup_render_presets', presetsToJson(presets));
}

// ─── Store Implementation ─────────────────────────────────────

export const useRenderStore = create<RenderState>((set, get) => ({
  // ─── Initial State ────────────────────────────────────

  jobs: [],
  selectedJobId: null,
  isRendering: false,
  config: { ...DEFAULT_RENDER_CONFIG },
  currentProgress: null,
  presets: loadPresets(),
  openFolderOnComplete: true,
  _pollTimers: {},

  // ─── Actions ───────────────────────────────────────────

  addJob: (
    templateId: string,
    templateName: string,
    config?: RenderConfig,
  ): string => {
    const now: string = new Date().toISOString();
    const jobConfig: RenderConfig = config || { ...get().config };
    const job: RenderJob = {
      id: generateRenderId(),
      templateId,
      templateName,
      status: 'pending',
      progress: 0,
      outputPath: '',
      outputFormat: jobConfig.outputFormat,
      resolution: jobConfig.resolution,
      fps: jobConfig.fps,
      quality: jobConfig.quality,
      startedAt: now,
      completedAt: '',
      estimatedRemaining: 0,
      error: '',
      currentStep: '等待开始...',
      thumbnail: '',
      config: { ...jobConfig },
    };

    set((state: RenderState) => ({
      jobs: [...state.jobs, job],
      selectedJobId: job.id,
    }));

    return job.id;
  },

  startRender: async (jobId: string, template?: Record<string, unknown>, materials?: Array<Record<string, unknown>>): Promise<void> => {
    const job: RenderJob | undefined = get().jobs.find((j: RenderJob) => j.id === jobId);
    if (!job) return;

    // Mark as queued locally
    set((state: RenderState) => ({
      jobs: state.jobs.map((j: RenderJob) =>
        j.id === jobId
          ? { ...j, status: 'queued' as RenderStatus, currentStep: '正在提交渲染任务...' }
          : j,
      ),
      isRendering: true,
    }));

    try {
      const resp = await apiRequest<RenderJobResponse>('/api/render/start', {
        method: 'POST',
        body: {
          template_id: job.templateId,
          template_name: job.templateName,
          config: renderConfigToSnakeCase(job.config),
          template: template || {},
          materials: materials || [],
        },
      });

      if (resp.code === 0 && resp.data) {
        const updated: RenderJob = responseToRenderJob(resp.data);
        set((state: RenderState) => ({
          jobs: state.jobs.map((j: RenderJob) =>
            j.id === jobId ? updated : j,
          ),
        }));
        // Start polling for progress
        get()._startPolling(jobId);
      } else {
        set((state: RenderState) => ({
          jobs: state.jobs.map((j: RenderJob) =>
            j.id === jobId
              ? {
                  ...j,
                  status: 'failed' as RenderStatus,
                  error: resp.message || '提交渲染任务失败',
                  completedAt: new Date().toISOString(),
                }
              : j,
          ),
          isRendering: false,
        }));
      }
    } catch (err) {
      set((state: RenderState) => ({
        jobs: state.jobs.map((j: RenderJob) =>
          j.id === jobId
            ? {
                ...j,
                status: 'failed' as RenderStatus,
                error: `网络错误: ${(err as Error).message}`,
                completedAt: new Date().toISOString(),
              }
            : j,
        ),
        isRendering: false,
      }));
    }
  },

  cancelRender: async (jobId: string): Promise<void> => {
    get()._stopPolling(jobId);

    try {
      await apiRequest(`/api/render/cancel/${jobId}`, { method: 'POST' });
    } catch {
      // Best-effort cancel
    }

    set((state: RenderState) => ({
      jobs: state.jobs.map((j: RenderJob) =>
        j.id === jobId
          ? {
              ...j,
              status: 'cancelled' as RenderStatus,
              currentStep: '已取消',
              completedAt: new Date().toISOString(),
            }
          : j,
      ),
      isRendering: false,
      currentProgress: null,
    }));
  },

  retryJob: async (jobId: string): Promise<void> => {
    const job: RenderJob | undefined = get().jobs.find((j: RenderJob) => j.id === jobId);
    if (!job || (job.status !== 'failed' && job.status !== 'cancelled')) return;

    // Reset the job and restart
    const now: string = new Date().toISOString();
    set((state: RenderState) => ({
      jobs: state.jobs.map((j: RenderJob) =>
        j.id === jobId
          ? {
              ...j,
              status: 'pending' as RenderStatus,
              progress: 0,
              error: '',
              currentStep: '重新渲染...',
              startedAt: now,
              completedAt: '',
              estimatedRemaining: 0,
            }
          : j,
      ),
    }));

    await get().startRender(jobId);
  },

  removeJob: async (jobId: string): Promise<void> => {
    const job: RenderJob | undefined = get().jobs.find((j: RenderJob) => j.id === jobId);
    if (!job) return;

    // Only allow removing completed/failed/cancelled jobs
    if (job.status === 'processing' || job.status === 'queued') {
      return;
    }

    get()._stopPolling(jobId);

    try {
      await apiRequest(`/api/render/jobs/${jobId}`, { method: 'DELETE' });
    } catch {
      // Best-effort delete
    }

    set((state: RenderState) => {
      const newJobs: RenderJob[] = state.jobs.filter((j: RenderJob) => j.id !== jobId);
      return {
        jobs: newJobs,
        selectedJobId: state.selectedJobId === jobId ? null : state.selectedJobId,
      };
    });
  },

  stopAllPolling: (): void => {
    const timers = get()._pollTimers;
    for (const jobId of Object.keys(timers)) {
      get()._stopPolling(jobId);
    }
  },

  clearCompleted: async (): Promise<void> => {
    const completedIds: string[] = get()
      .jobs.filter(
        (j: RenderJob) =>
          j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled',
      )
      .map((j: RenderJob) => j.id);

    // Stop any remaining poll timers
    completedIds.forEach((id: string) => get()._stopPolling(id));

    // Delete from backend (best effort)
    for (const id of completedIds) {
      try {
        await apiRequest(`/api/render/jobs/${id}`, { method: 'DELETE' });
      } catch {
        // Continue
      }
    }

    set((state: RenderState) => ({
      jobs: state.jobs.filter(
        (j: RenderJob) =>
          j.status === 'pending' || j.status === 'queued' || j.status === 'processing',
      ),
    }));
  },

  updateConfig: (updates: Partial<RenderConfig>): void => {
    set((state: RenderState) => ({
      config: { ...state.config, ...updates },
    }));
  },

  selectJob: (jobId: string | null): void => {
    set({ selectedJobId: jobId });
  },

  loadJobs: async (): Promise<void> => {
    try {
      const resp = await apiRequest<RenderJobResponse[]>('/api/render/jobs');
      if (resp.code === 0 && resp.data) {
        const loaded: RenderJob[] = resp.data.map(responseToRenderJob);

        // Start polling for any processing/queued jobs
        loaded.forEach((j: RenderJob) => {
          if (j.status === 'processing' || j.status === 'queued') {
            get()._startPolling(j.id);
          }
        });

        set((state: RenderState) => {
          // Merge with existing jobs, preferring backend data
          const existingMap = new Map(
            state.jobs.map((j: RenderJob) => [j.id, j]),
          );
          loaded.forEach((j: RenderJob) => {
            existingMap.set(j.id, j);
          });
          return {
            jobs: Array.from(existingMap.values()),
            isRendering: loaded.some(
              (j: RenderJob) => j.status === 'processing' || j.status === 'queued',
            ),
          };
        });
      }
    } catch {
      // Silently fail — use local state
    }
  },

  savePreset: (name: string): void => {
    const presets = [...get().presets];
    if (presets.length >= 3) return; // MAX_RENDER_PRESETS

    const preset = {
      id: generateRenderId(),
      name,
      config: { ...get().config },
    };

    const updated: Array<{ id: string; name: string; config: RenderConfig }> = [
      ...presets,
      preset,
    ];
    savePresetsToStorage(updated);
    set({ presets: updated });
  },

  deletePreset: (presetId: string): void => {
    const updated: Array<{ id: string; name: string; config: RenderConfig }> = get().presets.filter(
      (p) => p.id !== presetId,
    );
    savePresetsToStorage(updated);
    set({ presets: updated });
  },

  applyPreset: (presetId: string): void => {
    const preset = get().presets.find((p) => p.id === presetId);
    if (preset) {
      set({ config: { ...preset.config } });
    }
  },

  setOpenFolderOnComplete: (value: boolean): void => {
    set({ openFolderOnComplete: value });
  },

  // ─── Polling ───────────────────────────────────────────

  _startPolling: (jobId: string): void => {
    // Avoid duplicate poll timers
    const existing: Record<string, ReturnType<typeof setInterval>> = get()._pollTimers;
    if (existing[jobId]) return;

    // Initial poll immediately
    get()._updateJobFromPoll(jobId);

    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      get()._updateJobFromPoll(jobId);
    }, POLL_INTERVAL_MS);

    set((state: RenderState) => ({
      _pollTimers: { ...state._pollTimers, [jobId]: timer },
    }));
  },

  _stopPolling: (jobId: string): void => {
    const existing: Record<string, ReturnType<typeof setInterval>> = get()._pollTimers;
    if (existing[jobId]) {
      clearInterval(existing[jobId]);
      const newTimers: Record<string, ReturnType<typeof setInterval>> = { ...existing };
      delete newTimers[jobId];
      set({ _pollTimers: newTimers });
    }
  },

  _updateJobFromPoll: async (jobId: string): Promise<void> => {
    try {
      const resp = await apiRequest<RenderJobResponse>(
        `/api/render/status/${jobId}`,
      );

      if (resp.code === 0 && resp.data) {
        const updated: RenderJob = responseToRenderJob(resp.data);

        set((state: RenderState) => {
          const newJobs: RenderJob[] = state.jobs.map((j: RenderJob) =>
            j.id === jobId ? updated : j,
          );

          // Check if rendering is finished
          const isDone: boolean =
            updated.status === 'completed' ||
            updated.status === 'failed' ||
            updated.status === 'cancelled';

          // Update progress tracking
          const newProgress: ExportProgress | null = isDone
            ? null
            : {
                jobId: updated.id,
                progress: updated.progress,
                currentStep: updated.currentStep,
                estimatedRemaining: updated.estimatedRemaining,
                framesProcessed: 0,
                totalFrames: 0,
              };

          // Check for any remaining active jobs
          const stillRendering: boolean = newJobs.some(
            (j: RenderJob) => j.status === 'processing' || j.status === 'queued',
          );

          return {
            jobs: newJobs,
            isRendering: stillRendering,
            currentProgress: newProgress,
          };
        });

        // Stop polling if done
        if (
          updated.status === 'completed' ||
          updated.status === 'failed' ||
          updated.status === 'cancelled'
        ) {
          get()._stopPolling(jobId);
        }
      } else if (resp.code !== 0) {
        // Backend returned an error — job might not exist
        set((state: RenderState) => ({
          jobs: state.jobs.map((j: RenderJob) =>
            j.id === jobId
              ? {
                  ...j,
                  status: 'failed' as RenderStatus,
                  error: resp.message || '查询渲染状态失败',
                }
              : j,
          ),
        }));
        get()._stopPolling(jobId);
      }
    } catch (err) {
      // Network error — keep polling, don't fail immediately
      // Only fail after consecutive errors would be too complex; just retry next interval
      console.warn(`[RenderStore] Poll error for job ${jobId}:`, err);
    }
  },

  // ─── Derived ───────────────────────────────────────────

  activeJob: (): RenderJob | undefined => {
    return get().jobs.find(
      (j: RenderJob) => j.status === 'processing' || j.status === 'queued',
    );
  },

  completedJobs: (): RenderJob[] => {
    return get()
      .jobs.filter((j: RenderJob) => j.status === 'completed')
      .sort(
        (a: RenderJob, b: RenderJob) =>
          new Date(b.completedAt || b.startedAt).getTime() -
          new Date(a.completedAt || a.startedAt).getTime(),
      );
  },

  failedJobs: (): RenderJob[] => {
    return get().jobs.filter(
      (j: RenderJob) => j.status === 'failed' || j.status === 'cancelled',
    );
  },

  queueLength: (): number => {
    return get().jobs.filter(
      (j: RenderJob) => j.status === 'pending' || j.status === 'queued',
    ).length;
  },

  getJobById: (jobId: string): RenderJob | undefined => {
    return get().jobs.find((j: RenderJob) => j.id === jobId);
  },
}));

export default useRenderStore;
