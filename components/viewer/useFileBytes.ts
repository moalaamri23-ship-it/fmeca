import { useEffect, useState } from 'react';
import type { FileEntry } from '../../types';
import type { LocalFileSystemProvider } from '../../services/FileSystem';

// Reads go through the folder handle the project is linked to, which works even
// when the app is embedded — Chromium only refuses WRITES through a transferred
// handle. Cached in memory because a session reopens the same few documents.
const cache = new Map<string, ArrayBuffer>();

export type BytesState =
    | { status: 'loading' }
    | { status: 'ready'; bytes: ArrayBuffer }
    | { status: 'error'; message: string };

const LOADING: BytesState = { status: 'loading' };

/** Cache key for one file inside one folder. */
export const fileKey = (pathParts: string[], name: string): string => [...pathParts, name].join('/');

/**
 * Load a reference file's bytes. `key` identifies the file for caching, so two
 * files of the same name in different folders never collide.
 */
export function useFileBytes(
    provider: LocalFileSystemProvider | null,
    entry: FileEntry | null,
    key: string
): BytesState {
    const [loaded, setLoaded] = useState<{ key: string; state: BytesState } | null>(null);

    useEffect(() => {
        if (!provider || !entry || cache.has(key)) return;
        let cancelled = false;
        provider
            .readFile(entry)
            .then(blob => blob.arrayBuffer())
            .then(bytes => {
                if (cancelled) return;
                // Documents are megabytes each; keep only a handful.
                if (cache.size > 6) cache.clear();
                cache.set(key, bytes);
                setLoaded({ key, state: { status: 'ready', bytes } });
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setLoaded({
                    key,
                    state: { status: 'error', message: e instanceof Error ? e.message : String(e) },
                });
            });
        return () => {
            cancelled = true;
        };
    }, [provider, entry, key]);

    if (!provider || !entry) return { status: 'error', message: 'That file is no longer available.' };
    const cached = cache.get(key);
    if (cached) return { status: 'ready', bytes: cached };
    if (loaded?.key === key) return loaded.state;
    return LOADING;
}

/** Drop a file from the cache — after it is overwritten or deleted. */
export function forgetFileBytes(key: string): void {
    cache.delete(key);
}
