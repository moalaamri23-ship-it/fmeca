import { FileEntry } from '../types';
import {
    DirHandleLike,
    FileHandleLike,
    IN_IFRAME,
    PICK_IN_BRIDGE,
    WritableRootBridge,
    hasPermission,
    openWritableRootBridge,
    pickRootDirectory,
    requestPermission,
} from './FsBridge';

export {
    IN_IFRAME,
    FSA_SUPPORTED,
    describePickerFailure,
    hasPermission,
    requestPermission,
} from './FsBridge';
export type { DirHandleLike, FileHandleLike } from './FsBridge';

const IDB_NAME = 'FmecaPro_FS';
const STORE_NAME = 'project_handles';

// Whether a project has a folder is otherwise only knowable through IndexedDB,
// which is too slow for a click: a window has to be opened before the first
// await, or the browser will not treat it as user-initiated. This marker answers
// the same question synchronously, and is corrected whenever the real one is.
const LINK_KEY = (projectId: string) => `fmeca_fs_linked_${projectId}`;

const markLinked = (projectId: string, linked: boolean): void => {
    try {
        if (linked) localStorage.setItem(LINK_KEY(projectId), '1');
        else localStorage.removeItem(LINK_KEY(projectId));
    } catch { /* a hint, never the truth */ }
};

export const isInIframe = (): boolean => IN_IFRAME;

/** Thrown when the user closes the picker without choosing — callers ignore it. */
export class FolderSelectionCancelled extends Error {
    constructor() { super('Folder selection cancelled.'); this.name = 'FolderSelectionCancelled'; }
}

/**
 * An open write channel. Embedded, it owns the helper window; standalone it is
 * nothing at all. Held open for as long as the app may write, so that later
 * clicks can spend their user activation on the file picker instead.
 */
export interface WriteSession {
    rootPromise: Promise<DirHandleLike>;
    done: () => void;
    /** False once the window is gone — closed by the user, or never opened. */
    isLive: () => boolean;
}

export const isCancellation = (err: any): boolean =>
    !!err && (err.name === 'AbortError' || err.name === 'FolderSelectionCancelled');

// Keep version 2 — downgrading would break existing databases
let dbPromise: Promise<IDBDatabase> | null = null;

const initDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 2);
        req.onupgradeneeded = (e: any) => {
            const db: IDBDatabase = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            if (!db.objectStoreNames.contains('blob_files')) db.createObjectStore('blob_files');
        };
        req.onsuccess = (e: any) => resolve(e.target.result);
        req.onerror = () => reject(new Error('Failed to open database.'));
    });
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
};

const saveProjectHandle = async (projectId: string, handle: DirHandleLike): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to save folder handle.'));
    });
};

const getProjectHandle = async (projectId: string): Promise<DirHandleLike | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('Failed to read folder handle.'));
    });
};

/** Folder names the File System Access API rejects outright. */
export const sanitizeName = (n: string | undefined): string => {
    const cleaned = (n || '').replace(/[^a-z0-9 \-_]/gi, '_').trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled';
    return cleaned;
};

/** Walk (optionally creating) a path below a directory. */
const walk = async (
    dir: DirHandleLike,
    pathParts: string[],
    create: boolean
): Promise<DirHandleLike | null> => {
    let curr = dir;
    for (const part of pathParts) {
        try { curr = await curr.getDirectoryHandle(sanitizeName(part), { create }); }
        catch { return null; }
    }
    return curr;
};

export class LocalFileSystemProvider {
    /** True when the browser bars this context from writing to disk directly. */
    readonly embedded: boolean = IN_IFRAME;

    // Kept in memory so the app can tell whether a project has a usable folder
    // without going back to IndexedDB for every listing.
    private liveRoots = new Map<string, DirHandleLike>();

    /**
     * Whether this project is known to have a folder, without awaiting anything.
     *
     * A hint from the last time the answer was known for certain, so that a click
     * can decide to open the saving window before IndexedDB could have replied.
     */
    isLinkedSync(projectId: string): boolean {
        if (this.liveRoots.has(projectId)) return true;
        try { return localStorage.getItem(LINK_KEY(projectId)) === '1'; } catch { return false; }
    }

    /** Loads the saved root and confirms it is still usable. Never prompts. */
    private async getCachedRoot(projectId: string): Promise<DirHandleLike | null> {
        const live = this.liveRoots.get(projectId);
        if (live) return live;
        const handle = await getProjectHandle(projectId);
        if (!handle) { markLinked(projectId, false); return null; }
        if (await hasPermission(handle)) { this.liveRoots.set(projectId, handle); markLinked(projectId, true); return handle; }
        // Outside a frame the browser will still prompt; inside one it refuses, and
        // the way back in is to pick the folder again.
        if (!this.embedded && (await requestPermission(handle))) {
            this.liveRoots.set(projectId, handle);
            markLinked(projectId, true);
            return handle;
        }
        markLinked(projectId, false);
        return null;
    }

    async hasRoot(projectId: string): Promise<boolean> {
        return !!(await this.getCachedRoot(projectId));
    }

    /** The linked folder's name, for showing the user where files are going. */
    async rootName(projectId: string): Promise<string | null> {
        const root = await this.getCachedRoot(projectId);
        return root ? root.name : null;
    }

    /**
     * Prompts for a folder. Must be called straight from a click — both the picker
     * and the popup that stands in for it need that click's user activation.
     */
    async chooseRoot(projectId: string): Promise<DirHandleLike | null> {
        const picked = await pickRootDirectory(projectId);
        if (!picked) throw new FolderSelectionCancelled();
        // The folder was chosen in a separate window when embedded, so confirm the
        // grant actually reached this context before relying on it.
        if (!(await hasPermission(picked)) && !this.embedded && !(await requestPermission(picked))) {
            throw new Error('Access to the chosen folder was not granted.');
        }
        this.liveRoots.set(projectId, picked);
        markLinked(projectId, true);
        await saveProjectHandle(projectId, picked);
        return picked;
    }

    async setRoot(projectId: string, handle: DirHandleLike): Promise<void> {
        this.liveRoots.set(projectId, handle);
        markLinked(projectId, true);
        await saveProjectHandle(projectId, handle);
    }

    /**
     * Opens the write channel. Embedded, that is a top-level window; standalone,
     * the root handle is already writable.
     *
     * MUST be called synchronously from the click, before any await. The caller
     * may keep the session for several operations, and must call done() once.
     */
    /**
     * Opens the write channel around a folder the helper window picks itself.
     *
     * Embedded, this is how a folder is chosen at all: the window that asks for
     * it stays on as the writer, so the upload that follows needs no window — and
     * therefore no click — of its own. `picked` resolves once the user has chosen.
     */
    beginPick(projectId: string): WriteSession & { picked: Promise<DirHandleLike> } {
        let resolvePicked: (handle: DirHandleLike) => void = () => {};
        const picked = new Promise<DirHandleLike>(resolve => { resolvePicked = resolve; });
        const session = this.beginWrite(projectId, PICK_IN_BRIDGE, handle => {
            this.liveRoots.set(projectId, handle);
            markLinked(projectId, true);
            void saveProjectHandle(projectId, handle);
            resolvePicked(handle);
        });
        // A window closed before anything was chosen must not leave a promise
        // that never settles.
        session.rootPromise.catch(() => {});
        return Object.assign(session, { picked });
    }

    beginWrite(
        projectId: string,
        source?: typeof PICK_IN_BRIDGE,
        onPicked?: (handle: DirHandleLike) => void
    ): WriteSession {
        const linkedRoot = source === PICK_IN_BRIDGE
            ? PICK_IN_BRIDGE
            : this.getCachedRoot(projectId).then(root => {
                if (!root) throw new Error('No project folder is linked yet. Pick one first.');
                return root;
            });
        if (!this.embedded) {
            const rootPromise = linkedRoot === PICK_IN_BRIDGE
                ? Promise.reject(new Error('Folder picking runs in this window when the app is not embedded.'))
                : linkedRoot;
            rootPromise.catch(() => {});
            return { rootPromise, done: () => {}, isLive: () => true };
        }
        // The bridge only listens for the folder once the window is up; keep a
        // handler on the promise meanwhile so a failure is never left unhandled.
        if (linkedRoot !== PICK_IN_BRIDGE) linkedRoot.catch(() => {});

        let bridge: WritableRootBridge | null = null;
        let finished = false;
        let lost = false;
        // The window opens on this click; the folder catches up with it.
        const rootPromise = openWritableRootBridge(linkedRoot, projectId, () => { lost = true; }, onPicked).then(b => {
            bridge = b;
            // A caller that already gave up must not leave the window hanging around.
            if (finished) { b.close(); throw new FolderSelectionCancelled(); }
            return b.root;
        });
        rootPromise.catch(() => { lost = true; });
        return {
            rootPromise,
            done: () => { finished = true; lost = true; if (bridge) bridge.close(); },
            isLive: () => !lost && !finished,
        };
    }

    /**
     * Runs one write against a session, opening a throwaway one when the caller
     * has none. A session the caller owns is left open for its next operation.
     */
    private async withWrite<T>(
        projectId: string,
        session: WriteSession | undefined,
        run: (root: DirHandleLike) => Promise<T>
    ): Promise<T> {
        const active = session ?? this.beginWrite(projectId);
        try { return await run(await active.rootPromise); }
        finally { if (!session) active.done(); }
    }

    /** Creates the folder chain for an entity. Call beginWrite from the click. */
    async ensureFolderForEntity(projectId: string, pathParts: string[], session?: WriteSession): Promise<void> {
        return this.withWrite(projectId, session, async root => {
            const dir = await walk(root, pathParts, true);
            if (!dir) throw new Error('Could not create that folder.');
        });
    }

    /**
     * Writes files the app's own file input already chose.
     *
     * Embedded, the helper window does the writing and reports the progress —
     * File objects survive postMessage as references to the same bytes, so
     * nothing is copied on the way there.
     */
    async writeChosenFiles(
        projectId: string,
        pathParts: string[],
        files: File[],
        session?: WriteSession
    ): Promise<number> {
        return this.withWrite(projectId, session, async root => {
            if (root.writeFiles) return (await root.writeFiles(pathParts, files)).written;
            const dir = await walk(root, pathParts, true);
            if (!dir) throw new Error('Could not open that folder for writing.');
            for (const file of files) {
                const fileHandle = await dir.getFileHandle(file.name, { create: true });
                const writable = await fileHandle.createWritable();
                try { await writable.write(file); } finally { await writable.close(); }
            }
            return files.length;
        });
    }

    /** Tells the helper window what it is waiting for. Silent when there is none. */
    async describeWrite(session: WriteSession, text: string): Promise<void> {
        try {
            const root = await session.rootPromise;
            if (root.setStatus) await root.setStatus(text);
        } catch {
            // Purely cosmetic — a session that cannot say this has bigger problems,
            // and the operation that needs it will report them itself.
        }
    }

    async deleteFile(projectId: string, pathParts: string[], name: string, session?: WriteSession): Promise<void> {
        return this.withWrite(projectId, session, async root => {
            const dir = await walk(root, pathParts, false);
            if (!dir) return;
            await dir.removeEntry(name, { recursive: true });
        });
    }

    /**
     * Lists files. Reads run here even when embedded — Chromium allows them
     * through the transferred handle, and only refuses writes.
     */
    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        try {
            const root = await this.getCachedRoot(projectId);
            if (!root) return [];
            const dir = await walk(root, pathParts, false);
            if (!dir) return [];
            const files: FileEntry[] = [];
            for await (const [, entry] of dir.entries()) {
                if (entry.kind === 'file' && !entry.name.startsWith('.')) {
                    files.push({ name: entry.name, handle: entry as FileHandleLike });
                }
            }
            return files.sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) {
            console.warn(e);
            return [];
        }
    }

    /** Materialises a listed file. Reading is allowed in the frame. */
    async readFile(entry: FileEntry): Promise<Blob> {
        if (!entry.handle) throw new Error('That file is no longer available.');
        return entry.handle.getFile();
    }
}
