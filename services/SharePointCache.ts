/**
 * What SharePointFiles keeps between page loads: the last listing of each folder,
 * and the bytes of files already opened (keyed by path, checked against the etag).
 *
 * Every flow call costs seconds, so the Attachments panel shows the stored listing
 * at once and refreshes it behind, and a file opened before opens again without a
 * call when its etag has not changed. Under Teams this storage is partitioned from
 * the browser's, so each place fills its own.
 *
 * A failing store never fails a call: every method swallows its errors and the
 * client falls back to the flow.
 */
import type { SpListing } from './SharePointFiles';

export interface SpStoredBlob { etag: string; contentType: string; blob: Blob }

export interface SpPersistentCache {
    getListing(key: string): Promise<SpListing | null>;
    putListing(key: string, listing: SpListing): Promise<void>;
    deleteListing(key: string): Promise<void>;
    getBlob(key: string): Promise<SpStoredBlob | null>;
    putBlob(key: string, value: SpStoredBlob): Promise<void>;
    deleteBlob(key: string): Promise<void>;
    /** Small values the client keeps between sessions (the sites list). */
    getJson<T>(key: string): Promise<T | null>;
    putJson(key: string, value: unknown): Promise<void>;
}

/** Stored file bytes are trimmed, least recently used first, past this total. */
export const SP_BLOB_CACHE_BYTES = 1024 * 1024 * 1024;

const DB_NAME = 'FmecaPro_SP';
const LISTINGS = 'listings';
const BLOBS = 'blobs';
/** Size and last use of each blob, so trimming never loads the bytes. */
const BLOB_META = 'blobMeta';

interface BlobMeta { size: number; at: number }

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export class IndexedDbSpCache implements SpPersistentCache {
    private db: Promise<IDBDatabase> | null = null;

    constructor(private maxBlobBytes = SP_BLOB_CACHE_BYTES) {}

    private open(): Promise<IDBDatabase> {
        if (!this.db) {
            this.db = new Promise<IDBDatabase>((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    for (const name of [LISTINGS, BLOBS, BLOB_META]) {
                        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            this.db.catch(() => { this.db = null; });
        }
        return this.db;
    }

    /**
     * Ask the browser not to clear this origin's storage under pressure. Chromium
     * grants it without a prompt for sites the user visits often; a refusal changes
     * nothing here.
     */
    private persisted = false;
    private keep() {
        if (this.persisted) return;
        this.persisted = true;
        try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* not available */ }
    }

    private async quietly<T>(fallback: T, run: (db: IDBDatabase) => Promise<T>): Promise<T> {
        try { return await run(await this.open()); } catch { return fallback; }
    }

    getListing(key: string) {
        return this.quietly<SpListing | null>(null, async db =>
            (await request(db.transaction(LISTINGS).objectStore(LISTINGS).get(key))) ?? null);
    }

    putListing(key: string, listing: SpListing) {
        return this.quietly(undefined, async db => {
            const tx = db.transaction(LISTINGS, 'readwrite');
            tx.objectStore(LISTINGS).put(listing, key);
            await done(tx);
        });
    }

    deleteListing(key: string) {
        return this.quietly(undefined, async db => {
            const tx = db.transaction(LISTINGS, 'readwrite');
            tx.objectStore(LISTINGS).delete(key);
            await done(tx);
        });
    }

    getJson<T>(key: string) {
        // Shares the listings store; the prefix keeps it clear of "site|path" keys.
        return this.quietly<T | null>(null, async db =>
            ((await request(db.transaction(LISTINGS).objectStore(LISTINGS).get('json:' + key))) as T | undefined) ?? null);
    }

    putJson(key: string, value: unknown) {
        return this.quietly(undefined, async db => {
            const tx = db.transaction(LISTINGS, 'readwrite');
            tx.objectStore(LISTINGS).put(value, 'json:' + key);
            await done(tx);
        });
    }

    getBlob(key: string) {
        return this.quietly<SpStoredBlob | null>(null, async db => {
            const value: SpStoredBlob | undefined = await request(db.transaction(BLOBS).objectStore(BLOBS).get(key));
            if (!value) return null;
            // Mark it used, so trimming keeps what is opened often.
            const tx = db.transaction(BLOB_META, 'readwrite');
            tx.objectStore(BLOB_META).put({ size: value.blob.size, at: Date.now() } as BlobMeta, key);
            void done(tx).catch(() => {});
            return value;
        });
    }

    putBlob(key: string, value: SpStoredBlob) {
        return this.quietly(undefined, async db => {
            if (value.blob.size > this.maxBlobBytes) return;
            this.keep();
            const tx = db.transaction([BLOBS, BLOB_META], 'readwrite');
            tx.objectStore(BLOBS).put(value, key);
            tx.objectStore(BLOB_META).put({ size: value.blob.size, at: Date.now() } as BlobMeta, key);
            await done(tx);
            await this.trim(db);
        });
    }

    deleteBlob(key: string) {
        return this.quietly(undefined, async db => {
            const tx = db.transaction([BLOBS, BLOB_META], 'readwrite');
            tx.objectStore(BLOBS).delete(key);
            tx.objectStore(BLOB_META).delete(key);
            await done(tx);
        });
    }

    private async trim(db: IDBDatabase) {
        const store = db.transaction(BLOB_META).objectStore(BLOB_META);
        const [keys, metas] = await Promise.all([
            request(store.getAllKeys()), request(store.getAll()) as Promise<BlobMeta[]>,
        ]);
        let total = metas.reduce((s, m) => s + (m?.size || 0), 0);
        if (total <= this.maxBlobBytes) return;
        const order = keys.map((k, i) => ({ k, m: metas[i] })).sort((a, b) => a.m.at - b.m.at);
        const tx = db.transaction([BLOBS, BLOB_META], 'readwrite');
        for (const { k, m } of order) {
            if (total <= this.maxBlobBytes) break;
            tx.objectStore(BLOBS).delete(k);
            tx.objectStore(BLOB_META).delete(k);
            total -= m.size;
        }
        await done(tx);
    }
}

/** In memory only: for tests, and where IndexedDB is missing. */
export class MemorySpCache implements SpPersistentCache {
    listings = new Map<string, SpListing>();
    blobs = new Map<string, SpStoredBlob>();
    async getListing(key: string) { return this.listings.get(key) ?? null; }
    async putListing(key: string, listing: SpListing) { this.listings.set(key, listing); }
    async deleteListing(key: string) { this.listings.delete(key); }
    async getBlob(key: string) { return this.blobs.get(key) ?? null; }
    async putBlob(key: string, value: SpStoredBlob) { this.blobs.set(key, value); }
    async deleteBlob(key: string) { this.blobs.delete(key); }
    json = new Map<string, unknown>();
    async getJson<T>(key: string) { return (this.json.get(key) as T | undefined) ?? null; }
    async putJson(key: string, value: unknown) { this.json.set(key, value); }
}

/** IndexedDB in a browser, memory elsewhere. */
export function defaultSpCache(): SpPersistentCache {
    return typeof indexedDB !== 'undefined' ? new IndexedDbSpCache() : new MemorySpCache();
}
