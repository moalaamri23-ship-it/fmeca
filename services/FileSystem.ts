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

export const isInIframe = (): boolean => {
    try { return window.self !== window.top; } catch { return true; }
};

const initDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e: any) => {
        if (!e.target.result.objectStoreNames.contains(STORE_NAME)) {
            e.target.result.createObjectStore(STORE_NAME);
        }
    };
    req.onsuccess = (e: any) => resolve(e.target.result);
    req.onerror = reject;
});

const saveProjectHandle = async (projectId: string, handle: FileSystemDirectoryHandle): Promise<void> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = reject;
    });
};

const getProjectHandle = async (projectId: string): Promise<FileSystemDirectoryHandle | undefined> => {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(projectId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = reject;
    });
};

// Opens a small popup that calls showDirectoryPicker() as a top-level frame,
// then posts the handle back — used when running inside a cross-origin iframe.
const pickFolderViaPopup = (): Promise<FileSystemDirectoryHandle> => {
    return new Promise((resolve, reject) => {
        const url = `/folder-picker.html?origin=${encodeURIComponent(window.location.origin)}`;
        const popup = window.open(url, 'fmeca-folder-picker', 'width=420,height=160,left=200,top=200');
        if (!popup) {
            reject(new Error('Popup was blocked. Please allow popups for this site and try again.'));
            return;
        }
        let settled = false;
        const handler = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type === 'fmeca-folder-picked') {
                settled = true;
                window.removeEventListener('message', handler);
                clearInterval(poll);
                resolve(event.data.handle as FileSystemDirectoryHandle);
            } else if (event.data?.type === 'fmeca-folder-cancelled') {
                settled = true;
                window.removeEventListener('message', handler);
                clearInterval(poll);
                reject(new Error(event.data.error || 'Folder selection cancelled.'));
            }
        };
        window.addEventListener('message', handler);
        // Fallback: if the popup is closed before a message arrives, reject.
        const poll = setInterval(() => {
            if (popup.closed && !settled) {
                clearInterval(poll);
                window.removeEventListener('message', handler);
                reject(new Error('Folder selection cancelled.'));
            }
        }, 500);
    });
};

export const sanitizeName = (n: string | undefined): string => (n||'Untitled').replace(/[^a-z0-9 \-_]/gi, '_').trim();

export class LocalFileSystemProvider {
    // Returns cached handle only — never prompts. Used by read-only operations.
    private async tryGetRoot(projectId: string): Promise<FileSystemDirectoryHandle | undefined> {
        const handle = await getProjectHandle(projectId);
        if (!handle) return undefined;
        try {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) === 'granted') return handle;
            if ((await handle.requestPermission(opts)) === 'granted') return handle;
        } catch {}
        return undefined;
    }

    // Returns cached handle or prompts the user to pick one. Used by write operations.
    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (!('showDirectoryPicker' in window)) {
            throw new Error('Local folder access is not supported in this browser.');
        }
        const cached = await this.tryGetRoot(projectId);
        if (cached) return cached;

        // No cached handle — prompt user. Use popup when inside an iframe.
        try {
            const handle = isInIframe()
                ? await pickFolderViaPopup()
                : await window.showDirectoryPicker();
            await saveProjectHandle(projectId, handle);
            return handle;
        } catch (err: any) {
            if (err.name === 'AbortError') throw new Error('Folder selection cancelled.');
            throw new Error(err?.message || 'Folder selection failed.');
        }
    }

    // Explicitly pick (or re-pick) a root folder for the project.
    async pickRoot(projectId: string): Promise<void> {
        if (!('showDirectoryPicker' in window)) {
            throw new Error('Local folder access is not supported in this browser.');
        }
        const handle = isInIframe()
            ? await pickFolderViaPopup()
            : await window.showDirectoryPicker();
        await saveProjectHandle(projectId, handle);
    }

    async setRoot(projectId: string, handle: FileSystemDirectoryHandle): Promise<void> {
        await saveProjectHandle(projectId, handle);
    }

    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<FileSystemDirectoryHandle> {
        const root = await this.getRoot(projectId);
        let curr = root;
        for (const part of pathParts) {
            const clean = sanitizeName(part);
            curr = await curr.getDirectoryHandle(clean, { create: true });
        }
        return curr;
    }

    async uploadFiles(projectId: string, pathParts: string[], files: FileList): Promise<void> {
        const dir = await this.ensureFolderForEntity(projectId, pathParts);
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileHandle = await dir.getFileHandle(file.name, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(file);
            await writable.close();
        }
    }

    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        try {
            const root = await this.tryGetRoot(projectId);
            if (!root) return [];
            // Walk path without creating — return [] if any segment is missing
            let curr = root;
            for (const part of pathParts) {
                try {
                    curr = await curr.getDirectoryHandle(sanitizeName(part), { create: false });
                } catch {
                    return [];
                }
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
