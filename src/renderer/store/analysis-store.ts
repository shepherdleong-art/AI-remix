/**
 * Zustand store for analysis state management.
 *
 * Manages:
 * - Analysis results keyed by material ID
 * - Async analysis triggering with backend polling
 * - Derived statistics (progress, counts)
 */
import { create } from 'zustand';
import type {
  AnalysisResult,
  AnalysisStatus,
  AnalysisResultResponse,
  SubStepProgress,
  Tag,
  Scene,
  Highlight,
  QualityReport,
  SubStepName,
} from '@/renderer/types/analysis';
import { apiRequest } from '@/renderer/api/backend-client';

// ─── Constants ────────────────────────────────────────────────

/** Polling interval in milliseconds */
const POLL_INTERVAL_MS: number = 800;

/** Maximum polling attempts before timeout */
const MAX_POLL_ATTEMPTS: number = 300;

/** Human-readable labels for each sub-step */
const SUB_STEP_LABELS: Record<SubStepName, string> = {
  scene_detection: '场景检测',
  quality_analysis: '质量分析',
  tag_generation: '标签生成',
  highlight_detection: '亮点识别',
};

/** Default sub-step list */
const DEFAULT_SUB_STEPS: SubStepProgress[] = (
  ['scene_detection', 'quality_analysis', 'tag_generation', 'highlight_detection'] as SubStepName[]
).map((step: SubStepName) => ({
  step,
  status: 'pending' as const,
  label: SUB_STEP_LABELS[step] || step,
}));

/** Build default sub-steps */
function buildDefaultSubSteps(): SubStepProgress[] {
  return DEFAULT_SUB_STEPS.map((s: SubStepProgress) => ({ ...s, status: 'pending' as const }));
}

// ─── Helpers ──────────────────────────────────────────────────

function buildEmptyResult(materialId: string): AnalysisResult {
  return {
    id: '',
    materialId,
    status: 'pending',
    sceneCount: 0,
    totalDuration: 0,
    qualityScore: 0,
    tags: [],
    scenes: [],
    highlights: [],
    qualityReport: null,
    subSteps: buildDefaultSubSteps(),
    progress: 0,
    errorMessage: '',
    analyzedAt: '',
  };
}

function mapResponseToResult(response: AnalysisResultResponse): AnalysisResult {
  return {
    id: response.analysisId,
    materialId: response.materialId,
    status: response.status,
    sceneCount: response.sceneCount,
    totalDuration: response.totalDuration,
    qualityScore: response.qualityScore,
    tags: response.tags,
    scenes: response.scenes,
    highlights: response.highlights,
    qualityReport: response.qualityReport,
    subSteps: buildDefaultSubSteps().map((s: SubStepProgress) => ({
      ...s,
      status: response.status === 'done' ? 'done' as const : s.status,
    })),
    progress: response.status === 'done' ? 100 : 0,
    errorMessage: response.status === 'error' ? '分析失败' : '',
    analyzedAt: response.analyzedAt,
  };
}

// ─── Store State ──────────────────────────────────────────────

export interface AnalysisState {
  // ─── State ────────────────────────────────────────────

  /** Analysis results keyed by material ID */
  analysisResults: Map<string, AnalysisResult>;

  /** Set of material IDs currently being polled */
  activePolls: Set<string>;

  /** Whether a batch analysis is running */
  isBatchRunning: boolean;

  /** Active filter tags for filtering results */
  activeFilterTags: string[];

  // ─── Actions ───────────────────────────────────────────

  /** Start analysis for a single material */
  analyzeMaterial: (materialId: string, filePath: string) => Promise<void>;

  /** Start batch analysis for multiple materials */
  analyzeAll: (items: Array<{ materialId: string; filePath: string }>) => Promise<void>;

  /** Get analysis result by material ID */
  getByMaterialId: (materialId: string) => AnalysisResult | undefined;

  /** Stop all active polling timers without clearing results */
  stopAllPolling: () => void;

  /** Clear all analysis results */
  clearResults: () => void;

  /** Clear result for a single material */
  clearResult: (materialId: string) => void;

  /** Set active filter tags */
  setActiveFilterTags: (tags: string[]) => void;

  /** Toggle a filter tag */
  toggleFilterTag: (tag: string) => void;

  // ─── Derived ───────────────────────────────────────────

  /** Overall analysis progress across all materials (0-100) */
  getOverallProgress: () => number;

  /** Count of pending analyses */
  getPendingCount: () => number;

  /** Count of completed analyses */
  getCompletedCount: () => number;

  /** Count of error analyses */
  getErrorCount: () => number;

  /** Average quality score across completed analyses */
  getAverageQualityScore: () => number;

  /** Total scene count across completed analyses */
  getTotalSceneCount: () => number;

  /** Get all unique tags across completed analyses */
  getAllTags: () => Tag[];
}

/**
 * Analysis Zustand store.
 *
 * Usage:
 *   const results = useAnalysisStore(s => s.analysisResults);
 *   const analyzeAll = useAnalysisStore(s => s.analyzeAll);
 */
export const useAnalysisStore = create<AnalysisState>((set, get) => {
  // ─── Internal polling helper ──────────────────────────

  const activeTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  function stopPolling(materialId: string): void {
    const timer = activeTimers.get(materialId);
    if (timer) {
      clearInterval(timer);
      activeTimers.delete(materialId);
    }
    set((state: AnalysisState) => {
      const newPolls = new Set(state.activePolls);
      newPolls.delete(materialId);
      return { activePolls: newPolls };
    });
  }

  async function pollAnalysisStatus(
    analysisId: string,
    materialId: string,
  ): Promise<void> {
    let attempts: number = 0;

    const intervalId = setInterval(async () => {
      attempts += 1;

      if (attempts >= MAX_POLL_ATTEMPTS) {
        stopPolling(materialId);
        set((state: AnalysisState) => {
          const newResults = new Map(state.analysisResults);
          const existing = newResults.get(materialId);
          if (existing) {
            newResults.set(materialId, {
              ...existing,
              status: 'error',
              errorMessage: '分析超时，请重试',
              subSteps: existing.subSteps.map((s: SubStepProgress) => ({
                ...s,
                status: 'error' as const,
              })),
            });
          }
          return { analysisResults: newResults };
        });
        return;
      }

      try {
        const statusResp = await apiRequest<{
          analysis_id: string;
          status: string;
          progress: number;
          sub_steps: SubStepProgress[];
          error_message: string;
        }>(`/api/analysis/status/${analysisId}`);

        if (statusResp.code !== 0 || !statusResp.data) {
          // Backend error while polling — keep retrying a few times
          if (attempts > 10) {
            stopPolling(materialId);
            set((state: AnalysisState) => {
              const newResults = new Map(state.analysisResults);
              const existing = newResults.get(materialId);
              if (existing) {
                newResults.set(materialId, {
                  ...existing,
                  status: 'error',
                  errorMessage: statusResp.message || '状态查询失败',
                });
              }
              return { analysisResults: newResults };
            });
          }
          return;
        }

        const statusData = statusResp.data;
        const mappedStatus: AnalysisStatus = statusData.status as AnalysisStatus;

        // Update intermediate progress
        set((state: AnalysisState) => {
          const newResults = new Map(state.analysisResults);
          const existing = newResults.get(materialId);
          if (existing) {
            const subSteps: SubStepProgress[] = statusData.sub_steps?.length
              ? statusData.sub_steps
              : existing.subSteps;
            newResults.set(materialId, {
              ...existing,
              status: mappedStatus,
              progress: statusData.progress ?? existing.progress,
              subSteps,
              errorMessage: statusData.error_message ?? '',
            });
          }
          return { analysisResults: newResults };
        });

        // If done or error, fetch full result and stop polling
        if (mappedStatus === 'done' || mappedStatus === 'error') {
          stopPolling(materialId);

          if (mappedStatus === 'done') {
            try {
              const resultResp = await apiRequest<AnalysisResultResponse>(
                `/api/analysis/result/${analysisId}`,
              );
              if (resultResp.code === 0 && resultResp.data) {
                const fullResult = mapResponseToResult(resultResp.data);
                set((state: AnalysisState) => {
                  const newResults = new Map(state.analysisResults);
                  newResults.set(materialId, fullResult);
                  return { analysisResults: newResults };
                });
              }
            } catch {
              // If result fetch fails, keep the status update from polling
            }
          }
        }
      } catch {
        // Network error — keep retrying
        if (attempts > 30) {
          stopPolling(materialId);
          set((state: AnalysisState) => {
            const newResults = new Map(state.analysisResults);
            const existing = newResults.get(materialId);
            if (existing) {
              newResults.set(materialId, {
                ...existing,
                status: 'error',
                errorMessage: '网络连接失败，请检查后端服务',
              });
            }
            return { analysisResults: newResults };
          });
        }
      }
    }, POLL_INTERVAL_MS);

    activeTimers.set(materialId, intervalId);
    set((state: AnalysisState) => {
      const newPolls = new Set(state.activePolls);
      newPolls.add(materialId);
      return { activePolls: newPolls };
    });
  }

  // ─── Store Implementation ─────────────────────────────

  return {
    analysisResults: new Map<string, AnalysisResult>(),
    activePolls: new Set<string>(),
    isBatchRunning: false,
    activeFilterTags: [],

    // ─── Actions ────────────────────────────────────────

    analyzeMaterial: async (materialId: string, filePath: string): Promise<void> => {
      // Set initial status
      set((state: AnalysisState) => {
        const newResults = new Map(state.analysisResults);
        newResults.set(materialId, {
          ...buildEmptyResult(materialId),
          status: 'processing',
        });
        return { analysisResults: newResults };
      });

      try {
        const resp = await apiRequest<{ analysis_id: string }>(
          '/api/analysis/start',
          {
            method: 'POST',
            body: { material_id: materialId, file_path: filePath },
          },
        );

        if (resp.code !== 0 || !resp.data) {
          set((state: AnalysisState) => {
            const newResults = new Map(state.analysisResults);
            const existing = newResults.get(materialId);
            if (existing) {
              newResults.set(materialId, {
                ...existing,
                status: 'error',
                errorMessage: resp.message || '启动分析失败',
              });
            }
            return { analysisResults: newResults };
          });
          return;
        }

        const analysisId: string = resp.data.analysis_id;

        // Update result with real ID
        set((state: AnalysisState) => {
          const newResults = new Map(state.analysisResults);
          const existing = newResults.get(materialId);
          if (existing) {
            newResults.set(materialId, { ...existing, id: analysisId });
          }
          return { analysisResults: newResults };
        });

        // Start polling for status
        await pollAnalysisStatus(analysisId, materialId);
      } catch (err) {
        set((state: AnalysisState) => {
          const newResults = new Map(state.analysisResults);
          const existing = newResults.get(materialId);
          if (existing) {
            newResults.set(materialId, {
              ...existing,
              status: 'error',
              errorMessage: `请求异常: ${(err as Error).message}`,
            });
          }
          return { analysisResults: newResults };
        });
      }
    },

    analyzeAll: async (
      items: Array<{ materialId: string; filePath: string }>,
    ): Promise<void> => {
      set({ isBatchRunning: true });

      // Set all to processing
      const initResults = new Map(get().analysisResults);
      for (const item of items) {
        initResults.set(item.materialId, {
          ...buildEmptyResult(item.materialId),
          status: 'processing',
        });
      }
      set({ analysisResults: initResults });

      // Start analysis for each material in parallel
      const promises: Promise<void>[] = items.map((item) =>
        get().analyzeMaterial(item.materialId, item.filePath),
      );

      await Promise.allSettled(promises);
      set({ isBatchRunning: false });
    },

    getByMaterialId: (materialId: string): AnalysisResult | undefined => {
      return get().analysisResults.get(materialId);
    },

    stopAllPolling: (): void => {
      for (const materialId of get().activePolls) {
        stopPolling(materialId);
      }
    },

    clearResults: (): void => {
      // Stop all active polls
      for (const materialId of get().activePolls) {
        stopPolling(materialId);
      }
      set({ analysisResults: new Map<string, AnalysisResult>() });
    },

    clearResult: (materialId: string): void => {
      stopPolling(materialId);
      set((state: AnalysisState) => {
        const newResults = new Map(state.analysisResults);
        newResults.delete(materialId);
        return { analysisResults: newResults };
      });
    },

    setActiveFilterTags: (tags: string[]): void => {
      set({ activeFilterTags: tags });
    },

    toggleFilterTag: (tag: string): void => {
      set((state: AnalysisState) => {
        const current = state.activeFilterTags;
        if (current.includes(tag)) {
          return { activeFilterTags: current.filter((t: string) => t !== tag) };
        }
        return { activeFilterTags: [...current, tag] };
      });
    },

    // ─── Derived ────────────────────────────────────────

    getOverallProgress: (): number => {
      const results = Array.from(get().analysisResults.values());
      if (results.length === 0) return 0;
      const totalProgress = results.reduce(
        (sum: number, r: AnalysisResult) => sum + r.progress,
        0,
      );
      return Math.round(totalProgress / results.length);
    },

    getPendingCount: (): number => {
      return Array.from(get().analysisResults.values()).filter(
        (r: AnalysisResult) => r.status === 'pending',
      ).length;
    },

    getCompletedCount: (): number => {
      return Array.from(get().analysisResults.values()).filter(
        (r: AnalysisResult) => r.status === 'done',
      ).length;
    },

    getErrorCount: (): number => {
      return Array.from(get().analysisResults.values()).filter(
        (r: AnalysisResult) => r.status === 'error',
      ).length;
    },

    getAverageQualityScore: (): number => {
      const completed = Array.from(get().analysisResults.values()).filter(
        (r: AnalysisResult) => r.status === 'done' && r.qualityScore > 0,
      );
      if (completed.length === 0) return 0;
      const total = completed.reduce(
        (sum: number, r: AnalysisResult) => sum + r.qualityScore,
        0,
      );
      return Math.round(total / completed.length);
    },

    getTotalSceneCount: (): number => {
      return Array.from(get().analysisResults.values()).reduce(
        (sum: number, r: AnalysisResult) => sum + r.sceneCount,
        0,
      );
    },

    getAllTags: (): Tag[] => {
      const tagMap = new Map<string, Tag>();
      for (const result of get().analysisResults.values()) {
        if (result.status === 'done') {
          for (const tag of result.tags) {
            if (!tagMap.has(tag.id)) {
              tagMap.set(tag.id, tag);
            }
          }
        }
      }
      return Array.from(tagMap.values());
    },
  };
});

export default useAnalysisStore;
