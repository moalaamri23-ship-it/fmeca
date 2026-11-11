import { describe, it, expect } from 'vitest';
import {
    SharePointFiles, SpError, SpTransport, joinSpPath, rootFor, spBaseName, spParent, toSpFileName,
    describeSpError, SP_MAX_BATCH_FILES,
} from '../SharePointFiles';

const SITE = 'https://x.sharepoint.com/sites/A';
const ROOT = '/sites/A/Shared Documents';

/** A transport that records calls and answers from a script. */
function scripted(answer: (body: any, n: number) => { status: number; body: unknown }) {
    const calls: any[] = [];
    const transport: SpTransport = async body => {
        calls.push(body);
        const r = answer(body, calls.length);
        return { status: r.status, text: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
    };
    return { calls, transport };
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
    it('sends the op and site, and caches a listing until a write in that folder', async () => {
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
        await sp.list(SITE, ROOT);
        expect(calls.filter(c => c.op === 'list')).toHaveLength(2);
    });

    it('fresh skips the cache', async () => {
        const { calls, transport } = scripted(b => ({ status: 200, body: listing(b.path) }));
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT, { fresh: true });
        expect(calls).toHaveLength(2);
    });

    it('mkdir invalidates every parent listing', async () => {
        const { calls, transport } = scripted(b => b.op === 'list'
            ? { status: 200, body: listing(b.path) }
            : { status: 200, body: { path: b.path, created: true } });
        const sp = new SharePointFiles(transport);
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT + '/a');
        await sp.mkdir(SITE, ROOT + '/a/b/c');
        await sp.list(SITE, ROOT);
        await sp.list(SITE, ROOT + '/a');
        expect(calls.filter(c => c.op === 'list')).toHaveLength(4);
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
