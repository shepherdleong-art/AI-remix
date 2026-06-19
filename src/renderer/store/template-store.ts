/**
 * Zustand store for template management.
 *
 * Manages:
 * - Template CRUD operations (create, load, save, delete, duplicate)
 * - Segment manipulation (add, remove, reorder, update)
 * - Transition and filter management
 * - Undo/redo history
 * - Import/export as JSON
 */
import { create } from 'zustand';
import type {
  Template,
  Segment,
  Transition,
  Filter,
  TextOverlay,
  TransitionType,
  FilterType,
  TemplateResponse,
} from '@/renderer/types/template';
import {
  createDefaultTemplate,
  createDefaultSegment,
  DEFAULT_TRANSITION,
  generateId,
  templateToRequest,
  responseToTemplate,
} from '@/renderer/types/template';
import { apiRequest } from '@/renderer/api/backend-client';

// ─── Undo History Types ─────────────────────────────────────

interface UndoEntry {
  /** Snapshot of the template segments at this point in history */
  segments: Segment[];
  /** Description of the action that led to this state */
  actionLabel: string;
}

// ─── Store State ─────────────────────────────────────────────

export interface TemplateState {
  // ─── State ────────────────────────────────────────────

  /** All loaded templates */
  templates: Template[];

  /** ID of the currently active editing template */
  currentTemplateId: string | null;

  /** ID of the currently selected segment on the timeline */
  selectedSegmentId: string | null;

  /** Whether there are unsaved changes */
  isDirty: boolean;

  /** Whether the full template editor is active */
  isEditing: boolean;

  /** Whether the template market browser is open */
  isMarketOpen: boolean;

  /** Undo history stack */
  undoStack: UndoEntry[];

  /** Redo history stack */
  redoStack: UndoEntry[];

  /** Max undo stack depth */
  maxUndoDepth: number;

  // ─── CRUD Actions ─────────────────────────────────────

  /** Create a new blank template and set as current */
  create: () => void;

  /** Load templates from the backend API */
  loadAll: () => Promise<void>;

  /** Load builtin templates from backend */
  loadBuiltin: () => Promise<Template[]>;

  /** Save the current template to backend */
  save: () => Promise<boolean>;

  /** Reload a specific template from backend */
  reload: (templateId: string) => Promise<void>;

  /** Delete the current template */
  deleteCurrent: () => Promise<void>;

  /** Delete a template by ID */
  deleteTemplate: (templateId: string) => Promise<void>;

  /** Set the current editing template by ID */
  setCurrentTemplate: (templateId: string) => void;

  /** Duplicate the current template */
  duplicate: () => Promise<void>;

  /** Update template-level properties (name, description, etc.) */
  updateTemplateMeta: (updates: Partial<Pick<Template, 'name' | 'description' | 'category' | 'tags' | 'thumbnail'>>) => void;

  /** Set the default transition for the entire template */
  setTemplateTransition: (transition: Transition) => void;

  /** Export the current template as a JSON blob (returns the JSON string) */
  exportJson: () => string;

  /** Import a template from a JSON blob */
  importJson: (jsonStr: string) => void;

  // ─── Segment Actions ──────────────────────────────────

  /** Add a new segment at the end */
  addSegment: (materialId?: string) => void;

  /** Remove a segment by ID */
  removeSegment: (segmentId: string) => void;

  /** Reorder segments (drag-and-drop) */
  reorderSegments: (fromIndex: number, toIndex: number) => void;

  /** Update a single segment's properties */
  updateSegment: (segmentId: string, updates: Partial<Segment>) => void;

  /** Set the selected segment */
  selectSegment: (segmentId: string | null) => void;

  /** Clone/duplicate a segment */
  duplicateSegment: (segmentId: string) => void;

  // ─── Filter Actions ───────────────────────────────────

  /** Add a filter to a segment */
  addFilter: (segmentId: string, filter: Filter) => void;

  /** Remove a filter from a segment by type */
  removeFilter: (segmentId: string, filterType: FilterType) => void;

  /** Update a filter value */
  updateFilter: (segmentId: string, filterType: FilterType, value: number) => void;

  // ─── Text Overlay Actions ─────────────────────────────

  /** Set or update text overlay on a segment */
  setTextOverlay: (segmentId: string, overlay: TextOverlay | null) => void;

  // ─── Undo/Redo ────────────────────────────────────────

  /** Undo last action */
  undo: () => void;

  /** Redo last undone action */
  redo: () => void;

  /** Push current state to undo stack */
  pushUndo: (actionLabel: string) => void;

  // ─── Market ───────────────────────────────────────────

  /** Toggle template market open/close */
  setMarketOpen: (open: boolean) => void;

  /** Use a template from the market (copies it as current) */
  useTemplate: (template: Template) => void;

  /** Set editing mode */
  setEditing: (editing: boolean) => void;

  // ─── Derived ──────────────────────────────────────────

  /** Get the current template object */
  currentTemplate: () => Template | null;

  /** Get total duration of the current template */
  totalDuration: () => number;

  /** Get segment count of the current template */
  segmentCount: () => number;

  /** Check if undo is available */
  canUndo: () => boolean;

  /** Check if redo is available */
  canRedo: () => boolean;

  /** Get a segment by ID */
  getSegmentById: (segmentId: string) => Segment | undefined;
}

// ─── Helpers ─────────────────────────────────────────────────

function recalcDuration(segments: Segment[]): number {
  return segments.reduce((sum: number, s: Segment) => sum + s.duration, 0);
}

function reorderArray<T>(arr: T[], fromIndex: number, toIndex: number): T[] {
  const result: T[] = [...arr];
  const [item] = result.splice(fromIndex, 1);
  result.splice(toIndex, 0, item);
  return result;
}

function mapCurrentTemplate(
  state: TemplateState,
  updater: (t: Template) => Template,
): { templates: Template[]; currentTemplateId: string | null } {
  const newTemplates: Template[] = state.templates.map((t: Template) => {
    if (t.id === state.currentTemplateId) {
      return { ...updater(t), updatedAt: new Date().toISOString() };
    }
    return t;
  });
  return { templates: newTemplates, currentTemplateId: state.currentTemplateId };
}

function cloneSegments(segs: Segment[]): Segment[] {
  return segs.map((s: Segment) => ({
    ...s,
    id: generateId(),
    transitionIn: { ...s.transitionIn },
    transitionOut: { ...s.transitionOut },
    filters: s.filters.map((f: Filter) => ({ ...f })),
    textOverlay: s.textOverlay ? { ...s.textOverlay } : null,
  }));
}

// ─── Store Implementation ───────────────────────────────────

export const useTemplateStore = create<TemplateState>((set, get) => ({
  // ─── Initial State ────────────────────────────────────
  templates: [],
  currentTemplateId: null,
  selectedSegmentId: null,
  isDirty: false,
  isEditing: false,
  isMarketOpen: false,
  undoStack: [],
  redoStack: [],
  maxUndoDepth: 50,

  // ─── CRUD Actions ─────────────────────────────────────

  create: (): void => {
    const newTemplate: Template = createDefaultTemplate();
    set((state: TemplateState) => ({
      templates: [...state.templates, newTemplate],
      currentTemplateId: newTemplate.id,
      selectedSegmentId: null,
      isDirty: false,
      isEditing: true,
      undoStack: [],
      redoStack: [],
    }));
  },

  loadAll: async (): Promise<void> => {
    try {
      const resp = await apiRequest<TemplateResponse[]>('/api/templates');
      if (resp.code === 0 && resp.data) {
        const templates: Template[] = resp.data.map(responseToTemplate);
        set({ templates });
      }
    } catch {
      // Silently fail — templates will be empty
    }
  },

  loadBuiltin: async (): Promise<Template[]> => {
    try {
      const resp = await apiRequest<TemplateResponse[]>('/api/templates/builtin');
      if (resp.code === 0 && resp.data) {
        const builtins: Template[] = resp.data.map(responseToTemplate);
        set((state: TemplateState) => {
          const existingIds = new Set(state.templates.map((t: Template) => t.id));
          const newOnes = builtins.filter((b: Template) => !existingIds.has(b.id));
          return {
            templates: [...state.templates, ...newOnes],
          };
        });
        return builtins;
      }
    } catch {
      // Silently fail
    }
    return [];
  },

  save: async (): Promise<boolean> => {
    const current: Template | null = get().currentTemplate();
    if (!current) return false;

    try {
      const body: Record<string, unknown> = templateToRequest(current);
      const resp = await apiRequest<TemplateResponse>(
        `/api/templates/${current.id}`,
        {
          method: 'PUT',
          body,
        },
      );

      if (resp.code === 0 && resp.data) {
        const updated: Template = responseToTemplate(resp.data);
        set((state: TemplateState) => {
          const newTemplates: Template[] = state.templates.map((t: Template) =>
            t.id === updated.id ? updated : t,
          );
          return { templates: newTemplates, isDirty: false };
        });
        return true;
      }

      // If PUT returns 404, try POST (create new)
      if (resp.code === 404 || resp.code === 40001) {
        const postResp = await apiRequest<TemplateResponse>('/api/templates', {
          method: 'POST',
          body,
        });
        if (postResp.code === 0 && postResp.data) {
          const created: Template = responseToTemplate(postResp.data);
          set((state: TemplateState) => {
            const newTemplates: Template[] = state.templates.map((t: Template) =>
              t.id === current.id ? created : t,
            );
            return {
              templates: newTemplates,
              currentTemplateId: created.id,
              isDirty: false,
            };
          });
          return true;
        }
      }
    } catch {
      // Save failed
    }
    return false;
  },

  reload: async (templateId: string): Promise<void> => {
    try {
      const resp = await apiRequest<TemplateResponse>(`/api/templates/${templateId}`);
      if (resp.code === 0 && resp.data) {
        const template: Template = responseToTemplate(resp.data);
        set((state: TemplateState) => ({
          templates: state.templates.map((t: Template) =>
            t.id === templateId ? template : t,
          ),
        }));
      }
    } catch {
      // Reload failed silently
    }
  },

  deleteCurrent: async (): Promise<void> => {
    const currentId: string | null = get().currentTemplateId;
    if (!currentId) return;
    await get().deleteTemplate(currentId);
    set({ currentTemplateId: null, selectedSegmentId: null, isEditing: false, isDirty: false });
  },

  deleteTemplate: async (templateId: string): Promise<void> => {
    try {
      await apiRequest(`/api/templates/${templateId}`, { method: 'DELETE' });
    } catch {
      // Best effort deletion
    }
    set((state: TemplateState) => ({
      templates: state.templates.filter((t: Template) => t.id !== templateId),
    }));
  },

  setCurrentTemplate: (templateId: string): void => {
    set({
      currentTemplateId: templateId,
      selectedSegmentId: null,
      isEditing: true,
      undoStack: [],
      redoStack: [],
    });
  },

  duplicate: async (): Promise<void> => {
    const currentId: string | null = get().currentTemplateId;
    if (!currentId) return;

    try {
      const resp = await apiRequest<TemplateResponse>(
        `/api/templates/${currentId}/duplicate`,
        { method: 'POST' },
      );
      if (resp.code === 0 && resp.data) {
        const duplicated: Template = responseToTemplate(resp.data);
        set((state: TemplateState) => ({
          templates: [...state.templates, duplicated],
          currentTemplateId: duplicated.id,
          isDirty: false,
        }));
        return;
      }
    } catch {
      // Fallback: client-side duplicate
    }

    // Client-side fallback
    const current: Template | null = get().currentTemplate();
    if (!current) return;

    const now: string = new Date().toISOString();
    const dup: Template = {
      ...current,
      id: generateId(),
      name: `${current.name} (副本)`,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
      segments: cloneSegments(current.segments),
    };

    set((state: TemplateState) => ({
      templates: [...state.templates, dup],
      currentTemplateId: dup.id,
      isDirty: true,
    }));
  },

  updateTemplateMeta: (
    updates: Partial<Pick<Template, 'name' | 'description' | 'category' | 'tags' | 'thumbnail'>>,
  ): void => {
    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(get(), (t: Template) => ({
      ...t,
      ...updates,
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  setTemplateTransition: (transition: Transition): void => {
    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(get(), (t: Template) => ({
      ...t,
      transition: { ...transition },
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  exportJson: (): string => {
    const current: Template | null = get().currentTemplate();
    if (!current) return '{}';
    return JSON.stringify(current, null, 2);
  },

  importJson: (jsonStr: string): void => {
    try {
      const data: unknown = JSON.parse(jsonStr);
      const parsed = data as Record<string, unknown>;

      if (!parsed.segments || !Array.isArray(parsed.segments)) {
        console.warn('Invalid template JSON: missing segments array');
        return;
      }

      const now: string = new Date().toISOString();
      const imported: Template = {
        id: generateId(),
        name: (parsed.name as string) || '导入模板',
        description: (parsed.description as string) || '',
        category: (parsed.category as string) || 'custom',
        thumbnail: (parsed.thumbnail as string) || '',
        segments: (parsed.segments as Segment[]).map((s: Segment, i: number) => ({
          ...s,
          id: generateId(),
          order: i,
          duration: s.endTime - s.startTime,
        })),
        totalDuration: 0,
        transition: (parsed.transition as Transition) || { ...DEFAULT_TRANSITION },
        tags: (parsed.tags as string[]) || [],
        createdAt: now,
        updatedAt: now,
        isBuiltin: false,
      };
      imported.totalDuration = recalcDuration(imported.segments);

      set((state: TemplateState) => ({
        templates: [...state.templates, imported],
        currentTemplateId: imported.id,
        selectedSegmentId: null,
        isDirty: true,
        isEditing: true,
        undoStack: [],
        redoStack: [],
      }));
    } catch (err) {
      console.error('Failed to import template JSON:', err);
    }
  },

  // ─── Segment Actions ──────────────────────────────────

  addSegment: (materialId: string = ''): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;
    if (current.segments.length >= 100) return; // MAX_SEGMENTS

    get().pushUndo('添加片段');

    const order: number = current.segments.length;
    const newSegment: Segment = createDefaultSegment(materialId, order);

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(
      state,
      (t: Template) => ({
        ...t,
        segments: [...t.segments, newSegment],
        totalDuration: recalcDuration([...t.segments, newSegment]),
      }),
    );
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true, selectedSegmentId: newSegment.id });
  },

  removeSegment: (segmentId: string): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;
    if (current.segments.length <= 1) {
      // Allow removing the last segment — just clear it
      const now: string = new Date().toISOString();
      const emptySegs: Segment[] = [];
      set((s: TemplateState) => ({
        templates: s.templates.map((t: Template) =>
          t.id === s.currentTemplateId
            ? { ...t, segments: [], totalDuration: 0, updatedAt: now }
            : t,
        ),
        selectedSegmentId: null,
        isDirty: true,
      }));
      return;
    }

    get().pushUndo('删除片段');

    const filteredSegs: Segment[] = current.segments
      .filter((s: Segment) => s.id !== segmentId)
      .map((s: Segment, i: number) => ({ ...s, order: i }));

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(
      state,
      (t: Template) => ({
        ...t,
        segments: filteredSegs,
        totalDuration: recalcDuration(filteredSegs),
      }),
    );

    const newSelectedId: string | null =
      state.selectedSegmentId === segmentId ? null : state.selectedSegmentId;

    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true, selectedSegmentId: newSelectedId });
  },

  reorderSegments: (fromIndex: number, toIndex: number): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;
    if (fromIndex === toIndex) return;

    get().pushUndo('重新排序片段');

    const reordered: Segment[] = reorderArray(current.segments, fromIndex, toIndex)
      .map((s: Segment, i: number) => ({ ...s, order: i }));

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: reordered,
      totalDuration: recalcDuration(reordered),
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  updateSegment: (segmentId: string, updates: Partial<Segment>): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    const updatedSegs: Segment[] = current.segments.map((s: Segment) => {
      if (s.id !== segmentId) return s;
      const merged: Segment = { ...s, ...updates } as Segment;
      // Recalculate duration if start/end times changed
      if (updates.startTime !== undefined || updates.endTime !== undefined) {
        merged.duration = Math.max(0.1, merged.endTime - merged.startTime);
      }
      return merged;
    });

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: updatedSegs,
      totalDuration: recalcDuration(updatedSegs),
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  selectSegment: (segmentId: string | null): void => {
    set({ selectedSegmentId: segmentId });
  },

  duplicateSegment: (segmentId: string): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    const segIndex: number = current.segments.findIndex((s: Segment) => s.id === segmentId);
    if (segIndex === -1) return;

    get().pushUndo('复制片段');

    const original: Segment = current.segments[segIndex];
    const cloned: Segment = {
      ...original,
      id: generateId(),
      order: segIndex + 1,
      transitionIn: { ...original.transitionIn },
      transitionOut: { ...original.transitionOut },
      filters: original.filters.map((f: Filter) => ({ ...f })),
      textOverlay: original.textOverlay ? { ...original.textOverlay } : null,
    };

    const newSegs: Segment[] = [
      ...current.segments.slice(0, segIndex + 1),
      cloned,
      ...current.segments.slice(segIndex + 1).map((s: Segment) => ({ ...s, order: s.order + 1 })),
    ];

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: newSegs,
      totalDuration: recalcDuration(newSegs),
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true, selectedSegmentId: cloned.id });
  },

  // ─── Filter Actions ───────────────────────────────────

  addFilter: (segmentId: string, filter: Filter): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    get().pushUndo('添加滤镜');

    const updatedSegs: Segment[] = current.segments.map((s: Segment) => {
      if (s.id !== segmentId) return s;
      const existing: number = s.filters.findIndex((f: Filter) => f.type === filter.type);
      if (existing >= 0) {
        const newFilters: Filter[] = [...s.filters];
        newFilters[existing] = { ...filter };
        return { ...s, filters: newFilters };
      }
      return { ...s, filters: [...s.filters, { ...filter }] };
    });

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: updatedSegs,
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  removeFilter: (segmentId: string, filterType: FilterType): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    get().pushUndo('移除滤镜');

    const updatedSegs: Segment[] = current.segments.map((s: Segment) => {
      if (s.id !== segmentId) return s;
      return {
        ...s,
        filters: s.filters.filter((f: Filter) => f.type !== filterType),
      };
    });

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: updatedSegs,
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  updateFilter: (segmentId: string, filterType: FilterType, value: number): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    const updatedSegs: Segment[] = current.segments.map((s: Segment) => {
      if (s.id !== segmentId) return s;
      return {
        ...s,
        filters: s.filters.map((f: Filter) =>
          f.type === filterType ? { ...f, value } : f,
        ),
      };
    });

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: updatedSegs,
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  // ─── Text Overlay Actions ─────────────────────────────

  setTextOverlay: (segmentId: string, overlay: TextOverlay | null): void => {
    const state: TemplateState = get();
    const current: Template | null = state.currentTemplate();
    if (!current) return;

    get().pushUndo(overlay ? '设置文字叠加' : '移除文字叠加');

    const updatedSegs: Segment[] = current.segments.map((s: Segment) => {
      if (s.id !== segmentId) return s;
      return {
        ...s,
        textOverlay: overlay ? { ...overlay } : null,
      };
    });

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: updatedSegs,
    }));
    set({ templates: newTemplates, currentTemplateId: cid, isDirty: true });
  },

  // ─── Undo/Redo ────────────────────────────────────────

  pushUndo: (actionLabel: string): void => {
    const current: Template | null = get().currentTemplate();
    if (!current) return;

    set((state: TemplateState) => {
      const undoEntry: UndoEntry = {
        segments: current.segments.map((s: Segment) => ({ ...s, transitionIn: { ...s.transitionIn }, transitionOut: { ...s.transitionOut }, filters: s.filters.map((f: Filter) => ({ ...f })), textOverlay: s.textOverlay ? { ...s.textOverlay } : null })),
        actionLabel,
      };

      const newUndo: UndoEntry[] = [...state.undoStack, undoEntry];
      if (newUndo.length > state.maxUndoDepth) {
        newUndo.shift();
      }

      return { undoStack: newUndo, redoStack: [] };
    });
  },

  undo: (): void => {
    const state: TemplateState = get();
    if (state.undoStack.length === 0) return;

    const current: Template | null = state.currentTemplate();
    if (!current) return;

    const undoEntry: UndoEntry = state.undoStack[state.undoStack.length - 1];
    const newUndo: UndoEntry[] = state.undoStack.slice(0, -1);

    // Current state becomes redo entry
    const redoEntry: UndoEntry = {
      segments: current.segments.map((s: Segment) => ({ ...s, transitionIn: { ...s.transitionIn }, transitionOut: { ...s.transitionOut }, filters: s.filters.map((f: Filter) => ({ ...f })), textOverlay: s.textOverlay ? { ...s.textOverlay } : null })),
      actionLabel: state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1].actionLabel : '',
    };

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: undoEntry.segments.map((s: Segment, i: number) => ({ ...s, order: i })),
      totalDuration: recalcDuration(undoEntry.segments),
      updatedAt: new Date().toISOString(),
    }));

    set({
      templates: newTemplates,
      currentTemplateId: cid,
      undoStack: newUndo,
      redoStack: [...state.redoStack, redoEntry],
      isDirty: true,
    });
  },

  redo: (): void => {
    const state: TemplateState = get();
    if (state.redoStack.length === 0) return;

    const current: Template | null = state.currentTemplate();
    if (!current) return;

    const redoEntry: UndoEntry = state.redoStack[state.redoStack.length - 1];
    const newRedo: UndoEntry[] = state.redoStack.slice(0, -1);

    // Current state becomes undo entry
    const undoEntry: UndoEntry = {
      segments: current.segments.map((s: Segment) => ({ ...s, transitionIn: { ...s.transitionIn }, transitionOut: { ...s.transitionOut }, filters: s.filters.map((f: Filter) => ({ ...f })), textOverlay: s.textOverlay ? { ...s.textOverlay } : null })),
      actionLabel: redoEntry.actionLabel,
    };

    const { templates: newTemplates, currentTemplateId: cid } = mapCurrentTemplate(state, (t: Template) => ({
      ...t,
      segments: redoEntry.segments.map((s: Segment, i: number) => ({ ...s, order: i })),
      totalDuration: recalcDuration(redoEntry.segments),
      updatedAt: new Date().toISOString(),
    }));

    set({
      templates: newTemplates,
      currentTemplateId: cid,
      undoStack: [...state.undoStack, undoEntry],
      redoStack: newRedo,
      isDirty: true,
    });
  },

  // ─── Market ───────────────────────────────────────────

  setMarketOpen: (open: boolean): void => {
    set({ isMarketOpen: open });
  },

  useTemplate: (template: Template): void => {
    const now: string = new Date().toISOString();
    const copy: Template = {
      ...template,
      id: generateId(),
      name: `${template.name} (副本)`,
      isBuiltin: false,
      createdAt: now,
      updatedAt: now,
      segments: cloneSegments(template.segments),
    };
    copy.totalDuration = recalcDuration(copy.segments);

    set({
      templates: [...get().templates, copy],
      currentTemplateId: copy.id,
      selectedSegmentId: null,
      isDirty: true,
      isEditing: true,
      isMarketOpen: false,
      undoStack: [],
      redoStack: [],
    });
  },

  setEditing: (editing: boolean): void => {
    set({ isEditing: editing });
  },

  // ─── Derived ──────────────────────────────────────────

  currentTemplate: (): Template | null => {
    const state: TemplateState = get();
    if (!state.currentTemplateId) return null;
    return state.templates.find((t: Template) => t.id === state.currentTemplateId) || null;
  },

  totalDuration: (): number => {
    const current: Template | null = get().currentTemplate();
    if (!current) return 0;
    return current.totalDuration;
  },

  segmentCount: (): number => {
    const current: Template | null = get().currentTemplate();
    if (!current) return 0;
    return current.segments.length;
  },

  canUndo: (): boolean => {
    return get().undoStack.length > 0;
  },

  canRedo: (): boolean => {
    return get().redoStack.length > 0;
  },

  getSegmentById: (segmentId: string): Segment | undefined => {
    const current: Template | null = get().currentTemplate();
    if (!current) return undefined;
    return current.segments.find((s: Segment) => s.id === segmentId);
  },
}));

export default useTemplateStore;
