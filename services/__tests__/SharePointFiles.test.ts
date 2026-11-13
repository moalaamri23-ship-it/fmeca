import { describe, it, expect, vi } from 'vitest';
import {
    SharePointFiles, SpError, SpTransport, joinSpPath, rootFor, spBaseName, spParent, toSpFileName,
    describeSpError, SP_MAX_BATCH_FILES, mapLimit, flowTransport, SP_CALL_TIMEOUT_MS,
} from '../SharePointFiles';
import { MemorySpCache } from '../SharePointCache';

const SITE = 'https://x.sharepoint.com/sites/A';
const ROOT = '/sites/A/Shared Documents';

/** A transport that records calls and answers from a script. */
function scripted(answer: (body: any, n: number) => { status: number; body: unknown }) {
    const calls: any[] = [];
    /** The router task each call went to; undefined is the default route. */
    const tasks: Array<string | undefined> = [];
    const transport: SpTransport = async (body, task) => {
        calls.push(body);
        tasks.push(task);
        const r = answer({ ...body, task }, calls.length);
        return { status: r.status, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    };
    return { calls, tasks, transport };
}

const listing = (path: string) => ({ path, folders: [], files: [] });

describe('SharePoint paths', () => {
    it('joins, splits and finds the root', () => {
        expect(joinSpPath(ROOT + '/', 'a', '/b/')).toBe(ROOT + '/a/b');
        expect(spParent(ROOT + '/a/b')).toBe(ROOT + '/a');
        expect(spBaseName(ROOT + '/a/b/')).toBe('b');
        const site = { site: SITE, title: 'A', roots: [{ path: ROOT, title: 'Documents' }] };
        expect(rootFor(site, ROOT)?.path).toBe(ROOT);
        expect(rootFor(site, (ROOT + '/X').toLowerCase())?.path).toBe(ROOT);
        expect(rootFor(site, '/sites/A/Shared Documents2')).toBeUndefined();
        expect(rootFor(site, '/sites/A/SiteAssets')).toBeUndefined();
    });

    it('makes file names the flow accepts', () => {
        expect(toSpFileName('50% done.pdf')).toBe('50pct done.pdf');
        expect(toSpFileName('a/b\\c.txt')).toBe('a-b-c.txt');
        expect(toSpFileName("it's #1 & (x).txt")).toBe("it's #1 & (x).txt");
        expect(toSpFileName('  ..  ')).toBe('file');
    });
});

describe('SharePointFiles client', () => {
    it('sends the op and site, caches a listing, and patches it after a write instead of listing again', async () => {
        const { calls, transport } = scripted(b => b.op === 'list'
            ? { status: 200, body: listing(b.path) }
            : { status: 200, body: { path: b.path + '/' + b.name, size: 1, etag: 'e1' } });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT + '/');          // same folder, trailing slash
        expect(calls.filter(c => c.op === 'list')).toHaveLength(1);
        expect(calls[0]).toEqual({ op: 'list', site: SITE, path: ROOT });

        await sp.write(SITE, ROOT, '50%.txt', btoa('x'));
        expect(calls[1]).toMatchObject({ op: 'write', path: ROOT, name: '50pct.txt', overwrite: false });
        const after = await sp.list(SITE, ROOT);
        expect(calls.filter(c => c.op === 'list')).toHaveLength(1);
        expect(after.files.map(f => [f.name, f.etag])).toEqual([['50pct.txt', 'e1']]);

        // Writing the same name again replaces the row, it does not add one.
        await sp.write(SITE, ROOT, '50%.txt', btoa('y'), { overwrite: true });
        expect((await sp.list(SITE, ROOT)).files).toHaveLength(1);
    });

    it('drops a deleted file from the cached listing without listing again', async () => {
        const { calls, transport } = scripted(b => b.op === 'list'
            ? { status: 200, body: { path: b.path, folders: [], files: [
                { name: 'a.txt', path: b.path + '/a.txt', size: 1, modified: '', etag: 'e' },
                { name: 'b.txt', path: b.path + '/b.txt', size: 1, modified: '', etag: 'e' },
            ] } }
            : { status: 200, body: { path: b.path, recycled: true } });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.remove(SITE, ROOT + '/a.txt');
        expect((await sp.list(SITE, ROOT)).files.map(f => f.name)).toEqual(['b.txt']);
        expect(calls.filter(c => c.op === 'list')).toHaveLength(1);
    });

    it('skips mkdir for a folder it has seen exist, and asks again after a 404', async () => {
        let missing = false;
        const { calls, transport } = scripted(b => b.op === 'list'
            ? (missing ? { status: 404, body: { error: 'not_found', message: 'gone' } } : { status: 200, body: listing(b.path) })
            : { status: 200, body: { path: b.path, created: false } });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT + '/a');
        expect(await sp.mkdir(SITE, ROOT + '/a')).toEqual({ path: ROOT + '/a', created: false });
        expect(calls.filter(c => c.op === 'mkdir')).toHaveLength(0);

        missing = true;
        await sp.list(SITE, ROOT + '/a', { fresh: true }).catch(() => {});
        await sp.mkdir(SITE, ROOT + '/a');
        expect(calls.filter(c => c.op === 'mkdir')).toHaveLength(1);
    });

    it('keeps listings for the next page load and serves them before any call', async () => {
        const store = new MemorySpCache();
        const first = scripted(b => ({ status: 200, body: { path: b.path, folders: [], files: [
            { name: 'a.txt', path: b.path + '/a.txt', size: 1, modified: '', etag: 'e' }] } }));
        await new SharePointFiles(first.transport, store).list(SITE, ROOT);
        await Promise.resolve();

        const later = scripted(() => ({ status: 500, body: 'down' }));
        const sp = new SharePointFiles(later.transport, store);
        expect((await sp.cachedList(SITE, ROOT + '/'))?.files.map(f => f.name)).toEqual(['a.txt']);
        expect(later.calls).toHaveLength(0);
        expect(await sp.cachedList(SITE, ROOT + '/never')).toBeNull();
    });

    it('reads a file from the store while its etag matches, and through the flow when it changed', async () => {
        const { calls, transport } = scripted(b => ({ status: 200, body: {
            name: 'a.txt', path: b.path, size: 2, contentType: 'application/octet-stream', etag: 'e2', contentBase64: btoa('v2') } }));
        const sp = new SharePointFiles(transport, new MemorySpCache());
        // Uploaded bytes are stored under the etag the write returned.
        const up = scripted(b => ({ status: 200, body: { path: b.path + '/' + b.name, size: 2, etag: 'e1' } }));
        const store = new MemorySpCache();
        const writer = new SharePointFiles(up.transport, store);
        await writer.write(SITE, ROOT, 'a.txt', new Blob(['v1']));
        await new Promise(r => setTimeout(r, 0));
        expect(await (await writer.readBlob(SITE, ROOT + '/a.txt', 'e1')).text()).toBe('v1');
        expect(up.calls.filter(c => c.op === 'fetch')).toHaveLength(0);

        expect(await (await sp.readBlob(SITE, ROOT + '/a.txt', 'e2')).text()).toBe('v2');
        await new Promise(r => setTimeout(r, 0));
        expect(await (await sp.readBlob(SITE, ROOT + '/a.txt', 'e2')).text()).toBe('v2');
        expect(calls).toHaveLength(1);
        await sp.readBlob(SITE, ROOT + '/a.txt', 'e3');
        expect(calls).toHaveLength(2);
    });

    it('mapLimit keeps order and never runs more than the limit at once', async () => {
        let live = 0, peak = 0;
        const out = await mapLimit([5, 1, 4, 2, 3], 2, async n => {
            live++; peak = Math.max(peak, live);
            await new Promise(r => setTimeout(r, n));
            live--;
            return n * 10;
        });
        expect(out).toEqual([50, 10, 40, 20, 30]);
        expect(peak).toBe(2);
    });

    it('fresh skips the cache', async () => {
        const { calls, transport } = scripted(b => ({ status: 200, body: listing(b.path) }));
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT, { fresh: true });
        expect(calls).toHaveLength(2);
    });

    it('mkdir puts the new folders into the cached listings instead of listing again', async () => {
        const { calls, transport } = scripted(b => b.op === 'list'
            ? { status: 200, body: listing(b.path) }
            : { status: 200, body: { path: b.path, created: true } });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT + '/a');
        await sp.mkdir(SITE, ROOT + '/a/b/c');
        // Each new level is in its parent's listing, and the new leaf is known to be empty.
        expect((await sp.list(SITE, ROOT + '/a')).folders.map(f => f.name)).toEqual(['b']);
        expect((await sp.list(SITE, ROOT + '/a/b/c'))).toEqual({ path: ROOT + '/a/b/c', folders: [], files: [] });
        // The root did not change: /a was already there.
        expect((await sp.list(SITE, ROOT)).folders).toEqual([]);
        expect(calls.filter(c => c.op === 'list')).toHaveLength(2);
        // /a/b was created too but never listed: nothing is assumed about it.
        await sp.list(SITE, ROOT + '/a/b');
        expect(calls.filter(c => c.op === 'list')).toHaveLength(3);

        // A folder that already existed changes no listing.
        const there = scripted(b => b.op === 'list'
            ? { status: 200, body: listing(b.path) } : { status: 200, body: { path: b.path, created: false } });
        const sp2 = new SharePointFiles(there.transport);
        await sp2.list(SITE, ROOT);
        await sp2.mkdir(SITE, ROOT + '/x');
        expect((await sp2.list(SITE, ROOT)).folders).toEqual([]);
        await sp2.list(SITE, ROOT + '/x');
        expect(there.calls.filter(c => c.op === 'list')).toHaveLength(2);
    });

    it('gives up on a call the network never answers, and sends an overwrite once more', async () => {
        vi.useFakeTimers();
        let n = 0;
        vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => {
            n++;
            if (n === 1) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
            return Promise.resolve({ status: 200, text: async () => JSON.stringify({ path: ROOT + '/a.txt', size: 1, etag: 'e' }) });
        });
        try {
            const sp = new SharePointFiles(flowTransport('https://flow.example/x'));
            const writing = sp.write(SITE, ROOT, 'a.txt', btoa('x'), { overwrite: true });
            await vi.advanceTimersByTimeAsync(SP_CALL_TIMEOUT_MS + 10);
            // The first call was dropped after the limit; the overwrite went out again and landed.
            expect((await writing).etag).toBe('e');
            expect(n).toBeGreaterThanOrEqual(2);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });

    it('turns flow errors into SpError with the contract code', async () => {
        const { transport } = scripted(() => ({ status: 409, body: { error: 'exists', message: 'File exists.' } }));
        const sp = new SharePointFiles(transport);
        const err = await sp.write(SITE, ROOT, 'a.txt', btoa('x')).catch(e => e);
        expect(err).toBeInstanceOf(SpError);
        expect(err.code).toBe('exists');
        expect(err.status).toBe(409);
        expect(describeSpError(err)).toMatch(/already exists/);
    });

    it('retries a read once after the router reports a child timeout, never a write', async () => {
        const timeout = { status: 502, body: { error: "Child flow 'sp_files' failed or timed out.", runId: 'r1' } };
        const read = scripted((_, n) => n === 1 ? timeout : { status: 200, body: listing(ROOT) });
        await new SharePointFiles(read.transport).list(SITE, ROOT);
        expect(read.calls).toHaveLength(2);

        const write = scripted(() => timeout);
        const err = await new SharePointFiles(write.transport).write(SITE, ROOT, 'a.txt', btoa('x')).catch(e => e);
        expect(err.code).toBe('flow_failed');
        expect(write.calls).toHaveLength(1);
    });

    it('asks the child flow when the inline route fails, and stays on it', async () => {
        const failed = { status: 502, body: { error: { code: 'NoResponse', message: 'The flow run ended without a response.' } } };
        const { calls, tasks, transport } = scripted(b => b.task === 'sp_files_child'
            ? (b.op === 'write' ? { status: 200, body: { path: b.path + '/' + b.name, size: 1, etag: 'e' } } : { status: 200, body: listing(b.path) })
            : failed);
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        expect(tasks).toEqual([undefined, 'sp_files_child']);
        await sp.list(SITE, ROOT + '/a');
        expect(tasks).toEqual([undefined, 'sp_files_child', 'sp_files_child']);
        // An overwrite is safe to send again; a first-time write is not.
        await sp.write(SITE, ROOT, 'a.txt', btoa('x'), { overwrite: true });
        expect(calls.filter(c => c.op === 'write')).toHaveLength(1);
    });

    it('sends a failed overwrite again through the child, but not a write that must not replace', async () => {
        const failed = { status: 502, body: 'Bad gateway' };
        const { calls, transport } = scripted(b => b.task === 'sp_files_child'
            ? { status: 200, body: { path: b.path + '/' + b.name, size: 1, etag: 'e' } } : failed);
        await new SharePointFiles(transport).write(SITE, ROOT, 'a.txt', btoa('x'), { overwrite: true });
        expect(calls).toHaveLength(2);

        const strict = scripted(() => failed);
        const err = await new SharePointFiles(strict.transport).write(SITE, ROOT, 'a.txt', btoa('x')).catch(e => e);
        expect(err.code).toBe('flow_failed');
        expect(strict.calls).toHaveLength(1);
    });

    it('falls back to the plain retry on a router that has no child task', async () => {
        const { tasks, transport } = scripted((b, n) => {
            if (b.task === 'sp_files_child') return { status: 400, body: { error: 'Unknown task: sp_files_child', tasks: ['chat', 'sp_files'] } };
            return n === 1 ? { status: 502, body: { error: "Child flow 'sp_files' failed or timed out.", runId: 'r' } }
                : { status: 200, body: listing(b.path) };
        });
        const sp = new SharePointFiles(transport);
        expect((await sp.list(SITE, ROOT)).path).toBe(ROOT);
        expect(tasks).toEqual([undefined, 'sp_files_child', undefined]);
    });

    it('warm lists a subtree in one call and serves every folder in it from the cache', async () => {
        const file = (p: string, n: string) => ({ Name: n, ServerRelativeUrl: p + '/' + n, Length: '7', TimeLastModified: '2026-11-01T00:00:00Z', ETag: '"e"' });
        const { calls, transport } = scripted(b => b.op === 'tree' ? { status: 200, body: { path: ROOT, depth: 2, tree: {
            Exists: true,
            Files: [file(ROOT, 'top.txt')],
            Folders: [
                { Name: 'Forms', ServerRelativeUrl: ROOT + '/Forms', ItemCount: 0, Folders: [], Files: [] },
                { Name: 'A', ServerRelativeUrl: ROOT + '/A', ItemCount: 2, Files: [file(ROOT + '/A', 'a.txt')], Folders: [
                    // The last level: no children in the reply, so not a listing.
                    { Name: 'Deep', ServerRelativeUrl: ROOT + '/A/Deep', ItemCount: 3 },
                ] },
                { Name: 'Empty', ServerRelativeUrl: ROOT + '/Empty', ItemCount: 0, Files: [], Folders: [] },
            ],
        } } } : { status: 200, body: listing(b.path) });
        const sp = new SharePointFiles(transport);
        expect(await sp.warm(SITE, ROOT, 2)).toBe(true);
        expect(calls[0]).toEqual({ op: 'tree', site: SITE, path: ROOT, depth: 2 });

        const root = await sp.list(SITE, ROOT);
        expect(root.folders.map(f => f.name)).toEqual(['A', 'Empty']);   // Forms hidden at a library root
        expect(root.files[0]).toEqual({ name: 'top.txt', path: ROOT + '/top.txt', size: 7, modified: '2026-11-01T00:00:00Z', etag: '"e"' });
        expect((await sp.list(SITE, ROOT + '/A')).files.map(f => f.name)).toEqual(['a.txt']);
        expect((await sp.list(SITE, ROOT + '/Empty')).files).toEqual([]);
        expect(calls).toHaveLength(1);
        // Seen to exist, so no mkdir call either.
        await sp.mkdir(SITE, ROOT + '/A/Deep');
        expect(calls).toHaveLength(1);
        // Below the tree's depth nothing is cached: that folder is listed for real.
        await sp.list(SITE, ROOT + '/A/Deep');
        expect(calls.map(c => c.op)).toEqual(['tree', 'list']);
        // Warming again within the minute is free.
        await sp.warm(SITE, ROOT, 2);
        expect(calls).toHaveLength(2);
    });

    it('warm gives up for good on a flow without the tree op, and lists as before', async () => {
        const { calls, transport } = scripted(b => b.op === 'tree'
            ? { status: 400, body: { error: 'bad_request', message: 'Unknown op: tree.' } }
            : { status: 200, body: listing(b.path) });
        const sp = new SharePointFiles(transport);
        expect(await sp.warm(SITE, ROOT, 3)).toBe(false);
        expect(await sp.warm(SITE, ROOT + '/x', 3)).toBe(false);
        expect(calls.filter(c => c.op === 'tree')).toHaveLength(1);
        expect((await sp.list(SITE, ROOT)).path).toBe(ROOT);
    });

    it('keeps the modified time a newer flow returns, and leaves it empty for an older one', async () => {
        const answer = (modified?: string) => scripted(b => b.op === 'list'
            ? { status: 200, body: listing(b.path) }
            : { status: 200, body: { path: b.path + '/' + b.name, size: 1, etag: 'e', ...(modified ? { modified } : {}) } });
        const newer = new SharePointFiles(answer('2026-11-12T10:00:00Z').transport);
        await newer.list(SITE, ROOT);
        await newer.write(SITE, ROOT, 'a.txt', btoa('x'));
        expect((await newer.list(SITE, ROOT)).files[0].modified).toBe('2026-11-12T10:00:00Z');

        const older = new SharePointFiles(answer().transport);
        await older.list(SITE, ROOT);
        await older.write(SITE, ROOT, 'a.txt', btoa('x'));
        expect((await older.list(SITE, ROOT)).files[0].modified).toBe('');
    });

    it('makes the folder and writes again when a folder it believed in is gone', async () => {
        let folder = true;
        const { calls, transport } = scripted(b => {
            if (b.op === 'list') return { status: 200, body: listing(b.path) };
            if (b.op === 'mkdir') { folder = true; return { status: 200, body: { path: b.path, created: true } }; }
            return folder ? { status: 200, body: { path: b.path + '/' + b.name, size: 1, etag: 'e' } }
                : { status: 404, body: { error: 'not_found', message: 'No folder' } };
        });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT + '/a');
        folder = false;                      // removed in SharePoint behind the app's back
        await sp.write(SITE, ROOT + '/a', 'x.txt', btoa('x'), { overwrite: true });
        expect(calls.map(c => c.op)).toEqual(['list', 'write', 'mkdir', 'write']);
        // A folder never seen is not created behind the caller's back.
        folder = false;
        const err = await new SharePointFiles(transport).write(SITE, ROOT + '/b', 'x.txt', btoa('x')).catch(e => e);
        expect(err.code).toBe('not_found');
    });

    it('asks a slow listing a second time and takes the first answer', async () => {
        let n = 0;
        const transport: SpTransport = async body => {
            const mine = ++n;
            await new Promise(r => setTimeout(r, mine === 1 ? 60 : 1));
            return { status: 200, text: JSON.stringify({ ...listing(String(body.path)), files: [{ name: 'by' + mine, path: 'p', size: 0, modified: '', etag: '' }] }) };
        };
        const sp = new SharePointFiles(transport, new MemorySpCache(), { hedgeMs: 10 });
        expect((await sp.list(SITE, ROOT)).files[0].name).toBe('by2');
        expect(n).toBe(2);
        // A quick answer never costs a second call.
        const quick = scripted(b => ({ status: 200, body: listing(b.path) }));
        await new SharePointFiles(quick.transport, new MemorySpCache(), { hedgeMs: 50 }).list(SITE, ROOT);
        await new Promise(r => setTimeout(r, 70));
        expect(quick.calls).toHaveLength(1);
    });

    it('answers sites from the store on the next page load and refreshes behind', async () => {
        const store = new MemorySpCache();
        const first = scripted(() => ({ status: 200, body: { sites: [{ site: SITE, title: 'A', roots: [] }] } }));
        await new SharePointFiles(first.transport, store).sites();
        await new Promise(r => setTimeout(r, 0));

        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const transport: SpTransport = async () => { await gate; return { status: 200, text: JSON.stringify({ sites: [{ site: SITE, title: 'B', roots: [] }] }) }; };
        const sp = new SharePointFiles(transport, store);
        expect((await sp.sites())[0].title).toBe('A');     // before the flow has answered
        release();
        await new Promise(r => setTimeout(r, 0));
        expect((await sp.sites())[0].title).toBe('B');
    });

    it('shares one call between two readers of the same file', async () => {
        const { calls, transport } = scripted(b => ({ status: 200, body: {
            name: 'a.txt', path: b.path, size: 1, contentType: 'x', etag: 'e', contentBase64: btoa('v') } }));
        const sp = new SharePointFiles(transport);
        const [a, b] = await Promise.all([sp.readBlob(SITE, ROOT + '/a.txt', 'e'), sp.readBlob(SITE, ROOT + '/a.txt', 'e')]);
        expect(await a.text()).toBe('v');
        expect(b).toBe(a);
        expect(calls).toHaveLength(1);
    });

    it('refuses a file over the cap before sending it', async () => {
        const { calls, transport } = scripted(() => ({ status: 200, body: {} }));
        const big = new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]);
        const err = await new SharePointFiles(transport).write(SITE, ROOT, 'big.bin', big).catch(e => e);
        expect(err.code).toBe('too_large');
        expect(calls).toHaveLength(0);
    });

    it('fetchMany batches, re-asks for files the flow deferred, and keeps the order', async () => {
        const paths = Array.from({ length: SP_MAX_BATCH_FILES + 3 }, (_, i) => `${ROOT}/f${i}.txt`);
        const deferredOnce = new Set([paths[2]]);
        const { calls, transport } = scripted(b => ({
            status: 200,
            body: {
                files: (b.paths as string[]).map(p => {
                    if (deferredOnce.has(p)) { deferredOnce.delete(p); return { path: p, error: 'too_large_for_batch' }; }
                    if (p.endsWith('f5.txt')) return { path: p, error: 'not_found' };
                    return { name: spBaseName(p), path: p, size: 1, contentType: 'x', etag: 'e', contentBase64: 'eA==' };
                }),
            },
        }));
        const out = await new SharePointFiles(transport).fetchMany(SITE, paths);
        expect(calls.every(c => c.paths.length <= SP_MAX_BATCH_FILES)).toBe(true);
        expect(out.map(f => f.path)).toEqual(paths);
        expect(out[2]).toHaveProperty('contentBase64');
        expect(out[5]).toEqual({ path: paths[5], error: 'not_found' });
    });
});
