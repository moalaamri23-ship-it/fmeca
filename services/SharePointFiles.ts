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
 * (`readBlob`). The store is SharePointCache.ts.
 */
import { routeFlowCall, hasFlowRoute, MISSING_FLOW_URL } from './AIRouter';
import { SpPersistentCache, MemorySpCache, defaultSpCache } from './SharePointCache';

export interface SpRoot { path: string; title: string }
export interface SpSite { site: string; title: string; roots: SpRoot[] }
export interface SpFolder { name: string; path: string; itemCount: number }
export interface SpFile { name: string; path: string; size: number; modified: string; etag: string }
export interface SpListing { path: string; folders: SpFolder[]; files: SpFile[] }
export interface SpFetched { name: string; path: string; size: number; contentType: string; etag: string; contentBase64: string }
export interface SpFetchFailure { path: string; error: string }
export interface SpWritten { path: string; size: number; etag: string }

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

/** One HTTP round trip to the router: the request body in, status and reply text out. */
export type SpTransport = (body: Record<string, unknown>) => Promise<{ status: number; text: string }>;

/** The real transport: POST to the OXY Connection Flow URL as text/plain (no CORS preflight). */
export function flowTransport(flowUrl: string): SpTransport {
    return async body => {
        if (!hasFlowRoute(flowUrl)) throw new SpError(0, 'bad_request', MISSING_FLOW_URL);
        const route = routeFlowCall(flowUrl, 'sp_files', body);
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

/** Ops that change nothing, so one retry after a timeout is safe. */
const RETRYABLE = new Set(['sites', 'list', 'fetch', 'fetch_many', 'mkdir']);

/** Uploads in flight at once. The flow runs each call as its own run. */
export const SP_UPLOAD_CONCURRENCY = 3;

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

export class SharePointFiles {
    private listings = new Map<string, { at: number; value: Promise<SpListing> }>();
    private sitesCache: Promise<SpSite[]> | null = null;
    /** Folders seen to exist this session, so an upload skips its mkdir call. */
    private knownFolders = new Set<string>();

    constructor(private transport: SpTransport, private store: SpPersistentCache = new MemorySpCache()) {}

    static forFlow(flowUrl: string): SharePointFiles {
        return new SharePointFiles(flowTransport(flowUrl), defaultSpCache());
    }

    private async call<T>(body: Record<string, unknown>): Promise<T> {
        const op = String(body.op);
        const attempt = async (): Promise<T> => {
            const { status, text } = await this.transport(body);
            let parsed: any = null;
            try { parsed = text ? JSON.parse(text) : null; } catch { /* router or gateway text */ }
            if (status >= 200 && status < 300 && parsed) return parsed as T;
            // Child failed or timed out inside the router: {error, runId} with no code of ours.
            if (status === 502 && parsed && !parsed.message && parsed.runId) {
                throw new SpError(502, 'flow_failed', parsed.error || 'The flow failed or timed out.');
            }
            const code = (parsed?.error as SpErrorCode) || (status === 404 ? 'not_found' : 'sharepoint_error');
            throw new SpError(status, code, String(parsed?.message || parsed?.error || text || `HTTP ${status}`).slice(0, 500));
        };
        try {
            return await attempt();
        } catch (e) {
            const retry = e instanceof SpError && RETRYABLE.has(op) && (e.code === 'flow_failed' || e.code === 'network');
            if (!retry) throw e;
            return attempt();
        }
    }

    /** Sites and roots the flow allows (its allowlist). Cached for the session. */
    sites(): Promise<SpSite[]> {
        if (!this.sitesCache) {
            this.sitesCache = this.call<{ sites: SpSite[] }>({ op: 'sites' }).then(r => r.sites || []);
            this.sitesCache.catch(() => { this.sitesCache = null; });
        }
        return this.sitesCache;
    }

    private key(site: string, path: string) {
        return site.replace(/\/+$/, '').toLowerCase() + '|' + path.replace(/\/+$/, '').toLowerCase();
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
        const r = await this.call<SpWritten>({
            op: 'write', site, path: folder, name: fileName, contentBase64,
            overwrite: !!opts.overwrite, ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
        });
        this.knownFolders.add(this.key(site, folder));
        // The flow does not return SharePoint's modified time, and this clock is not
        // SharePoint's: left empty, so anything that compares times asks for the real one.
        const written: SpFile = { name: fileName, path: r.path, size: r.size, modified: '', etag: r.etag };
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
     * says they have not changed since, else through the flow.
     */
    async readBlob(site: string, path: string, etag?: string): Promise<Blob> {
        if (etag) {
            const stored = await this.store.getBlob(this.key(site, path));
            if (stored && stored.etag === etag) return stored.blob;
        }
        return (await this.fetchBlob(site, path)).blob;
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
     * Several files, in batches the flow accepts. Each entry is the file or a
     * per-file error; one missing file does not fail the rest. A batch that would
     * pass the flow's size cap returns the overflow as `too_large_for_batch`, which
     * is fetched again in the next call.
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
