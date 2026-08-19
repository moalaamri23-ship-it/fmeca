// Popup-backed File System Access, for when FMECA Studio runs inside a frame.
//
// A cross-origin frame may not call showDirectoryPicker at all, and Chromium
// refuses every write through a handle it is given — getDirectoryHandle with
// create, createWritable, removeEntry — because the frame is a third-party
// context. Reads through that same handle are allowed. So picking and writing
// both run in a small top-level window of the app's own origin, and reading
// stays here.
//
// Modelled on the same approach used by FileLM's collections folder.

export interface WritableLike {
    write(data: BufferSource | Blob | string): Promise<void>;
    close(): Promise<void>;
}

export interface FileHandleLike {
    kind: 'file';
    name: string;
    getFile(): Promise<File>;
    createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

export interface DirHandleLike {
    kind: 'directory';
    name: string;
    entries(): AsyncIterableIterator<[string, DirHandleLike | FileHandleLike]>;
    getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
    getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
    queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    /**
     * Only on bridge proxies: write files the frame already chose.
     *
     * A File survives postMessage as a reference to the same bytes, so handing
     * the selection to the helper costs nothing and keeps the frame's own picker
     * — the one the user reached in a single click — in the flow.
     */
    writeFiles?(pathParts: string[], files: File[]): Promise<{ written: number }>;
    /** Only on bridge proxies: say what the helper window is currently waiting on. */
    setStatus?(text: string): Promise<void>;
}

interface PickerWindow {
    showDirectoryPicker?: (options?: {
        id?: string;
        mode?: 'read' | 'readwrite';
        startIn?: string;
    }) => Promise<DirHandleLike>;
}

export const FSA_SUPPORTED =
    typeof window !== 'undefined' && typeof (window as unknown as PickerWindow).showDirectoryPicker === 'function';

/**
 * Whether the app is running inside a frame.
 *
 * Comparing the two window proxies is allowed across origins; reading anything
 * off `top` would not be.
 */
export const IN_IFRAME = typeof window !== 'undefined' && window.self !== window.top;

/**
 * The name every helper window is opened under, and the tag on every message it
 * exchanges. Exported so the app can recognise a window meant for the helper —
 * see the guard in index.tsx.
 */
export const CHANNEL = 'fmeca-folder-picker';
const PICKER_PAGE = '/folder-picker.html';

type BridgeHandle =
    | { kind: 'directory'; name: string; handleId: string }
    | { kind: 'file'; name: string; handleId: string };

export interface WritableRootBridge {
    root: DirHandleLike;
    close(): void;
}

/** Ask the helper window to find the folder before it starts serving writes. */
export const PICK_IN_BRIDGE = 'pick' as const;

function popupBlockedError(): Error {
    return new Error(
        'FMECA Studio is embedded in another page, so it opens a small window to reach the project folder — and that window was blocked. Allow pop-ups for this site and try again.'
    );
}

/**
 * Run the folder picker in a window of our own origin and take the handle back.
 *
 * Directory handles survive postMessage, so the capability comes back over a
 * channel the embedder cannot read: the helper posts only to its opener, and
 * only with our own origin as the target.
 */
function pickViaPopup(projectId: string): Promise<DirHandleLike | null> {
    const popup = window.open(
        `${PICKER_PAGE}?project=${encodeURIComponent(projectId)}`,
        CHANNEL,
        'popup=yes,width=480,height=360,left=200,top=180'
    );
    if (!popup) throw popupBlockedError();

    return new Promise<DirHandleLike | null>((resolve, reject) => {
        let settled = false;

        const finish = (run: () => void) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMessage);
            window.clearInterval(closedTimer);
            run();
        };

        const onMessage = (event: MessageEvent) => {
            // Three checks, because what arrives is a filesystem capability: the
            // right origin, the window we actually opened, and our own channel.
            if (event.origin !== window.location.origin) return;
            if (event.source !== popup) return;
            const data = event.data as any;
            if (!data || data.source !== CHANNEL) return;

            if (data.ok && data.handle) { finish(() => resolve(data.handle as DirHandleLike)); return; }
            if (data.name === 'AbortError') { finish(() => resolve(null)); return; }
            finish(() =>
                reject(Object.assign(new Error(data.message ?? 'The folder picker failed.'), {
                    name: data.name ?? 'Error',
                }))
            );
        };

        // A window closed by hand sends its farewell on beforeunload, but a window
        // that never got that far still has to stop the app waiting.
        const closedTimer = window.setInterval(() => {
            if (popup.closed) finish(() => resolve(null));
        }, 400);

        window.addEventListener('message', onMessage);
    });
}

/**
 * Keep filesystem mutations in a same-origin top-level window.
 *
 * The frame hands its selected root to the helper, which performs the writes on
 * the frame's behalf. Returned handles are opaque proxies, so every nested call
 * stays in the allowed top-level context too.
 *
 * Call this directly from the click that starts the write: opening a popup after
 * an await would lose transient user activation and be blocked. The root itself
 * may still be on its way — the window is opened first and told which folder it
 * is for once the handle arrives, so a click need not wait on IndexedDB.
 */
export function openWritableRootBridge(
    rootHandle: DirHandleLike | Promise<DirHandleLike> | typeof PICK_IN_BRIDGE,
    projectId: string,
    onLost?: () => void,
    onPicked?: (handle: DirHandleLike) => void
): Promise<WritableRootBridge> {
    const session =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const picking = rootHandle === PICK_IN_BRIDGE;
    const popup = window.open(
        `${PICKER_PAGE}?mode=bridge${picking ? '&pick=1' : ''}&session=${encodeURIComponent(session)}&project=${encodeURIComponent(projectId)}`,
        // Named per session: a window still closing after one operation must not
        // be reused — and then closed out from under — by the next.
        `${CHANNEL}-writer-${session}`,
        'popup=yes,width=480,height=360,left=200,top=180'
    );
    if (!popup) throw popupBlockedError();

    return new Promise<WritableRootBridge>((resolve, reject) => {
        let ready = false;
        let closed = false;
        let nextRequest = 0;
        const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

        const errorFrom = (data: { name?: string; message?: string }) =>
            Object.assign(new Error(data.message ?? 'The folder helper failed.'), { name: data.name ?? 'Error' });

        const cleanup = (reason?: Error) => {
            if (closed) return;
            closed = true;
            window.removeEventListener('message', onMessage);
            window.clearInterval(closedTimer);
            if (reason) for (const request of pending.values()) request.reject(reason);
            pending.clear();
            // A window the user closed leaves the app holding a channel to nowhere:
            // say so, so the next write opens a new one instead of using this.
            if (reason && onLost) onLost();
            try { if (!popup.closed) popup.close(); } catch {
                // A helper that navigated away may no longer be script-closeable. Its
                // filesystem session is already detached from this frame either way.
            }
        };

        const call = (op: string, handleId: string, args: unknown[] = []): Promise<unknown> => {
            if (closed || popup.closed) {
                return Promise.reject(new Error('The folder helper window was closed before saving finished.'));
            }
            const requestId = `${session}:${++nextRequest}`;
            return new Promise((resolveCall, rejectCall) => {
                pending.set(requestId, { resolve: resolveCall, reject: rejectCall });
                popup.postMessage(
                    { source: CHANNEL, bridge: true, session, type: 'request', requestId, op, handleId, args },
                    window.location.origin
                );
            });
        };

        const writableProxy = (handleId: string): WritableLike => ({
            async write(data) { await call('writable.write', handleId, [data]); },
            async close() { await call('writable.close', handleId); },
        });

        const fileProxy = (handle: Extract<BridgeHandle, { kind: 'file' }>): FileHandleLike => ({
            kind: 'file',
            name: handle.name,
            async getFile() { return (await call('file.getFile', handle.handleId)) as File; },
            async createWritable(options) {
                const result = (await call('file.createWritable', handle.handleId, [options])) as { handleId: string };
                return writableProxy(result.handleId);
            },
        });

        const directoryProxy = (handle: Extract<BridgeHandle, { kind: 'directory' }>): DirHandleLike => ({
            kind: 'directory',
            name: handle.name,
            async *entries() {
                const entries = (await call('directory.entries', handle.handleId)) as [string, BridgeHandle][];
                for (const [name, child] of entries) {
                    yield [name, child.kind === 'directory' ? directoryProxy(child) : fileProxy(child)];
                }
            },
            async getDirectoryHandle(name, options) {
                const child = (await call('directory.getDirectoryHandle', handle.handleId, [name, options])) as
                    Extract<BridgeHandle, { kind: 'directory' }>;
                return directoryProxy(child);
            },
            async getFileHandle(name, options) {
                const child = (await call('directory.getFileHandle', handle.handleId, [name, options])) as
                    Extract<BridgeHandle, { kind: 'file' }>;
                return fileProxy(child);
            },
            async removeEntry(name, options) { await call('directory.removeEntry', handle.handleId, [name, options]); },
            async writeFiles(pathParts, files) {
                return (await call('directory.writeFiles', handle.handleId, [pathParts, files])) as { written: number };
            },
            async setStatus(text) { await call('ui.status', handle.handleId, [text]); },
            async queryPermission(descriptor) {
                return (await call('handle.queryPermission', handle.handleId, [descriptor])) as PermissionState;
            },
            async requestPermission(descriptor) {
                return (await call('handle.requestPermission', handle.handleId, [descriptor])) as PermissionState;
            },
        });

        const onMessage = (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.source !== popup) return;
            const data = event.data as any;
            if (!data || data.source !== CHANNEL || data.bridge !== true || data.session !== session) return;

            if (data.type === 'ready' && data.handle?.kind === 'directory') {
                if (ready) return;
                ready = true;
                resolve({
                    root: directoryProxy(data.handle),
                    close() {
                        if (closed) return;
                        popup.postMessage(
                            { source: CHANNEL, bridge: true, session, type: 'close' },
                            window.location.origin
                        );
                        cleanup();
                    },
                });
                return;
            }

            // The window found the folder itself, and is about to serve writes
            // through it. The handle comes back so the app can read and store it.
            if (data.type === 'picked' && data.handle) {
                onPicked?.(data.handle as DirHandleLike);
                return;
            }

            if (data.type === 'connect') {
                if (picking) return;
                Promise.resolve(rootHandle as DirHandleLike | Promise<DirHandleLike>).then(
                    handle => {
                        if (closed) return;
                        popup.postMessage(
                            { source: CHANNEL, bridge: true, session, type: 'root', handle },
                            window.location.origin
                        );
                    },
                    (error: Error) => {
                        if (!ready) reject(error);
                        cleanup(error);
                    }
                );
                return;
            }

            if (data.type === 'response' && data.requestId) {
                const request = pending.get(data.requestId);
                if (!request) return;
                pending.delete(data.requestId);
                if (data.name || data.message) request.reject(errorFrom(data));
                else request.resolve(data.result);
                return;
            }

            if (data.type === 'error') {
                const error = errorFrom(data);
                if (!ready) reject(error);
                cleanup(error);
                return;
            }

            if (data.type === 'closed') {
                const error = new Error('The folder helper window was closed before saving finished.');
                if (!ready) reject(error);
                cleanup(error);
            }
        };

        const closedTimer = window.setInterval(() => {
            if (!popup.closed) return;
            const error = new Error('The folder helper window was closed before saving finished.');
            if (!ready) reject(error);
            cleanup(error);
        }, 400);

        window.addEventListener('message', onMessage);
    });
}

/** The user dismissed the picker. Every other failure is worth reporting. */
function isAbort(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

/** Say why the folder picker refused to open, rather than leaving a dead click. */
export function describePickerFailure(error: unknown): string {
    const name = error instanceof DOMException ? error.name : (error as any)?.name ?? '';
    const detail = error instanceof Error ? error.message : String(error);

    if (name === 'SecurityError') {
        if (IN_IFRAME) {
            return `FMECA Studio is embedded in another page and could not open the window it uses to reach the folder picker. Allow pop-ups for this site, then try again. (${detail})`;
        }
        return `Folder access was blocked by the browser or a device policy. On a managed computer an administrator may have disabled the File System Access API. (${detail})`;
    }
    if (name === 'NotAllowedError') return `Permission to open a folder was denied. (${detail})`;
    if (typeof window !== 'undefined' && !window.isSecureContext) {
        return 'Folder access needs a secure connection (https, or localhost).';
    }
    return `Could not open the folder picker. (${detail})`;
}

/**
 * Open the OS folder picker. Returns null when the user cancels, and throws for
 * anything else so the caller can say what went wrong.
 *
 * Must be called during a user gesture, and must be called ON `window`: the
 * method requires its receiver to be the Window, so invoking it through a
 * detached local throws "Illegal invocation".
 */
export async function pickRootDirectory(projectId: string): Promise<DirHandleLike | null> {
    const picker = window as unknown as PickerWindow;
    if (typeof picker.showDirectoryPicker !== 'function') {
        throw new Error('This browser cannot open a folder. Attachments need Chrome or Edge.');
    }
    // Embedded in another page: the picker is forbidden here, so it runs in a
    // window of our own origin and hands the folder back.
    if (IN_IFRAME) return pickViaPopup(projectId);
    try {
        return await picker.showDirectoryPicker({
            id: 'fmeca-project-folder',
            mode: 'readwrite',
            startIn: 'documents',
        });
    } catch (error) {
        if (isAbort(error)) return null;
        throw error;
    }
}

/** Whether the handle can be used right now, without prompting. */
export async function hasPermission(handle: DirHandleLike): Promise<boolean> {
    if (!handle.queryPermission) return true;
    try {
        return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
        return false;
    }
}

/**
 * Ask for access again. Chromium requires a user gesture for this, and refuses
 * outright inside a frame, which is why reconnecting is a button and never
 * something that happens on boot.
 */
export async function requestPermission(handle: DirHandleLike): Promise<boolean> {
    if (!handle.requestPermission) return true;
    try {
        return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
        return false;
    }
}
