import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import {
    SharePointFiles, SpFile, SpListing, SpLocation, SpSite, describeSpError, joinSpPath,
    rootFor, spBaseName, toSpFolderName,
} from '../services/SharePointFiles';

/**
 * Browse the SharePoint sites the OXY Connection Flow allows: pick a folder, or
 * pick files in one. Works inside Teams' iframe (no popup, no local folder access):
 * every call goes through the flow.
 *
 * Listings take 3-20 s, so the client caches them and the panel says what it is
 * waiting for instead of looking frozen.
 */

export type SharePointPickerProps = {
    isOpen: boolean;
    onClose: () => void;
    client: SharePointFiles | null;
    /** 'folder': choose a destination. 'files': choose files to fetch. */
    mode: 'folder' | 'files';
    title?: string;
    /** Where to open; falls back to the last place this viewer used, then the first root. */
    initial?: SpLocation | null;
    /** Offer "New folder" (default true). */
    allowNewFolder?: boolean;
    /** Files mode: allow several (default true). */
    multiple?: boolean;
    /** Text of the confirm button (default "Select this folder" / "Add files"). */
    confirmLabel?: string;
    onPickFolder?: (location: SpLocation & { name: string }) => void;
    onPickFiles?: (site: string, files: SpFile[]) => void;
};

const LAST_KEY = 'sp_picker_last_location';

function readLast(): SpLocation | null {
    try {
        const v = JSON.parse(localStorage.getItem(LAST_KEY) || 'null');
        return v && typeof v.site === 'string' && typeof v.path === 'string' ? v : null;
    } catch { return null; }
}

function writeLast(loc: SpLocation) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(loc)); } catch { /* storage blocked: not needed */ }
}

function formatSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const SharePointPicker: React.FC<SharePointPickerProps> = ({
    isOpen, onClose, client, mode, title, initial = null, allowNewFolder = true, multiple = true,
    confirmLabel, onPickFolder, onPickFiles,
}) => {
    const [sites, setSites] = useState<SpSite[] | null>(null);
    const [site, setSite] = useState<string>('');
    const [path, setPath] = useState<string>('');
    const [listing, setListing] = useState<SpListing | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>('');
    const [selected, setSelected] = useState<Record<string, SpFile>>({});
    const [newFolder, setNewFolder] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    // Ignore replies to listings the user has already navigated away from.
    const requestId = useRef(0);

    const siteInfo = useMemo(() => sites?.find(s => s.site.toLowerCase() === site.toLowerCase()), [sites, site]);
    const root = useMemo(() => rootFor(siteInfo, path), [siteInfo, path]);

    const open = useCallback(async (nextSite: string, nextPath: string, fresh = false) => {
        if (!client) return;
        const id = ++requestId.current;
        setSite(nextSite); setPath(nextPath); setError(''); setLoading(true); setNewFolder(null);
        try {
            const result = await client.list(nextSite, nextPath, { fresh });
            if (id !== requestId.current) return;
            setListing(result);
            writeLast({ site: nextSite, path: nextPath });
        } catch (e) {
            if (id !== requestId.current) return;
            setListing(null);
            setError(describeSpError(e));
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, [client]);

    // Load the allowed sites once per opening, then go to the starting folder.
    useEffect(() => {
        if (!isOpen || !client) return;
        let cancelled = false;
        setSelected({}); setError(''); setListing(null);
        (async () => {
            setLoading(true);
            try {
                const all = await client.sites();
                if (cancelled) return;
                setSites(all);
                const start = [initial, readLast()].find(l =>
                    l && rootFor(all.find(s => s.site.toLowerCase() === l.site.toLowerCase()), l.path));
                const first = all[0];
                if (start) await open(start.site, start.path);
                else if (first?.roots[0]) await open(first.site, first.roots[0].path);
                else { setLoading(false); setError('The OXY Connection Flow allows no SharePoint sites.'); }
            } catch (e) {
                if (!cancelled) { setLoading(false); setError(describeSpError(e)); }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, client]);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && newFolder === null) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen, onClose, newFolder]);

    if (!isOpen) return null;

    // Breadcrumb: the root by its title, then each folder below it.
    const crumbs: { label: string; path: string }[] = [];
    if (root) {
        crumbs.push({ label: root.title || spBaseName(root.path), path: root.path });
        const rest = path.slice(root.path.length).split('/').filter(Boolean);
        rest.forEach((seg, i) => crumbs.push({ label: seg, path: joinSpPath(root.path, ...rest.slice(0, i + 1)) }));
    }

    const rootOptions = (sites || []).flatMap(s => s.roots.map(r => ({ site: s.site, root: r, label: `${s.title} — ${r.title}` })));
    const currentRootValue = root ? `${site}|${root.path}` : '';

    const selectedFiles = Object.values(selected);
    const toggleFile = (f: SpFile) => {
        setSelected(prev => {
            if (prev[f.path]) { const { [f.path]: _, ...rest } = prev; return rest; }
            return multiple ? { ...prev, [f.path]: f } : { [f.path]: f };
        });
    };

    const createFolder = async () => {
        if (!client || newFolder === null) return;
        const name = toSpFolderName(newFolder);
        if (!newFolder.trim()) return;
        setCreating(true); setError('');
        try {
            const target = joinSpPath(path, name);
            await client.mkdir(site, target);
            setNewFolder(null);
            await open(site, path, true);
        } catch (e) {
            setError(describeSpError(e));
        } finally {
            setCreating(false);
        }
    };

    const confirm = () => {
        if (mode === 'folder') {
            if (!path || !site) return;
            onPickFolder?.({ site, path, name: spBaseName(path) });
        } else {
            if (!selectedFiles.length) return;
            onPickFiles?.(site, selectedFiles);
        }
    };

    const canConfirm = !loading && !creating && (mode === 'folder' ? !!listing : selectedFiles.length > 0);
    const label = confirmLabel || (mode === 'folder'
        ? 'Select this folder'
        : selectedFiles.length ? `Add ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}` : 'Add files');

    return (
        <div className="fixed inset-0 z-[9999] bg-black/40 grid place-items-center p-4" onMouseDown={onClose}>
            <div className="bg-white rounded-xl w-[92vw] max-w-2xl h-[80vh] max-h-[640px] flex flex-col border shadow-2xl overflow-hidden animate-enter"
                onMouseDown={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title || 'SharePoint'}>

                <header className="h-14 shrink-0 bg-slate-900 text-white px-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
                            <Icon name="folder" className="w-4 h-4 text-brand-500" />
                        </div>
                        <div className="min-w-0">
                            <div className="font-bold text-sm truncate">{title || (mode === 'folder' ? 'Choose a SharePoint folder' : 'Choose SharePoint files')}</div>
                            <div className="text-xs text-slate-400 truncate">{siteInfo?.title || 'SharePoint'}</div>
                        </div>
                    </div>
                    <button onClick={onClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-800 transition">
                        <Icon name="close" className="w-4 h-4" />
                    </button>
                </header>

                <div className="px-4 pt-3 pb-2 border-b bg-slate-50 space-y-2 shrink-0">
                    <div className="flex items-center gap-2">
                        <select
                            value={currentRootValue}
                            onChange={e => { const [s, ...p] = e.target.value.split('|'); if (s) open(s, p.join('|')); }}
                            disabled={!rootOptions.length}
                            className="flex-1 min-w-0 bg-white border border-slate-200 rounded p-2 text-sm outline-none focus:border-brand-500 shadow-sm"
                            aria-label="Site and library">
                            {!currentRootValue && <option value="">{sites ? 'Choose a library' : 'Loading sites…'}</option>}
                            {rootOptions.map(o => <option key={`${o.site}|${o.root.path}`} value={`${o.site}|${o.root.path}`}>{o.label}</option>)}
                        </select>
                        <button onClick={() => site && open(site, path, true)} disabled={!site || loading}
                            title="Reload this folder" aria-label="Reload this folder"
                            className="bg-white border text-slate-600 p-2 rounded hover:bg-slate-50 disabled:opacity-40">
                            <Icon name="rotate" className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                    <nav className="flex items-center flex-wrap gap-1 text-xs min-h-[20px]" aria-label="Folder path">
                        {crumbs.map((c, i) => (
                            <React.Fragment key={c.path}>
                                {i > 0 && <Icon name="chevronRight" className="w-3 h-3 text-slate-300" />}
                                {i === crumbs.length - 1
                                    ? <span className="font-bold text-slate-700 truncate max-w-[220px]">{c.label}</span>
                                    : <button onClick={() => open(site, c.path)} className="font-semibold text-brand-600 hover:underline truncate max-w-[160px]">{c.label}</button>}
                            </React.Fragment>
                        ))}
                    </nav>
                </div>

                {error && (
                    <div className="mx-4 mt-3 text-xs p-2 bg-yellow-50 text-yellow-800 rounded border border-yellow-200 flex items-center justify-between gap-2">
                        <span>{error}</span>
                        {site && path && <button onClick={() => open(site, path, true)} className="font-bold text-yellow-900 underline shrink-0">Retry</button>}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto scroll-thin px-2 py-2">
                    {loading ? (
                        <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-400 text-sm">
                            <Icon name="spinner" className="w-6 h-6 animate-spin text-brand-500" />
                            Loading from SharePoint…
                            <span className="text-xs">This can take up to 20 seconds.</span>
                        </div>
                    ) : listing ? (
                        <ul className="divide-y divide-slate-100">
                            {newFolder !== null && (
                                <li className="flex items-center gap-2 px-2 py-2">
                                    <Icon name="folder" className="w-5 h-5 text-amber-500 shrink-0" />
                                    <input autoFocus value={newFolder} onChange={e => setNewFolder(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') setNewFolder(null); }}
                                        placeholder="New folder name" disabled={creating}
                                        className="flex-1 bg-white border border-slate-200 rounded p-1.5 text-sm outline-none focus:border-brand-500" />
                                    <button onClick={createFolder} disabled={creating || !newFolder.trim()}
                                        className="bg-brand-600 text-white px-3 py-1.5 rounded text-xs font-bold disabled:opacity-40 inline-flex items-center gap-1">
                                        {creating && <Icon name="spinner" className="w-3 h-3 animate-spin" />}Create
                                    </button>
                                    <button onClick={() => setNewFolder(null)} disabled={creating} className="text-xs border px-2 py-1.5 rounded font-bold">Cancel</button>
                                </li>
                            )}
                            {listing.folders.map(f => (
                                <li key={f.path}>
                                    <button onClick={() => open(site, f.path)} className="w-full flex items-center gap-3 px-2 py-2 rounded hover:bg-slate-50 text-left group">
                                        <Icon name="folder" className="w-5 h-5 text-amber-500 shrink-0" />
                                        <span className="flex-1 text-sm font-medium text-slate-700 truncate">{f.name}</span>
                                        <span className="text-xs text-slate-400 shrink-0">{f.itemCount} item{f.itemCount === 1 ? '' : 's'}</span>
                                        <Icon name="chevronRight" className="w-4 h-4 text-slate-300 group-hover:text-brand-500 shrink-0" />
                                    </button>
                                </li>
                            ))}
                            {listing.files.map(f => {
                                const picked = !!selected[f.path];
                                const pickable = mode === 'files';
                                return (
                                    <li key={f.path}>
                                        <label className={`flex items-center gap-3 px-2 py-2 rounded ${pickable ? 'cursor-pointer hover:bg-slate-50' : 'opacity-50'} ${picked ? 'bg-brand-50' : ''}`}>
                                            {pickable
                                                ? <input type={multiple ? 'checkbox' : 'radio'} checked={picked} onChange={() => toggleFile(f)} className="accent-brand-600 shrink-0" />
                                                : <span className="w-[13px] shrink-0" />}
                                            <Icon name="clip" className="w-4 h-4 text-slate-400 shrink-0" />
                                            <span className="flex-1 text-sm text-slate-700 truncate">{f.name}</span>
                                            <span className="text-xs text-slate-400 shrink-0 hidden sm:inline">{formatDate(f.modified)}</span>
                                            <span className="text-xs text-slate-400 shrink-0 w-16 text-right">{formatSize(f.size)}</span>
                                        </label>
                                    </li>
                                );
                            })}
                            {!listing.folders.length && !listing.files.length && newFolder === null && (
                                <li className="px-2 py-6 text-center text-sm text-slate-400 italic">This folder is empty.</li>
                            )}
                        </ul>
                    ) : null}
                </div>

                <footer className="shrink-0 border-t px-4 py-3 flex items-center gap-2 bg-white">
                    {allowNewFolder && (
                        <button onClick={() => setNewFolder('')} disabled={!listing || loading || newFolder !== null} title="New folder" aria-label="New folder"
                            className="text-xs font-bold text-brand-600 inline-flex items-center gap-1 whitespace-nowrap shrink-0 disabled:opacity-40">
                            <Icon name="plus" className="w-4 h-4" /><span className="hidden sm:inline">New folder</span>
                        </button>
                    )}
                    <div className="flex-1 min-w-0 text-[10px] text-slate-400 font-mono truncate hidden sm:block" title={path}>{path}</div>
                    <div className="flex-1 sm:hidden" />
                    <button onClick={onClose} className="px-3 py-2 text-sm border rounded-lg font-bold text-slate-600 hover:bg-slate-50 whitespace-nowrap shrink-0">Cancel</button>
                    <button onClick={confirm} disabled={!canConfirm}
                        className="px-3 py-2 text-sm bg-brand-600 text-white rounded-lg font-bold whitespace-nowrap shrink-0 disabled:opacity-40">{label}</button>
                </footer>
            </div>
        </div>
    );
};
