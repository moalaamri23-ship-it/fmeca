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

const initDB = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = (e: any) => { 
        if(!e.target.result.objectStoreNames.contains(STORE_NAME)) {
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

export const sanitizeName = (n: string | undefined): string => (n||'Untitled').replace(/[^a-z0-9 \-_]/gi, '_').trim();

export class LocalFileSystemProvider {
    async getRoot(projectId: string): Promise<FileSystemDirectoryHandle> {
        if (!('showDirectoryPicker' in window)) {
            throw new Error("Local folder access is not supported in this browser.");
        }
        // 1. Try to get existing handle from DB
        let handle = await getProjectHandle(projectId);
        
        // 2. If valid handle exists, verify/request permission
        if (handle) {
            const opts: FileSystemHandlePermissionDescriptor = { mode: 'readwrite' };
            if ((await handle.queryPermission(opts)) !== 'granted') {
                if ((await handle.requestPermission(opts)) !== 'granted') {
                    throw new Error("Permission to access folder was denied.");
                }
            }
            return handle;
        }

        // 3. If no handle, prompt user to pick one
        try {
            handle = await window.showDirectoryPicker();
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

    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        try {
            const dir = await this.ensureFolderForEntity(projectId, pathParts);
            const files: FileEntry[] = [];
            // @ts-ignore - Async iterator for FileSystemDirectoryHandle
            for await (const entry of dir.values()) {
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