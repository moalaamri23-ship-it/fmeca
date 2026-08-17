import { FileEntry } from '../types';

declare global {
    interface FileSystemHandlePermissionDescriptor {
        mode?: 'read' | 'readwrite';
    }

    interface FileSystemHandle {
        queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
        requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    }
}

const IDB_NAME = 'FmecaPro_FS';
const STORE_NAME = 'project_handles';
const BLOB_STORE = 'blob_files';

// The File System Access API is unusable from a cross-origin iframe: the picker is
// blocked outright, and a handle picked in some other window belongs to a different
// browsing context. Handing such a handle to the frame and writing through it is
// undefined behaviour — it used to appear to work, and now tears down the whole
// browser on Windows. Embedded builds therefore never touch the API; attachments are
// kept in IndexedDB instead, and the standalone tab still writes real folders on disk.
export const isEmbedded = (): boolean => {
    try { return window.self !== window.top; } catch { return true; }
};

export const supportsDiskFolders = (): boolean =>
    !isEmbedded() && typeof (window as any).showDirectoryPicker === 'function';

// Keep version 2 — downgrading would break existing databases
let dbPromise: Promise<IDBDatabase> | null = null;

const initDB = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 2);
        req.onupgradeneeded = (e: any) => {
            const db: IDBDatabase = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
            if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
        };
        req.onsuccess = (e: any) => resolve(e.target.result);
        req.onerror = () => reject(new Error('Failed to open local storage.'));
    });
    // A failed open must not poison every later call
    dbPromise.catch(() => { dbPromise = null; });
    return dbPromise;
};

const saveProjectHandle = async (projectId: string, handle: FileSystemDirectoryHandle): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Failed to save folder handle.'));
    });
};

const getProjectHandle = async (projectId: string): Promise<FileSystemDirectoryHandle | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('Failed to read folder handle.'));
    });
};

const deleteProjectHandle = async (projectId: string): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve(); // best-effort cleanup
    });
};

// ── IndexedDB attachment store (embedded mode) ────────────────────────────────

interface BlobRecord { name: string; mimeType: string; data: ArrayBuffer; savedAt: number; }

const pathKeyOf = (pathParts: string[]): string => pathParts.map(sanitizeName).join('/');
const blobKey = (projectId: string, pathKey: string, filename: string) =>
    `${projectId}||${pathKey}||${filename}`;

const putBlob = async (key: string, record: BlobRecord): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).put(record, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(
            tx.error?.name === 'QuotaExceededError'
                ? new Error('Not enough browser storage left for that file. Delete some attachments and try again.')
                : new Error('Could not save the file.')
        );
    });
};

const getAllBlobKeys = async (): Promise<string[]> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE).getAllKeys();
        req.onsuccess = () => resolve(req.result as string[]);
        req.onerror = () => reject(new Error('Could not read stored files.'));
    });
};

const getBlob = async (key: string): Promise<BlobRecord | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const req = db.transaction(BLOB_STORE, 'readonly').objectStore(BLOB_STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error('Could not read the file.'));
    });
};

const removeBlob = async (key: string): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(BLOB_STORE, 'readwrite');
        tx.objectStore(BLOB_STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(new Error('Could not delete the file.'));
    });
};

// ── Folder picking (standalone tab only) ──────────────────────────────────────

// Thrown when the user closes the picker without choosing — callers treat this as a no-op.
export class FolderSelectionCancelled extends Error {
    constructor() { super('Folder selection cancelled.'); this.name = 'FolderSelectionCancelled'; }
}

export const isCancellation = (err: any): boolean =>
    !!err && (err.name === 'AbortError' || err.name === 'FolderSelectionCancelled');

const WRITE_DENIED_MSG =
    'Write access to that folder was refused. Browsers block writing to folders like Documents, Desktop, or Downloads directly — create a subfolder (e.g. Documents/FMECA) and pick that instead.';

const EMBEDDED_MSG =
    'Disk folders are not available while FMECA Studio runs inside the portal. Open it in its own tab to use a folder on your computer.';

// Folder names the File System Access API rejects outright.
export const sanitizeName = (n: string | undefined): string => {
    const cleaned = (n || '').replace(/[^a-z0-9 \-_]/gi, '_').trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled';
    return cleaned;
};

// Confirms the handle is actually writable, prompting once if needed.
const ensureWritable = async (handle: FileSystemDirectoryHandle): Promise<boolean> => {
    const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
    try {
        if ((await handle.queryPermission(opts)) === 'granted') return true;
        return (await handle.requestPermission(opts)) === 'granted';
    } catch {
        return false;
    }
};

export class LocalFileSystemProvider {
    /** True when this context can write real folders on disk. False inside the portal iframe. */
    readonly diskMode: boolean = supportsDiskFolders();

    // Handles already confirmed as writable this session — lets callers skip the
    // IndexedDB round-trip that would otherwise burn the click's user activation.
    private liveRoots = new Map<string, FileSystemDirectoryHandle>();

    // Returns cached handle if permission is still granted. Never prompts.
    private async getCachedRoot(projectId: string): Promise<FileSystemDirectoryHandle | null> {
        if (!this.diskMode) return null;
        const live = this.liveRoots.get(projectId);
        if (live) return live;
        const handle = await getProjectHandle(projectId);
        if (!handle) return null;
        try {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            const state = await handle.queryPermission(opts);
            if (state === 'granted') { this.liveRoots.set(projectId, handle); return handle; }
            // Write access denied outright — the handle is dead. Purge it so the user
            // gets a fresh picker instead of a cache that can never succeed.
            if (state === 'denied') { await deleteProjectHandle(projectId); return null; }
            if ((await handle.requestPermission(opts)) === 'granted') {
                this.liveRoots.set(projectId, handle);
                return handle;
            }
        } catch {}
        return null;
    }

    /** In embedded mode there is no root to pick, so attachments are always ready. */
    async hasRoot(projectId: string): Promise<boolean> {
        if (!this.diskMode) return true;
        return !!(await this.getCachedRoot(projectId));
    }

    // Prompts for a folder. Call this straight from a click handler — it does no
    // awaiting before opening the picker, so the user activation is still valid.
    async chooseRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (!this.diskMode) throw new Error(EMBEDDED_MSG);
        let handle: FileSystemDirectoryHandle;
        try {
            const picker = (window as any).showDirectoryPicker as
                (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
            handle = await picker({ mode: 'readwrite' });
        } catch (err: any) {
            if (err?.name === 'AbortError') throw new FolderSelectionCancelled();
            throw err;
        }
        // Never save a handle that can't be written to — a read-only root would make
        // every later upload fail with an opaque NotAllowedError.
        if (!(await ensureWritable(handle))) throw new Error(WRITE_DENIED_MSG);
        this.liveRoots.set(projectId, handle);
        await saveProjectHandle(projectId, handle);
        return handle;
    }

    async setRoot(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
        this.liveRoots.set(projectId, handle);
        await saveProjectHandle(projectId, handle);
    }

    // Returns the root, prompting the user to pick one if needed.
    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (!this.diskMode) throw new Error(EMBEDDED_MSG);
        const cached = await this.getCachedRoot(projectId);
        if (cached) return cached;
        return this.chooseRoot(projectId);
    }

    // A NotAllowedError mid-write means the root lost (or never had) write access.
    // Drop the dead handle so the next attempt re-prompts, and explain the cause.
    private async writeFailed(projectId: string, err: any): Promise<never> {
        if (err?.name === 'NotAllowedError') {
            this.liveRoots.delete(projectId);
            await deleteProjectHandle(projectId);
            throw new Error(WRITE_DENIED_MSG);
        }
        throw err;
    }

    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<FileSystemDirectoryHandle> {
        if (!this.diskMode) throw new Error(EMBEDDED_MSG);
        const root = await this.getRoot(projectId);
        try {
            let curr = root;
            for (const part of pathParts) {
                curr = await curr.getDirectoryHandle(sanitizeName(part), { create: true });
            }
            return curr;
        } catch (err: any) {
            return this.writeFailed(projectId, err);
        }
    }

    async uploadFiles(projectId: string, pathParts: string[], files: FileList): Promise<void> {
        if (!this.diskMode) {
            const key = pathKeyOf(pathParts);
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const data = await file.arrayBuffer();
                await putBlob(blobKey(projectId, key, file.name), {
                    name: file.name,
                    mimeType: file.type || 'application/octet-stream',
                    data,
                    savedAt: Date.now(),
                });
            }
            return;
        }
        const dir = await this.ensureFolderForEntity(projectId, pathParts);
        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const fileHandle = await dir.getFileHandle(file.name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(file);
                await writable.close();
            }
        } catch (err: any) {
            await this.writeFailed(projectId, err);
        }
    }

    // Never prompts. Returns [] when nothing is stored for this entity yet.
    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        try {
            if (!this.diskMode) {
                const prefix = `${projectId}||${pathKeyOf(pathParts)}||`;
                const keys = (await getAllBlobKeys()).filter(k => k.startsWith(prefix));
                const entries: FileEntry[] = [];
                for (const key of keys) {
                    const rec = await getBlob(key);
                    if (rec) entries.push({ name: rec.name, data: rec.data, mimeType: rec.mimeType });
                }
                return entries.sort((a, b) => a.name.localeCompare(b.name));
            }
            const root = await this.getCachedRoot(projectId);
            if (!root) return [];
            let curr = root;
            for (const part of pathParts) {
                try { curr = await curr.getDirectoryHandle(sanitizeName(part), { create: false }); }
                catch { return []; }
            }
            const files: FileEntry[] = [];
            // @ts-ignore - Async iterator for FileSystemDirectoryHandle
            for await (const entry of curr.values()) {
                if (entry.kind === 'file') {
                    files.push({ name: entry.name, handle: entry as FileSystemFileHandle });
                }
            }
            return files;
        } catch (e) {
            console.warn(e);
            return [];
        }
    }

    async deleteFile(projectId: string, pathParts: string[], name: string): Promise<void> {
        if (!this.diskMode) {
            await removeBlob(blobKey(projectId, pathKeyOf(pathParts), name));
            return;
        }
        const root = await this.getCachedRoot(projectId);
        if (!root) return;
        let curr = root;
        for (const part of pathParts) {
            curr = await curr.getDirectoryHandle(sanitizeName(part), { create: false });
        }
        try {
            await curr.removeEntry(name);
        } catch (err: any) {
            await this.writeFailed(projectId, err);
        }
    }

    /** Materialises an entry as a Blob, whichever backing store it came from. */
    async readFile(entry: FileEntry): Promise<Blob> {
        if (entry.handle) return entry.handle.getFile();
        if (entry.data) return new Blob([entry.data], { type: entry.mimeType || 'application/octet-stream' });
        throw new Error('That file is no longer available.');
    }
}
