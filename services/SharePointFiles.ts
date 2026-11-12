/**
 * SharePoint folders and files through the OXY Connection Flow (router task `sp_files`).
 *
 * Replaces the local-folder features that need a top-level helper window: Teams shows
 * the apps inside an iframe, where popups and the folder picker are blocked. The flow
 * runs as whoever imported the router, so SharePoint applies that user's own rights;
 * its allowlist caps which sites and folders the apps can reach.
 *
 * Contract: ai-router/docs/sp_files.md. Paths are server-relative
 * ("/sites/<Site>/Shared Documents/..."), exactly as `list` returns them.
 *
 * Calls take 3-20 s, so the client avoids them where the answer is already known:
 * listings are cached for a minute and stored for the next page load (`cachedList`),
 * a write or delete patches the cached listing instead of listing again, a folder
 * seen to exist skips its mkdir, and opened or uploaded files are kept by etag
 * (`readBlob`). `warm` lists a whole subtree in one call. The store is
 * SharePointCache.ts.
 *
 * Router v1.4 runs these ops inside the router (no child-flow hop). If that route
 * fails the client asks the child flow (`sp_files_child`), and stays on it for the
 * session. Against an older router everything here still works: no `tree`, no
 * `modified` on writes, and the plain retry.
 */
import { routeFlowCall, hasFlowRoute, MISSING_FLOW_URL, RouterTask } from './AIRouter';
import { SpPersistentCache, MemorySpCache, defaultSpCache } from './SharePointCache';

export interface SpRoot { path: string; title: string }
export interface SpSite { site: string; title: string; roots: SpRoot[] }
export interface SpFolder { name: string; path: string; itemCount: number }
export interface SpFile { name: string; path: string; size: number; modified: string; etag: string }
export interface SpListing { path: string; folders: SpFolder[]; files: SpFile[] }
export interface SpFetched { name: string; path: string; size: number; contentType: string; etag: string; contentBase64: string }
export interface SpFetchFailure { path: string; error: string }
/** `modified` is SharePoint's own time; a flow before router v1.4 does not return it. */
export interface SpWritten { path: string; size: number; etag: string; modified?: string }

/** A location the apps store: which site, and which folder in it. */
export interface SpLocation { site: string; path: string }

/** Matches the flow's caps (sp_files_flow.py). */
export const SP_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SP_MAX_BATCH_FILES = 50;

/** Error codes the flow returns, plus two the client adds. */
export type SpErrorCode =
    | 'bad_request' | 'not_allowed' | 'not_found' | 'exists' | 'etag_mismatch' | 'too_large'
    | 'sharepoint_error' | 'flow_failed' | 'network';

export class SpError extends Error {
    constructor(public status: number, public code: SpErrorCode, message: string) {
        super(message);
        this.name = 'SpError';
    }
}

/**
 * One HTTP round trip to the router: the request body in, status and reply text out.
 * `task` names another router task for the same ops (the child-flow fallback).
 */
export type SpTransport = (body: Record<string, unknown>, task?: string) => Promise<{ status: number; text: string }>;

/** The real transport: POST to the OXY Connection Flow URL as text/plain (no CORS preflight). */
export function flowTransport(flowUrl: string): SpTransport {
    return async (body, task) => {
        if (!hasFlowRoute(flowUrl)) throw new SpError(0, 'bad_request', MISSING_FLOW_URL);
        const route = routeFlowCall(flowUrl, (task as RouterTask) || 'sp_files', body);
        let res: Response;
        try {
            res = await fetch(route.url, {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body: JSON.stringify(route.body),
            });
        } catch (e: any) {
            throw new SpError(0, 'network', 'Could not reach the OXY Connection Flow: ' + (e?.message || e));
        }
        return { status: res.status, text: await res.text() };
    };
}

// ------------------------------------------------------------------ paths ---

/** Join a folder path and one or more names with single slashes. */
export function joinSpPath(folder: string, ...names: string[]): string {
    return [folder.replace(/\/+$/, ''), ...names.map(n => n.replace(/^\/+|\/+$/g, ''))].filter(Boolean).join('/');
}

export function spParent(path: string): string {
    const i = path.replace(/\/+$/, '').lastIndexOf('/');
    return i > 0 ? path.slice(0, i) : path;
}

export function spBaseName(path: string): string {
    const p = path.replace(/\/+$/, '');
    return p.slice(p.lastIndexOf('/') + 1);
}

/** The root of `site` that holds `path`, if any. */
export function rootFor(site: SpSite | undefined, path: string): SpRoot | undefined {
    const p = path.toLowerCase();
    return site?.roots.find(r => {
        const root = r.path.toLowerCase();
        return p === root || p.startsWith(root + '/');
    });
}

/**
 * A name SharePoint will store as given. The flow refuses % in file names (its
 * "Create file" action double-encodes it), and / \ would make a path; the rest
 * SharePoint accepts. Folder names keep %.
 */
export function toSpFileName(name: string): string {
    const cleaned = name.replace(/%/g, 'pct').replace(/[\\/]/g, '-').replace(/[\u0000-\u001f]/g, '').trim();
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'file';
}

export function toSpFolderName(name: string): string {
    const cleaned = name.replace(/[\\/]/g, '-').replace(/[\u0000-\u001f]/g, '').trim();
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'Folder';
}

// ----------------------------------------------------------------- base64 ---

export async function blobToBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    return btoa(binary);
}

export function base64ToBlob(base64: string, contentType = 'application/octet-stream'): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: contentType });
}

/** Content type from the file name: SharePoint returns application/octet-stream for everything. */
export function guessContentType(name: string): string {
    const ext = name.toLowerCase().split('.').pop() || '';
    const types: Record<string, string> = {
        pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown',
        html: 'text/html', htm: 'text/html', xml: 'application/xml',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        doc: 'application/msword', xls: 'application/vnd.ms-excel',
    };
    return types[ext] || 'application/octet-stream';
}

/** One line for the user, from any error a call threw. */
export function describeSpError(err: unknown): string {
    if (err instanceof SpError) {
        switch (err.code) {
            case 'not_allowed': return 'You do not have access to this SharePoint location.';
            case 'not_found': return 'That file or folder no longer exists in SharePoint.';
            case 'exists': return 'A file with that name already exists.';
            case 'etag_mismatch': return 'Someone changed this file since it was opened. Reload and try again.';
            case 'too_large': return `File is over ${SP_MAX_FILE_BYTES / 1024 / 1024} MB.`;
            case 'network': return err.message;
            case 'flow_failed': return 'SharePoint took too long to answer. Try again.';
            default: return err.message || 'SharePoint request failed.';
        }
    }
    return (err as any)?.message || String(err);
}

// ----------------------------------------------------------------- client ---

const LIST_TTL_MS = 60_000;
/** The allowlist changes with a re-import, not from day to day. */
const SITES_TTL_MS = 24 * 60 * 60 * 1000;
const SITES_KEY = 'sites';

/** Ops that change nothing, so one retry after a timeout is safe. */
const RETRYABLE = new Set(['sites', 'list', 'tree', 'fetch', 'fetch_many', 'mkdir']);
/** Small reads worth asking twice when the first answer is slow (see `hedgeMs`). */
const HEDGED = new Set(['sites', 'list', 'tree']);
/** A flow failure this soon is the flow breaking, not its 120 s limit: a write did not happen. */
const QUICK_FAILURE_MS = 60_000;
/** The router task that runs the same ops in the child flow (router v1.4 and later). */
export const SP_CHILD_TASK = 'sp_files_child';

/** Uploads in flight at once. The flow runs each call as its own run. */
export const SP_UPLOAD_CONCURRENCY = 3;
/** Levels the flow's `tree` op goes below a folder. */
export const SP_TREE_MAX_DEPTH = 4;

export interface SpClientOptions {
    /**
     * Send a slow small read (sites, list, tree) a second time after this long and
     * take whichever answers first. Flow calls now and then take 12-24 s for no
     * reason of their own; a second run usually does not. 0 turns it off.
     */
    hedgeMs?: number;
}

/** Run `work` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await work(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
    return out;
}

/** SharePoint's own shape for a folder in a `tree` reply. */
interface SpTreeNode {
    Name?: string;
    ServerRelativeUrl?: string;
    ItemCount?: number;
    Folders?: SpTreeNode[];
    Files?: Array<{ Name: string; ServerRelativeUrl: string; Length?: string | number; TimeLastModified?: string; ETag?: string }>;
}

class UnknownTaskError extends SpError {}

export class SharePointFiles {
    private listings = new Map<string, { at: number; value: Promise<SpListing> }>();
    private sitesCache: Promise<SpSite[]> | null = null;
    /** Folders seen to exist this session, so an upload skips its mkdir call. */
    private knownFolders = new Set<string>();
    /** Reads of one file in flight, so two askers share one call. */
    private reading = new Map<string, Promise<Blob>>();
    private warming = new Map<string, { at: number; value: Promise<boolean> }>();
    /** The flow has no `tree` op (router before v1.4), or SharePoint refused its query. */
    private treeUnsupported = false;
    /** The router's inline route failed and its child route answered: stay on the child. */
    private preferChild = false;

    private transport: SpTransport;
    private store: SpPersistentCache;
    private hedgeMs: number;

    constructor(transport: SpTransport, store: SpPersistentCache = new MemorySpCache(), options: SpClientOptions = {}) {
        this.transport = transport;
        this.store = store;
        this.hedgeMs = options.hedgeMs ?? 0;
    }

    static forFlow(flowUrl: string): SharePointFiles {
        return new SharePointFiles(flowTransport(flowUrl), defaultSpCache(), { hedgeMs: 8000 });
    }

    /** One round trip, with the reply turned into the result or an SpError. */
    private async attempt<T>(body: Record<string, unknown>, task?: string): Promise<T> {
        const { status, text } = await this.transport(body, task);
        let parsed: { error?: unknown; message?: string; runId?: string; tasks?: unknown } | null = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* router or gateway text */ }
        if (status >= 200 && status < 300 && parsed) return parsed as unknown as T;
        if (status === 400 && parsed && Array.isArray(parsed.tasks)) {
            throw new UnknownTaskError(400, 'bad_request', String(parsed.error || 'Unknown task'));
        }
        // The flow's own errors are {error: <code>, message}. Anything else from 5xx is
        // the flow itself failing or timing out: the router's {error, runId} for a child,
        // or the platform's reply when a run ends without answering.
        const ours = !!parsed && typeof parsed.error === 'string' && !!parsed.message;
        if (status >= 500 && !ours) {
            const said = parsed && typeof parsed.error === 'string' ? parsed.error : '';
            throw new SpError(status, 'flow_failed', said || 'The flow failed or timed out.');
        }
        // The platform's own refusals carry {error: {code, message}}: the flow is turned
        // off, or its trigger refused the body. Say what it said, not "[object Object]".
        const platform = parsed && typeof parsed.error === 'object' && parsed.error
            ? parsed.error as { code?: string; message?: string } : null;
        if (platform) {
            const off = platform.code === 'WorkflowTriggerIsNotEnabled';
            throw new SpError(status, 'sharepoint_error', off
                ? 'The OXY Connection Flow is turned off. Turn the AI Router flow on in Power Automate.'
                : String(platform.message || platform.code || `HTTP ${status}`).slice(0, 500));
        }
        const code = (typeof parsed?.error === 'string' && parsed.error as SpErrorCode) || (status === 404 ? 'not_found' : 'sharepoint_error');
        throw new SpError(status, code, String(parsed?.message || parsed?.error || text || `HTTP ${status}`).slice(0, 500));
    }

    /** `run`, and a second `run` if the first has not answered after `hedgeMs`; the first answer wins. */
    private hedged<T>(run: () => Promise<T>): Promise<T> {
        if (!this.hedgeMs) return run();
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let open = 1;
            const watch = (p: Promise<T>): Promise<void> => p.then(
                v => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
                e => {
                    open--;
                    // The second try, if there is one, may still answer.
                    if (!settled && open === 0) { settled = true; clearTimeout(timer); reject(e); }
                },
            );
            const timer = setTimeout(() => { if (!settled) { open++; void watch(run()); } }, this.hedgeMs);
            void watch(run());
        });
    }

    private async call<T>(body: Record<string, unknown>): Promise<T> {
        const op = String(body.op);
        const once = (task?: string) => HEDGED.has(op) ? this.hedged(() => this.attempt<T>(body, task)) : this.attempt<T>(body, task);
        const started = Date.now();
        try {
            return await once(this.preferChild ? SP_CHILD_TASK : undefined);
        } catch (e) {
            if (!(e instanceof SpError) || (e.code !== 'flow_failed' && e.code !== 'network')) throw e;
            // An overwrite can be sent again; so can anything that changes nothing.
            const again = RETRYABLE.has(op)
                || (op === 'write' && body.overwrite === true && !body.ifMatch && Date.now() - started < QUICK_FAILURE_MS);
            if (!again) throw e;
            if (e.code === 'network' || this.preferChild) return once(this.preferChild ? SP_CHILD_TASK : undefined);
            // The flow failed: ask the child flow, which runs the same ops (router v1.4).
            // An older router does not know that task; it gets the plain retry it always had.
            try {
                const r = await once(SP_CHILD_TASK);
                this.preferChild = true;
                return r;
            } catch (viaChild) {
                if (viaChild instanceof UnknownTaskError) return once();
                throw viaChild;
            }
        }
    }

    /**
     * Sites and roots the flow allows (its allowlist). Kept for a day: answered from
     * the store at once, and asked again behind it when the stored copy is older than
     * the session.
     */
    sites(): Promise<SpSite[]> {
        if (!this.sitesCache) {
            const live = () => this.call<{ sites: SpSite[] }>({ op: 'sites' }).then(r => {
                const sites = r.sites || [];
                void this.store.putJson(SITES_KEY, { at: Date.now(), sites });
                return sites;
            });
            this.sitesCache = this.store.getJson<{ at: number; sites: SpSite[] }>(SITES_KEY).then(kept => {
                if (kept && Array.isArray(kept.sites) && Date.now() - kept.at < SITES_TTL_MS) {
                    // Refresh behind: the next session, or the next call after it lands, sees it.
                    live().then(sites => { this.sitesCache = Promise.resolve(sites); }, () => {});
                    return kept.sites;
                }
                return live();
            });
            this.sitesCache.catch(() => { this.sitesCache = null; });
        }
        return this.sitesCache;
    }

    private key(site: string, path: string) {
        return site.replace(/\/+$/, '').toLowerCase() + '|' + path.replace(/\/+$/, '').toLowerCase();
    }

    /** Put a listing this client just learned into the session cache and the store. */
    private seed(site: string, listing: SpListing) {
        const key = this.key(site, listing.path);
        this.listings.set(key, { at: Date.now(), value: Promise.resolve(listing) });
        this.knownFolders.add(key);
        for (const f of listing.folders) this.knownFolders.add(this.key(site, f.path));
        void this.store.putListing(key, listing);
    }

    /** Folders and files directly in `path`. Cached for a minute unless `fresh`. */
    list(site: string, path: string, opts: { fresh?: boolean } = {}): Promise<SpListing> {
        const key = this.key(site, path);
        const hit = this.listings.get(key);
        if (hit && !opts.fresh && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
        const value = this.call<SpListing>({ op: 'list', site, path }).then(r => ({
            path: r.path,
            folders: r.folders || [],
            files: r.files || [],
        }));
        const entry = { at: Date.now(), value };
        this.listings.set(key, entry);
        value.then(l => {
            this.knownFolders.add(key);
            for (const f of l.folders) this.knownFolders.add(this.key(site, f.path));
            // A later patch replaced this entry: the patched value is the one to keep.
            if (this.listings.get(key) === entry) void this.store.putListing(key, l);
        }, e => {
            if (this.listings.get(key) === entry) this.listings.delete(key);
            if (e instanceof SpError && e.code === 'not_found') {
                this.knownFolders.delete(key);
                void this.store.deleteListing(key);
            }
        });
        return value;
    }

    /**
     * List `path` and `depth` levels of folders below it in ONE call (the flow's
     * `tree` op), and cache every folder's listing as if each had been listed. A
     * caller warms a subtree, then lists and reads as usual and finds the answers
     * cached.
     *
     * False when nothing was cached: an older flow without `tree`, a folder that is
     * not there, or a failed call. The caller's own `list` calls then go out as before.
     */
    warm(site: string, path: string, depth = 2): Promise<boolean> {
        if (this.treeUnsupported) return Promise.resolve(false);
        const levels = Math.max(1, Math.min(SP_TREE_MAX_DEPTH, Math.floor(depth)));
        const key = this.key(site, path) + '|' + levels;
        const hit = this.warming.get(key);
        if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value;
        const value = this.call<{ path: string; tree: SpTreeNode }>({ op: 'tree', site, path, depth: levels }).then(r => {
            if (!r.tree || !Array.isArray(r.tree.Folders) || !Array.isArray(r.tree.Files)) return false;
            // A library root holds the hidden "Forms" folder; /sites/X/Lib splits into 4 parts.
            const atLibraryRoot = path.replace(/\/+$/, '').split('/').length === 4;
            const walk = (node: SpTreeNode, at: string, top: boolean) => {
                // A folder at the last level comes without its children: not a listing.
                if (!Array.isArray(node.Folders) || !Array.isArray(node.Files)) return;
                const folders = node.Folders.filter(f => !(top && atLibraryRoot && f.Name === 'Forms'));
                this.seed(site, {
                    path: at,
                    folders: folders.map(f => ({ name: f.Name || '', path: f.ServerRelativeUrl || '', itemCount: f.ItemCount ?? 0 })),
                    files: node.Files.map(f => ({
                        name: f.Name, path: f.ServerRelativeUrl, size: Number(f.Length ?? 0) || 0,
                        modified: f.TimeLastModified || '', etag: f.ETag || '',
                    })),
                });
                for (const f of folders) if (f.ServerRelativeUrl) walk(f, f.ServerRelativeUrl, false);
            };
            walk(r.tree, r.path || path.replace(/\/+$/, ''), true);
            return true;
        }, e => {
            // "Unknown op" from an older flow, or SharePoint refusing the nested query:
            // either way asking again will not help.
            if (e instanceof SpError && (e.code === 'bad_request' || e.code === 'sharepoint_error')) this.treeUnsupported = true;
            return false;
        });
        this.warming.set(key, { at: Date.now(), value });
        void value.then(ok => { if (!ok) this.warming.delete(key); });
        return value;
    }

    /**
     * The last listing of `path` this browser saw, at any age, without a call: the
     * session's if there is one, else the stored one. For showing at once while
     * `list` refreshes it.
     */
    async cachedList(site: string, path: string): Promise<SpListing | null> {
        const key = this.key(site, path);
        const hit = this.listings.get(key);
        if (hit) {
            try { return await hit.value; } catch { /* fall through to the store */ }
        }
        return this.store.getListing(key);
    }

    /** Drop cached listings of `path` (and, for a removed folder, everything under it). */
    invalidate(site: string, path: string, withChildren = false) {
        const key = this.key(site, path);
        for (const k of [...this.listings.keys()]) {
            if (k === key || (withChildren && k.startsWith(key + '/'))) this.listings.delete(k);
        }
        for (const k of [...this.warming.keys()]) {
            const folder = k.slice(0, k.lastIndexOf('|'));
            if (key === folder || key.startsWith(folder + '/') || (withChildren && folder.startsWith(key + '/'))) this.warming.delete(k);
        }
        void this.store.deleteListing(key);
        if (withChildren) {
            for (const k of [...this.knownFolders]) if (k === key || k.startsWith(key + '/')) this.knownFolders.delete(k);
        }
    }

    /**
     * Change the session's listing of `folder` in place, when there is one, instead
     * of listing it again: the change came from this client, so its result is known.
     */
    private patch(site: string, folder: string, change: (l: SpListing) => SpListing) {
        const key = this.key(site, folder);
        const hit = this.listings.get(key);
        if (!hit) { void this.store.deleteListing(key); return; }
        const value = hit.value.then(change);
        this.listings.set(key, { at: hit.at, value });
        value.then(l => this.store.putListing(key, l), () => this.listings.delete(key));
    }

    /** Create `path` and any missing parents. `created` is false when it already existed. */
    async mkdir(site: string, path: string): Promise<{ path: string; created: boolean }> {
        const key = this.key(site, path);
        if (this.knownFolders.has(key)) return { path, created: false };
        const r = await this.call<{ path: string; created: boolean }>({ op: 'mkdir', site, path });
        this.knownFolders.add(key);
        if (r.created) {
            // Every new level shows up in its parent's listing.
            let p = path;
            while (p.includes('/') && p !== spParent(p)) { this.invalidate(site, spParent(p)); p = spParent(p); }
        }
        return r;
    }

    /**
     * Upload into `folder`. Refuses to replace an existing file unless `overwrite`;
     * with `ifMatch` (an etag from list/fetch) it also refuses if the file changed since.
     */
    async write(site: string, folder: string, name: string, data: Blob | string,
                opts: { overwrite?: boolean; ifMatch?: string } = {}): Promise<SpWritten> {
        const fileName = toSpFileName(name);
        const contentBase64 = typeof data === 'string' ? data : await blobToBase64(data);
        const bytes = typeof data === 'string' ? Math.floor(data.length * 3 / 4) : data.size;
        if (bytes > SP_MAX_FILE_BYTES) {
            throw new SpError(413, 'too_large', `${name} is over ${SP_MAX_FILE_BYTES / 1024 / 1024} MB.`);
        }
        const body = {
            op: 'write', site, path: folder, name: fileName, contentBase64,
            overwrite: !!opts.overwrite, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
        };
        const folderKey = this.key(site, folder);
        let r: SpWritten;
        try {
            r = await this.call<SpWritten>(body);
        } catch (e) {
            // The folder was only believed to exist (seen earlier, removed since): make it, once.
            if (!(e instanceof SpError && e.code === 'not_found' && this.knownFolders.has(folderKey))) throw e;
            this.knownFolders.delete(folderKey);
            await this.mkdir(site, folder);
            r = await this.call<SpWritten>(body);
        }
        this.knownFolders.add(folderKey);
        // SharePoint's own modified time when the flow returns it (router v1.4). An older
        // flow does not, and this clock is not SharePoint's: left empty then, so anything
        // that compares times asks for the real one.
        const written: SpFile = { name: fileName, path: r.path, size: r.size, modified: r.modified || '', etag: r.etag };
        this.patch(site, folder, l => ({
            ...l,
            files: [...l.files.filter(f => f.name.toLowerCase() !== fileName.toLowerCase()), written],
        }));
        // The bytes just sent are the file's bytes: opening it next needs no call.
        if (typeof data !== 'string') {
            void this.store.putBlob(this.key(site, r.path), { etag: r.etag, contentType: guessContentType(fileName), blob: data });
        }
        return r;
    }

    async fetch(site: string, path: string): Promise<SpFetched> {
        return this.call<SpFetched>({ op: 'fetch', site, path });
    }

    /** The file as a Blob, typed from its name. */
    async fetchBlob(site: string, path: string): Promise<{ file: SpFetched; blob: Blob }> {
        const file = await this.fetch(site, path);
        const blob = base64ToBlob(file.contentBase64, guessContentType(file.name));
        void this.store.putBlob(this.key(site, path), { etag: file.etag, contentType: blob.type, blob });
        return { file, blob };
    }

    /**
     * The file's bytes, from this browser's store when `etag` (from a listing)
     * says they have not changed since, else through the flow. Two readers of one
     * file share one call.
     */
    readBlob(site: string, path: string, etag?: string): Promise<Blob> {
        const key = this.key(site, path) + '|' + (etag || '');
        const flying = this.reading.get(key);
        if (flying) return flying;
        const read = (async () => {
            if (etag) {
                const stored = await this.store.getBlob(this.key(site, path));
                if (stored && stored.etag === etag) return stored.blob;
            }
            return (await this.fetchBlob(site, path)).blob;
        })();
        this.reading.set(key, read);
        const clear = () => { if (this.reading.get(key) === read) this.reading.delete(key); };
        read.then(clear, clear);
        return read;
    }

    /** Whether `readBlob(site, path, etag)` would answer without a call. */
    async hasBlob(site: string, path: string, etag: string): Promise<boolean> {
        if (!etag) return false;
        return (await this.store.getBlob(this.key(site, path)))?.etag === etag;
    }

    /**
     * The stored bytes of `path` whatever their etag, or null. Only for files that
     * are never rewritten under the same name (FileLM's cache packs); anything else
     * goes through `readBlob` with the listing's etag.
     */
    async storedBlob(site: string, path: string): Promise<Blob | null> {
        return (await this.store.getBlob(this.key(site, path)))?.blob ?? null;
    }

    /** Keep bytes fetched some other way (fetchMany) for `storedBlob`/`readBlob`. */
    keepBlob(site: string, path: string, etag: string, blob: Blob): void {
        void this.store.putBlob(this.key(site, path), { etag, contentType: blob.type, blob });
    }

    /** The session's listing of `path` when it is under a minute old, else null. Never calls. */
    async freshList(site: string, path: string): Promise<SpListing | null> {
        const hit = this.listings.get(this.key(site, path));
        if (!hit || Date.now() - hit.at >= LIST_TTL_MS) return null;
        try { return await hit.value; } catch { return null; }
    }

    /**
     * Several files in one call, in batches the flow accepts. For many SMALL files:
     * the flow answers a batch more slowly per megabyte than separate `fetch` calls
     * side by side, so large files go through `fetchBlob` under `mapLimit` instead.
     * Each entry is the file or a per-file error; one missing file does not fail the
     * rest. A batch that would pass the flow's size cap returns the overflow as
     * `too_large_for_batch`, which is fetched again in the next call.
     */
    async fetchMany(site: string, paths: string[]): Promise<Array<SpFetched | SpFetchFailure>> {
        const out = new Map<string, SpFetched | SpFetchFailure>();
        let queue = [...paths];
        while (queue.length) {
            const batch = queue.slice(0, SP_MAX_BATCH_FILES);
            queue = queue.slice(batch.length);
            const r = await this.call<{ files: Array<SpFetched | SpFetchFailure> }>({ op: 'fetch_many', site, paths: batch });
            const deferred: string[] = [];
            for (const f of r.files || []) {
                if ('error' in f && f.error === 'too_large_for_batch') deferred.push(f.path);
                else out.set(f.path, f);
            }
            // The first file of a batch always fits, so this always makes progress.
            queue = [...deferred, ...queue];
        }
        return paths.map(p => out.get(p) ?? { path: p, error: 'not_found' });
    }

    /** Move a file or folder to the site's recycle bin. */
    async remove(site: string, path: string): Promise<void> {
        await this.call({ op: 'delete', site, path });
        const key = this.key(site, path);
        void this.store.deleteBlob(key);
        this.patch(site, spParent(path), l => ({
            ...l,
            files: l.files.filter(f => this.key(site, f.path) !== key),
            folders: l.folders.filter(f => this.key(site, f.path) !== key),
        }));
        this.invalidate(site, path, true);
    }
}
