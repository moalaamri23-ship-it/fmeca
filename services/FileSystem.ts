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

const isInIframe = (): boolean => {
    try { return window.self !== window.top; } catch { return true; }
};

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

// Thrown when the user closes the picker without choosing — callers treat this as a no-op.
export class FolderSelectionCancelled extends Error {
    constructor() { super('Folder selection cancelled.'); this.name = 'FolderSelectionCancelled'; }
}

export const isCancellation = (err: any): boolean =>
    !!err && (err.name === 'AbortError' || err.name === 'FolderSelectionCancelled');

// Opens a popup (top-level context) to call showDirectoryPicker on behalf of the iframe.
const pickFolderViaPopup = (): Promise<FileSystemDirectoryHandle> => {
    return new Promise((resolve, reject) => {
        const popup = window.open('/folder-picker.html', '_blank', 'width=420,height=180');
        if (!popup) { reject(new Error('Popup blocked. Allow popups for this site, then pick the folder again.')); return; }
        let done = false;
        const cleanup = () => { done = true; window.removeEventListener('message', onMsg); clearInterval(poll); };
        const onMsg = (e: MessageEvent) => {
            if (done) return;
            if (typeof e.data !== 'object' || !e.data || !String(e.data.type).startsWith('fmeca-')) return;
            if (e.data.type === 'fmeca-folder-picked' && e.data.handle) { cleanup(); resolve(e.data.handle); }
            else if (e.data.type === 'fmeca-folder-cancelled') { cleanup(); reject(new FolderSelectionCancelled()); }
        };
        window.addEventListener('message', onMsg);
        const poll = setInterval(() => { if (!done && popup.closed) { cleanup(); reject(new FolderSelectionCancelled()); } }, 500);
    });
};

// Pick a folder — popup if in iframe, direct API if standalone.
// Must be called first thing inside a click handler: the picker (and the popup
// that stands in for it) needs the transient user activation from that click.
export const pickFolder = async (): Promise<FileSystemDirectoryHandle> => {
    if (typeof window.showDirectoryPicker !== 'function') {
        throw new Error('Local folder access is not supported in this browser. Use Chrome, Edge, or another Chromium browser.');
    }
    if (isInIframe()) return pickFolderViaPopup();
    try {
        const picker = window.showDirectoryPicker as (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
        return await picker({ mode: 'readwrite' });
    } catch (err: any) {
        if (err?.name === 'AbortError') throw new FolderSelectionCancelled();
        // Some embeds report as top-level but still block the picker — fall back to the popup.
        if (err?.name === 'SecurityError' || err?.name === 'NotAllowedError') return pickFolderViaPopup();
        throw err;
    }
};

// Folder names the File System Access API rejects outright.
export const sanitizeName = (n: string | undefined): string => {
    const cleaned = (n || '').replace(/[^a-z0-9 \-_]/gi, '_').trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return 'Untitled';
    return cleaned;
};

export class LocalFileSystemProvider {
    // Handles already confirmed as writable this session — lets callers skip the
    // IndexedDB round-trip that would otherwise burn the click's user activation.
    private liveRoots = new Map<string, FileSystemDirectoryHandle>();

    // Returns cached handle if permission is still granted. Never prompts.
    private async getCachedRoot(projectId: string): Promise<FileSystemDirectoryHandle | null> {
        const live = this.liveRoots.get(projectId);
        if (live) return live;
        const handle = await getProjectHandle(projectId);
        if (!handle) return null;
        try {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) === 'granted') { this.liveRoots.set(projectId, handle); return handle; }
            // In standalone mode, try requesting permission (may show browser prompt).
            // In iframe mode, requestPermission is blocked — skip it.
            if (!isInIframe()) {
                if ((await handle.requestPermission(opts)) === 'granted') { this.liveRoots.set(projectId, handle); return handle; }
            }
        } catch {}
        return null;
    }

    // True when a writable root is already available without prompting.
    async hasRoot(projectId: string): Promise<boolean> {
        return !!(await this.getCachedRoot(projectId));
    }

    // Prompts for a folder. Call this synchronously from a click handler — it does
    // no awaiting before opening the picker, so the user activation is still valid.
    async chooseRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        const handle = await pickFolder();
        this.liveRoots.set(projectId, handle);
        await saveProjectHandle(projectId, handle);
        return handle;
    }

    // Returns handle, prompting user to pick if needed. Must be called from a user gesture.
    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        const cached = await this.getCachedRoot(projectId);
        if (cached) return cached;
        return this.chooseRoot(projectId);
    }

    async setRoot(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
        this.liveRoots.set(projectId, handle);
        await saveProjectHandle(projectId, handle);
    }

    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<FileSystemDirectoryHandle> {
        const root = await this.getRoot(projectId);
        let curr = root;
        for(const part of pathParts) {
            const clean = sanitizeName(part);
            curr = await curr.getDirectoryHandle(clean, { create: true });
        }
        return curr;
    }

    async uploadFiles(projectId: string, pathParts: string[], files: FileList): Promise<void> {
        const dir = await this.ensureFolderForEntity(projectId, pathParts);
        for(let i=0; i<files.length; i++) {
            const file = files[i];
            const fileHandle = await dir.getFileHandle(file.name, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
        }
    }

    // Uses cached handle only — never prompts. Returns [] if no folder picked yet.
    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        try {
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
        } catch(e) {
            console.warn(e);
            return [];
        }
    }
}
