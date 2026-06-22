/**
 * Zustand store for material management.
 *
 * Manages:
 * - Materials array with full CRUD operations
 * - Selection state with multi-select support
 * - Filtering by type and status
 * - Sorting by various criteria
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  AnyMaterial,
  MaterialType,
  MaterialStatus,
} from '@/renderer/types/material';

/** Sort criteria for the materials list */
export type SortByField = 'name' | 'date' | 'size' | 'type';

/** Sort direction */
export type SortDirection = 'asc' | 'desc';

/** Filter state for materials */
export interface MaterialsFilter {
  /** Filter by material type; undefined means all types */
  filterType: MaterialType | 'all';
  /** Filter by status; undefined means all statuses */
  filterStatus: MaterialStatus | 'all';
  /** Search query string (matches file name) */
  searchQuery: string;
}

/** Sort state */
export interface MaterialsSort {
  sortBy: SortByField;
  sortDirection: SortDirection;
}

/** Full materials store state + actions */
export interface MaterialsState {
  // ─── State ──────────────────────────────────────────────

  /** All materials in the current session */
  materials: AnyMaterial[];

  /** Set of selected material IDs */
  selectedIds: Set<string>;

  /** Current filter settings */
  filter: MaterialsFilter;

  /** Current sort settings */
  sort: MaterialsSort;

  /** Whether the import dialog is open */
  isImportDialogOpen: boolean;

  /** Current view mode */
  viewMode: 'grid' | 'list';

  // ─── CRUD Actions ───────────────────────────────────────

  /** Add one or more materials to the store */
  addMaterials: (materials: AnyMaterial[]) => void;

  /** Remove a single material by ID */
  removeMaterial: (id: string) => void;

  /** Remove multiple materials by IDs */
  removeMaterials: (ids: string[]) => void;

  /** Update a single material's fields */
  updateMaterial: (id: string, updates: Partial<AnyMaterial>) => void;

  /** Clear all materials */
  clearAll: () => void;

  // ─── Selection Actions ──────────────────────────────────

  /** Toggle selection for a single material */
  toggleSelect: (id: string) => void;

  /** Select a single material (deselect others unless Ctrl is held) */
  selectSingle: (id: string, additive?: boolean) => void;

  /** Select a range using Shift+Click */
  selectRange: (id: string, materialIds: string[]) => void;

  /** Select all currently visible/filtered materials */
  selectAll: (ids: string[]) => void;

  /** Deselect all materials */
  deselectAll: () => void;

  // ─── Filter & Sort Actions ──────────────────────────────

  /** Update the filter criteria */
  setFilter: (filter: Partial<MaterialsFilter>) => void;

  /** Update the sort criteria */
  setSort: (sort: Partial<MaterialsSort>) => void;

  /** Set view mode */
  setViewMode: (mode: 'grid' | 'list') => void;

  /** Toggle import dialog */
  setImportDialogOpen: (open: boolean) => void;

  // ─── Derived Helpers ────────────────────────────────────

  /** Get material by ID */
  getMaterialById: (id: string) => AnyMaterial | undefined;

  /** Get filtered and sorted materials */
  getFilteredMaterials: () => AnyMaterial[];
}

/**
 * Build a new UUID v4 identifier.
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c: string) => {
    const r: number = (Math.random() * 16) | 0;
    const v: number = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Materials Zustand store.
 *
 * Usage:
 *   const materials = useMaterialsStore(s => s.materials);
 *   const addMaterials = useMaterialsStore(s => s.addMaterials);
 *
 * @remarks The store uses a Set for selectedIds for O(1) lookup.
 * All exported actions are stable references (Zustand default).
 */
export const useMaterialsStore = create<MaterialsState>()(
  persist(
    (set, get) => ({
      // ─── Initial State ────────────────────────────────────
      materials: [],
      selectedIds: new Set<string>(),
      filter: {
        filterType: 'all',
        filterStatus: 'all',
        searchQuery: '',
      },
      sort: {
        sortBy: 'date',
        sortDirection: 'desc',
      },
      isImportDialogOpen: false,
      viewMode: 'grid',

  // ─── CRUD Actions ─────────────────────────────────────

  addMaterials: (newMaterials: AnyMaterial[]): void => {
    set((state: MaterialsState) => ({
      materials: [...state.materials, ...newMaterials],
    }));
  },

  removeMaterial: (id: string): void => {
    set((state: MaterialsState) => {
      const newSelected = new Set(state.selectedIds);
      newSelected.delete(id);
      return {
        materials: state.materials.filter((m: AnyMaterial) => m.id !== id),
        selectedIds: newSelected,
      };
    });
  },

  removeMaterials: (ids: string[]): void => {
    const idSet = new Set(ids);
    set((state: MaterialsState) => {
      const newSelected = new Set(state.selectedIds);
      ids.forEach((id: string) => newSelected.delete(id));
      return {
        materials: state.materials.filter((m: AnyMaterial) => !idSet.has(m.id)),
        selectedIds: newSelected,
      };
    });
  },

  updateMaterial: (id: string, updates: Partial<AnyMaterial>): void => {
    set((state: MaterialsState) => ({
      materials: state.materials.map((m: AnyMaterial) =>
        m.id === id ? { ...m, ...updates } as AnyMaterial : m
      ),
    }));
  },

  clearAll: (): void => {
    set({ materials: [], selectedIds: new Set<string>() });
  },

  // ─── Selection Actions ────────────────────────────────

  toggleSelect: (id: string): void => {
    set((state: MaterialsState) => {
      const newSelected = new Set(state.selectedIds);
      if (newSelected.has(id)) {
        newSelected.delete(id);
      } else {
        newSelected.add(id);
      }
      return { selectedIds: newSelected };
    });
  },

  selectSingle: (id: string, additive: boolean = false): void => {
    set((state: MaterialsState) => {
      if (additive) {
        const newSelected = new Set(state.selectedIds);
        if (newSelected.has(id)) {
          newSelected.delete(id);
        } else {
          newSelected.add(id);
        }
        return { selectedIds: newSelected };
      }
      return { selectedIds: new Set([id]) };
    });
  },

  selectRange: (id: string, materialIds: string[]): void => {
    set((state: MaterialsState) => {
      const currentSelection = Array.from(state.selectedIds);
      if (currentSelection.length === 0) {
        return { selectedIds: new Set([id]) };
      }
      // Find the range between last selected and the clicked item
      const lastSelectedId = currentSelection[currentSelection.length - 1];
      const lastIndex = materialIds.indexOf(lastSelectedId);
      const currentIndex = materialIds.indexOf(id);

      if (lastIndex === -1 || currentIndex === -1) {
        return { selectedIds: new Set([...currentSelection, id]) };
      }

      const start = Math.min(lastIndex, currentIndex);
      const end = Math.max(lastIndex, currentIndex);
      const rangeIds = materialIds.slice(start, end + 1);

      const newSelected = new Set(state.selectedIds);
      rangeIds.forEach((rangeId: string) => newSelected.add(rangeId));
      return { selectedIds: newSelected };
    });
  },

  selectAll: (ids: string[]): void => {
    set({ selectedIds: new Set(ids) });
  },

  deselectAll: (): void => {
    set({ selectedIds: new Set<string>() });
  },

  // ─── Filter & Sort Actions ────────────────────────────

  setFilter: (partial: Partial<MaterialsFilter>): void => {
    set((state: MaterialsState) => ({
      filter: { ...state.filter, ...partial },
    }));
  },

  setSort: (partial: Partial<MaterialsSort>): void => {
    set((state: MaterialsState) => ({
      sort: { ...state.sort, ...partial },
    }));
  },

  setViewMode: (mode: 'grid' | 'list'): void => {
    set({ viewMode: mode });
  },

  setImportDialogOpen: (open: boolean): void => {
    set({ isImportDialogOpen: open });
  },

  // ─── Derived Helpers ──────────────────────────────────

  getMaterialById: (id: string): AnyMaterial | undefined => {
    return get().materials.find((m: AnyMaterial) => m.id === id);
  },

  getFilteredMaterials: (): AnyMaterial[] => {
    const { materials, filter, sort } = get();
    const { filterType, filterStatus, searchQuery } = filter;

    // Apply filters
    let filtered: AnyMaterial[] = materials;

    if (filterType !== 'all') {
      filtered = filtered.filter((m: AnyMaterial) => m.type === filterType);
    }

    if (filterStatus !== 'all') {
      filtered = filtered.filter((m: AnyMaterial) => m.status === filterStatus);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      filtered = filtered.filter((m: AnyMaterial) =>
        m.fileName.toLowerCase().includes(query)
      );
    }

    // Apply sort
    const direction: number = sort.sortDirection === 'asc' ? 1 : -1;
    filtered = [...filtered].sort((a: AnyMaterial, b: AnyMaterial) => {
      switch (sort.sortBy) {
        case 'name':
          return direction * a.fileName.localeCompare(b.fileName);
        case 'date':
          return direction * (new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
        case 'size': {
          // size is a formatted string; for sorting fall back to raw comparison
          const aSize = parseInt(a.size.replace(/[^0-9.]/g, ''), 10) || 0;
          const bSize = parseInt(b.size.replace(/[^0-9.]/g, ''), 10) || 0;
          return direction * (aSize - bSize);
        }
        case 'type':
          return direction * a.type.localeCompare(b.type);
        default:
          return 0;
      }
    });

    return filtered;
  },
}),
{
  name: 'mashup-materials-store',
  partialize: (state) => {
    // Don't persist ephemeral UI state
    const { selectedIds, isImportDialogOpen, ...rest } = state;
    return rest;
  },
}
)
);

export default useMaterialsStore;
