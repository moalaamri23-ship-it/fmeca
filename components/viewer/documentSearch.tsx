import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../Icon';
import { cn } from './util';
import { smartSearchDocument } from '../../services/SmartSearchService';
import type { SmartSearchConfig } from '../../services/SmartSearchService';
import { SearchContext, useDocumentSearch } from './searchContext';
import type { SearchApi, SmartSearchState } from './searchContext';

/** Typing keeps the field responsive while the canvases catch up behind it. */
const DEBOUNCE_MS = 180;

const IDLE_SMART: SmartSearchState = {
    status: 'idle',
    intent: '',
    hits: [],
    error: null,
    focused: null,
};

const Spinner: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
    <Icon name="spinner" className={`${className} animate-spin`} />
);

/**
 * Owns the find-in-document state for one open document. Mount it with a `key`
 * of the document's identity so switching documents starts a fresh search.
 */
export const DocumentSearchProvider: React.FC<{
    /** Bind ⌘F / Ctrl+F to the find bar (only while the viewer is on screen). */
    hotkey?: boolean;
    /** The document's extracted text — what smart search reads. */
    documentText?: string;
    documentName?: string;
    /** Live AI settings, or null when the app has no key configured. */
    ai?: SmartSearchConfig | null;
    /**
     * Lets the surrounding modal see the bar's state — it has to swallow Escape
     * while the bar is open instead of closing the whole viewer.
     */
    onStateChange?: (state: { open: boolean; close: () => void }) => void;
    children: ReactNode;
}> = ({ hotkey = false, documentText = '', documentName = 'document', ai = null, onStateChange, children }) => {
    const [open, setOpen] = useState(false);
    const [input, setInputState] = useState('');
    const [query, setQuery] = useState('');
    const [count, setCount] = useState(0);
    const [active, setActive] = useState(0);
    const [focusTick, setFocusTick] = useState(0);
    const [smart, setSmart] = useState<SmartSearchState>(IDLE_SMART);

    // Only the newest smart run may write results: the reader can start another
    // one (or close the viewer) while a model call is still in flight.
    const runToken = useRef(0);
    useEffect(() => () => { runToken.current++; }, []);

    useEffect(() => {
        if (input === query) return;
        const timer = setTimeout(() => setQuery(input), DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [input, query]);

    const clearSmart = useCallback(() => {
        runToken.current++;
        setSmart(IDLE_SMART);
        setActive(0);
    }, []);

    const setInput = useCallback((value: string) => {
        setInputState(value);
        setActive(0);
        // Editing the query is a return to plain find — the results on screen
        // belong to the intent that was typed before.
        setSmart(current => (current.status === 'idle' ? current : IDLE_SMART));
        runToken.current++;
    }, []);

    const report = useCallback((next: number) => {
        setCount(next);
        setActive(current => (next === 0 ? 0 : Math.min(current, next - 1)));
    }, []);

    const next = useCallback(() => {
        setActive(current => (count === 0 ? 0 : (current + 1) % count));
    }, [count]);

    const prev = useCallback(() => {
        setActive(current => (count === 0 ? 0 : (current - 1 + count) % count));
    }, [count]);

    const openSearch = useCallback(() => {
        setOpen(true);
        setFocusTick(tick => tick + 1);
    }, []);

    const closeSearch = useCallback(() => {
        runToken.current++;
        setOpen(false);
        setInputState('');
        setQuery('');
        setCount(0);
        setActive(0);
        setSmart(IDLE_SMART);
    }, []);

    const hasText = documentText.trim().length > 0;
    const hasAi = !!ai && (!!ai.apiKey || ai.provider === 'copilot');
    const smartAvailable = hasText && hasAi;
    const smartHint = !hasText
        ? "Smart search needs this document's text"
        : !hasAi
          ? 'Smart search needs an AI provider — add an API key in Settings'
          : 'Smart search — find what you mean, not just these words (⌘↵)';

    const runSmart = useCallback(() => {
        const intent = input.trim();
        if (!intent || !smartAvailable || !ai) return;
        const token = ++runToken.current;
        setActive(0);
        setSmart({ status: 'running', intent, hits: [], error: null, focused: null });
        void smartSearchDocument(documentName, documentText, intent, ai).then(
            result => {
                if (runToken.current !== token) return;
                setSmart({ status: 'done', intent, hits: result.hits, error: null, focused: null });
            },
            (error: unknown) => {
                if (runToken.current !== token) return;
                setSmart({
                    status: 'error',
                    intent,
                    hits: [],
                    error: error instanceof Error ? error.message : String(error),
                    focused: null,
                });
            }
        );
    }, [input, smartAvailable, ai, documentName, documentText]);

    const focusSmartHit = useCallback((id: string | null) => {
        setActive(0);
        setSmart(current => (current.status === 'done' ? { ...current, focused: id } : current));
    }, []);

    // Smart results own the highlighting while they are on screen; the typed
    // query owns it the rest of the time.
    const smartTerms = useMemo(() => {
        if (smart.status !== 'done' || smart.hits.length === 0) return null;
        const focused = smart.focused ? smart.hits.find(hit => hit.id === smart.focused) : null;
        return focused ? [focused.quote] : smart.hits.map(hit => hit.quote);
    }, [smart]);

    const terms = useMemo(() => smartTerms ?? (query ? [query] : []), [smartTerms, query]);

    useEffect(() => {
        onStateChange?.({ open, close: closeSearch });
    }, [open, closeSearch, onStateChange]);

    useEffect(() => {
        if (!hotkey) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault();
                openSearch();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [hotkey, openSearch]);

    const value = useMemo<SearchApi>(
        () => ({
            open, input, query, terms,
            mode: smartTerms ? 'smart' : 'exact',
            smart, smartAvailable, smartHint, count, active, focusTick,
            openSearch, closeSearch, setInput, next, prev, report, runSmart, focusSmartHit, clearSmart,
        }),
        [
            open, input, query, terms, smartTerms, smart, smartAvailable, smartHint, count, active,
            focusTick, openSearch, closeSearch, setInput, next, prev, report, runSmart, focusSmartHit,
            clearSmart,
        ]
    );

    return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
};

const ARROW_CLASS =
    'rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-40';

/** The button that turns into a find bar, sitting in the modal header. */
export const DocumentSearchBar: React.FC = () => {
    const {
        open, input, count, active, focusTick, smart, smartAvailable, smartHint,
        openSearch, closeSearch, setInput, next, prev, runSmart,
    } = useDocumentSearch();
    const inputRef = useRef<HTMLInputElement | null>(null);
    const running = smart.status === 'running';

    // Re-opening an already-open bar (⌘F again) puts the cursor back in the
    // field with the previous query selected, like a browser's find.
    useEffect(() => {
        if (!open) return;
        inputRef.current?.focus();
        inputRef.current?.select();
    }, [open, focusTick]);

    if (!open) {
        return (
            <button
                onClick={openSearch}
                title="Search this document (⌘F)"
                aria-label="Search this document"
                className="rounded p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
                <Icon name="search" className="w-4 h-4" />
            </button>
        );
    }

    return (
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 shadow-sm">
            <Icon name="search" className="w-3.5 h-3.5 shrink-0 text-slate-400" />
            <input
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        // ⌘/Ctrl+Enter asks the model instead of stepping through matches.
                        if (e.metaKey || e.ctrlKey) runSmart();
                        else if (e.shiftKey) prev();
                        else next();
                    } else if (e.key === 'Escape') {
                        // Keep Escape from reaching the modal, which would close it.
                        e.preventDefault();
                        e.stopPropagation();
                        closeSearch();
                    }
                }}
                placeholder="Find in document"
                aria-label="Find in document"
                className="w-40 bg-transparent text-xs text-slate-700 outline-none placeholder:text-slate-400"
            />
            <span className={cn('w-12 shrink-0 text-center text-[10px] font-mono', input && count === 0 ? 'text-slate-300' : 'text-slate-400')}>
                {input ? `${count === 0 ? 0 : active + 1}/${count}` : ''}
            </span>
            <button
                onClick={runSmart}
                disabled={!input.trim() || !smartAvailable || running}
                title={smartHint}
                aria-label="Smart search"
                className={cn(
                    'flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-bold transition',
                    'text-brand-600 hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-40',
                    running && 'bg-brand-50'
                )}
            >
                {running ? <Spinner /> : <Icon name="sparkles" className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{running ? 'Thinking…' : 'Smart'}</span>
            </button>
            <button onClick={prev} disabled={count === 0} title="Previous match" className={ARROW_CLASS}>
                <Icon name="chevronUp" className="w-3.5 h-3.5" />
            </button>
            <button onClick={next} disabled={count === 0} title="Next match" className={ARROW_CLASS}>
                <Icon name="chevronDown" className="w-3.5 h-3.5" />
            </button>
            <button onClick={closeSearch} title="Close search" className={ARROW_CLASS}>
                <Icon name="close" className="w-3.5 h-3.5" />
            </button>
        </div>
    );
};

/**
 * The smart-search results, for the viewer's side panel. Each result is a
 * passage that really exists in the document — clicking one highlights just
 * that passage and scrolls the canvas to it.
 */
export const SmartSearchPanel: React.FC = () => {
    const { smart, focusSmartHit, clearSmart, count } = useDocumentSearch();
    if (smart.status === 'idle') return null;

    return (
        <aside className="flex w-80 shrink-0 flex-col border-l border-slate-200 bg-slate-50">
            <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
                <Icon name="sparkles" className="w-3.5 h-3.5 shrink-0 text-brand-600" />
                <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-bold uppercase text-slate-400">Smart results</p>
                    <p className="truncate text-[11px] text-slate-700" title={smart.intent}>{smart.intent}</p>
                </div>
                <button onClick={clearSmart} title="Close smart results"
                    className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700">
                    <Icon name="close" className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="flex-1 space-y-2 overflow-y-auto scroll-thin px-3 py-3">
                {smart.status === 'running' && (
                    <div className="flex items-center gap-2 px-1 py-4 text-[11px] text-slate-400">
                        <Spinner />
                        Reading the document for what you mean…
                    </div>
                )}

                {smart.status === 'error' && (
                    <p className="rounded border border-red-200 bg-red-50 p-2.5 text-[11px] text-red-700">{smart.error}</p>
                )}

                {smart.status === 'done' && smart.hits.length === 0 && (
                    <p className="px-1 py-4 text-[11px] text-slate-400 italic">
                        Nothing in this document matches that meaning.
                    </p>
                )}

                {smart.status === 'done' && smart.hits.length > 0 && (
                    <>
                        <button
                            onClick={() => focusSmartHit(null)}
                            className={cn(
                                'flex w-full items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[10px] font-mono transition',
                                smart.focused === null
                                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                                    : 'border-slate-200 bg-white text-slate-400 hover:bg-slate-50'
                            )}
                        >
                            All {smart.hits.length} result{smart.hits.length === 1 ? '' : 's'}
                            {smart.focused === null && count > 0 && <span className="ml-auto">{count} in view</span>}
                        </button>

                        {smart.hits.map((hit, index) => (
                            <button
                                key={hit.id}
                                onClick={() => focusSmartHit(hit.id)}
                                className={cn(
                                    'w-full rounded-lg border p-2.5 text-left transition',
                                    smart.focused === hit.id
                                        ? 'border-brand-500 bg-brand-50 shadow-sm'
                                        : 'border-slate-200 bg-white hover:bg-slate-50'
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <span className={cn(
                                        'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
                                        smart.focused === hit.id ? 'bg-brand-600 text-white' : 'bg-brand-50 text-brand-700'
                                    )}>
                                        {index + 1}
                                    </span>
                                    <span className="text-[10px] font-mono text-slate-400">
                                        {hit.count} match{hit.count === 1 ? '' : 'es'}
                                    </span>
                                    {hit.fromTerm && (
                                        <span className="rounded-full border border-slate-200 bg-slate-100 px-1.5 text-[10px] font-mono text-slate-400">
                                            term
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-700">“{hit.quote}”</p>
                                {hit.why && (
                                    <p className="mt-1 text-[10px] leading-relaxed text-slate-400">{hit.why}</p>
                                )}
                            </button>
                        ))}
                    </>
                )}
            </div>
        </aside>
    );
};
