import { FileEntry } from '../types';
import {
    DirHandleLike,
    FileHandleLike,
    IN_IFRAME,
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

export const isInIframe = (): boolean => IN_IFRAME;

/** Thrown when the user closes the picker without choosing — callers ignore it. */
export class FolderSelectionCancelled extends Error {
    constructor() { super('Folder selection cancelled.'); this.name = 'FolderSelectionCancelled'; }
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

    // Kept in memory so a click handler can reach the root without awaiting IndexedDB
    // first — opening the write bridge after an await would lose user activation.
    private liveRoots = new Map<string, DirHandleLike>();

    /** The root as known right now, with no awaiting. Null until loadRoot has run. */
    rootSync(projectId: string): DirHandleLike | null {
        return this.liveRoots.get(projectId) ?? null;
    }

    /** Loads the saved root and confirms it is still usable. Never prompts. */
    private async getCachedRoot(projectId: string): Promise<DirHandleLike | null> {
        const live = this.liveRoots.get(projectId);
        if (live) return live;
        const handle = await getProjectHandle(projectId);
        if (!handle) return null;
        if (await hasPermission(handle)) { this.liveRoots.set(projectId, handle); return handle; }
        // Outside a frame the browser will still prompt; inside one it refuses, and
        // the way back in is to pick the folder again.
        if (!this.embedded && (await requestPermission(handle))) {
            this.liveRoots.set(projectId, handle);
            return handle;
        }
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
        await saveProjectHandle(projectId, picked);
        return picked;
    }

    async setRoot(projectId: string, handle: DirHandleLike): Promise<void> {
        this.liveRoots.set(projectId, handle);
        await saveProjectHandle(projectId, handle);
    }

    /**
     * Opens the write channel for one operation. Embedded, that is a short-lived
     * top-level window; standalone, the root handle is already writable.
     *
     * MUST be called synchronously from the click, before any await.
     */
    beginWrite(projectId: string): { rootPromise: Promise<DirHandleLike>; done: () => void } {
        const root = this.rootSync(projectId);
        if (!root) {
            return {
                rootPromise: Promise.reject(new Error('No project folder is linked yet. Pick one first.')),
                done: () => {},
            };
        }
        if (!this.embedded) return { rootPromise: Promise.resolve(root), done: () => {} };

        let bridge: WritableRootBridge | null = null;
        let finished = false;
        const rootPromise = openWritableRootBridge(root, projectId).then(b => {
            bridge = b;
            // A caller that already gave up must not leave the window hanging around.
            if (finished) { b.close(); throw new FolderSelectionCancelled(); }
            return b.root;
        });
        return {
            rootPromise,
            done: () => { finished = true; if (bridge) bridge.close(); },
        };
    }

    /** Creates the folder chain for an entity. Call beginWrite from the click. */
    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<void> {
        const { rootPromise, done } = this.beginWrite(projectId);
        try {
            const root = await rootPromise;
            const dir = await walk(root, pathParts, true);
            if (!dir) throw new Error('Could not create that folder.');
        } finally { done(); }
    }

    /** Standalone only: write files already chosen by the app's own file input. */
    async uploadFiles(projectId: string, pathParts: string[], files: FileList): Promise<void> {
        const { rootPromise, done } = this.beginWrite(projectId);
        try {
            const root = await rootPromise;
            const dir = await walk(root, pathParts, true);
            if (!dir) throw new Error('Could not open that folder for writing.');
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileHandle = await dir.getFileHandle(file.name, { create: true });
                const writable = await fileHandle.createWritable();
                try { await writable.write(file); } finally { await writable.close(); }
            }
        } finally { done(); }
    }

    /**
     * Embedded: choose the files in the helper window and write them there.
     *
     * A file input's `change` event is not an activation-triggering event, so the
     * frame cannot open the helper window once its own picker has run — that is
     * what surfaced as "pop-up blocked" on upload. Selecting the files inside the
     * helper keeps every gesture-gated call on a genuine click.
     *
     * Must be called straight from the Upload click.
     */
    async uploadViaHelper(projectId: string, pathParts: string[]): Promise<number> {
        const { rootPromise, done } = this.beginWrite(projectId);
        try {
            const root = await rootPromise;
            if (!root.pickAndWrite) throw new Error('The folder helper window is unavailable.');
            const result = await root.pickAndWrite(pathParts);
            return result.written;
        } finally { done(); }
    }

    async deleteFile(projectId: string, pathParts: string[], name: string): Promise<void> {
        const { rootPromise, done } = this.beginWrite(projectId);
        try {
            const root = await rootPromise;
            const dir = await walk(root, pathParts, false);
            if (!dir) return;
            await dir.removeEntry(name, { recursive: true });
        } finally { done(); }
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
