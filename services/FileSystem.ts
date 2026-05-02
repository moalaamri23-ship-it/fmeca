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
const initDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = (e: any) => {
        const db: IDBDatabase = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
        if (!db.objectStoreNames.contains('blob_files')) db.createObjectStore('blob_files');
    };
    req.onsuccess = (e: any) => resolve(e.target.result);
    req.onerror = () => reject(new Error('Failed to open database.'));
});

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

// Opens a popup (top-level context) to call showDirectoryPicker on behalf of the iframe.
const pickFolderViaPopup = (): Promise<FileSystemDirectoryHandle> => {
    return new Promise((resolve, reject) => {
        const popup = window.open('/folder-picker.html', '_blank', 'width=420,height=180');
        if (!popup) { reject(new Error('Popup blocked. Please allow popups for this site.')); return; }
        let done = false;
        const cleanup = () => { done = true; window.removeEventListener('message', onMsg); clearInterval(poll); };
        const onMsg = (e: MessageEvent) => {
            if (done) return;
            if (typeof e.data !== 'object' || !e.data || !String(e.data.type).startsWith('fmeca-')) return;
            if (e.data.type === 'fmeca-folder-picked' && e.data.handle) { cleanup(); resolve(e.data.handle); }
            else if (e.data.type === 'fmeca-folder-cancelled') { cleanup(); reject(new Error(e.data.error || 'Folder selection cancelled.')); }
        };
        window.addEventListener('message', onMsg);
        const poll = setInterval(() => { if (!done && popup.closed) { cleanup(); reject(new Error('Folder selection cancelled.')); } }, 500);
    });
};

// Pick a folder — popup if in iframe, direct API if standalone.
export const pickFolder = async (): Promise<FileSystemDirectoryHandle> => {
    if (isInIframe()) return pickFolderViaPopup();
    return window.showDirectoryPicker();
};

export const sanitizeName = (n: string | undefined): string => (n||'Untitled').replace(/[^a-z0-9 \-_]/gi, '_').trim();

export class LocalFileSystemProvider {
    // Returns cached handle if permission is still granted. Never prompts.
    private async getCachedRoot(projectId: string): Promise<FileSystemDirectoryHandle | null> {
        const handle = await getProjectHandle(projectId);
        if (!handle) return null;
        try {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) === 'granted') return handle;
            // In standalone mode, try requesting permission (may show browser prompt).
            // In iframe mode, requestPermission is blocked — skip it.
            if (!isInIframe()) {
                if ((await handle.requestPermission(opts)) === 'granted') return handle;
            }
        } catch {}
        return null;
    }

    // Returns handle, prompting user to pick if needed. Must be called from a user gesture.
    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (!('showDirectoryPicker' in window)) {
            throw new Error("Local folder access is not supported in this browser.");
        }
        const cached = await this.getCachedRoot(projectId);
        if (cached) return cached;

        try {
            const handle = await pickFolder();
            await saveProjectHandle(projectId, handle);
            return handle;
        } catch (err: any) {
            if (err.name === 'AbortError') throw new Error("Folder selection cancelled.");
            throw err;
        }
    }

    async setRoot(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
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
