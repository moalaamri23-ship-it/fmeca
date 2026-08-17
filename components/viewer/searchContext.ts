import { createContext, useContext, useMemo } from 'react';
import type { SmartHit } from '../../services/SmartSearchService';

/** Where the phrases the canvases highlight came from. */
export type SearchMode = 'exact' | 'smart';

export interface SmartSearchState {
    status: 'idle' | 'running' | 'done' | 'error';
    /** The intent the results belong to — what the reader typed when it ran. */
    intent: string;
    hits: SmartHit[];
    error: string | null;
    /** The one result being read, or null while every result is highlighted. */
    focused: string | null;
}

/** Find-in-document state, shared by the modal header and the canvases. */
export interface SearchApi {
    open: boolean;
    /** What the field shows — updates on every keystroke. */
    input: string;
    /** What the canvases search for in exact mode — the debounced input. */
    query: string;
    /**
     * Every phrase the canvases highlight: the typed query in exact mode, the
     * model's verified quotes in smart mode.
     */
    terms: string[];
    mode: SearchMode;
    smart: SmartSearchState;
    /** False when there is no document text or no way to reach a model. */
    smartAvailable: boolean;
    /** Why smart search is unavailable, for the button's tooltip. */
    smartHint: string;
    count: number;
    /** Index of the match the viewer is resting on, 0-based. */
    active: number;
    /** Bumped on every open request, so an already-open field takes focus again. */
    focusTick: number;
    openSearch: () => void;
    closeSearch: () => void;
    setInput: (value: string) => void;
    next: () => void;
    prev: () => void;
    /** Canvas-side: report how many matches the current terms have. */
    report: (count: number) => void;
    /** Run smart search for what is currently in the field. */
    runSmart: () => void;
    /** Highlight one result on its own, or pass null to show them all again. */
    focusSmartHit: (id: string | null) => void;
    /** Drop the smart results and go back to plain find-in-document. */
    clearSmart: () => void;
}

export const SearchContext = createContext<SearchApi | null>(null);

const INERT: Pick<SearchApi, 'terms' | 'active' | 'report'> = {
    terms: [],
    active: 0,
    report: () => {},
};

/** Header-side hook — throws outside the provider, where the bar cannot exist. */
export function useDocumentSearch(): SearchApi {
    const api = useContext(SearchContext);
    if (!api) throw new Error('useDocumentSearch must be used inside DocumentSearchProvider');
    return api;
}

/** True while smart search owns the viewer's side panel. */
export function useSmartPanelActive(): boolean {
    return useDocumentSearch().smart.status !== 'idle';
}

/**
 * Canvas-side hook: the phrases to look for, the match to rest on, and the
 * reporter for how many were found. Canvases also render outside the provider,
 * so this degrades to "no search" instead of throwing.
 */
export function useSearchTarget(): Pick<SearchApi, 'terms' | 'active' | 'report'> {
    const api = useContext(SearchContext);
    // Memoized: the canvases key expensive re-scans off this object's fields, so
    // handing them a fresh one on every render would re-search the document.
    return useMemo(
        () => (api ? { terms: api.terms, active: api.active, report: api.report } : INERT),
        [api]
    );
}
