import { describe, it, expect } from 'vitest';
import { SharePointFiles, SpLocation, SpTransport } from '../SharePointFiles';
import { SharePointStorageProvider } from '../SharePointStorage';
import { isCancellation } from '../FileSystem';

const SITE = 'https://x.sharepoint.com/sites/A';
const ROOT = '/sites/A/Shared Documents/Pump study';

function provider(answer: (b: any) => { status: number; body: unknown }, root: SpLocation | null = { site: SITE, path: ROOT }) {
    const calls: any[] = [];
    const transport: SpTransport = async b => { calls.push(b); const r = answer(b); return { status: r.status, text: JSON.stringify(r.body) }; };
    let stored = root;
    const p = new SharePointStorageProvider({
        client: new SharePointFiles(transport),
        getRoot: () => stored,
        setRoot: (_id, r) => { stored = r; },
        pickFolder: async () => ({ site: SITE, path: ROOT + '/picked' }),
    });
    return { p, calls, root: () => stored };
}

describe('SharePointStorageProvider', () => {
    it('lists the entity folder under the project root, named like local folders', async () => {
        const { p, calls } = provider(b => ({ status: 200, body: { path: b.path, folders: [], files: [
            { name: 'b.pdf', path: b.path + '/b.pdf', size: 3, modified: '', etag: 'e' },
            { name: '.hidden', path: b.path + '/.hidden', size: 1, modified: '', etag: 'e' },
            { name: 'a.txt', path: b.path + '/a.txt', size: 3, modified: '', etag: 'e' },
        ] } }));
        const files = await p.listFiles('p1', ['Subsystems', 'Seal / Gland']);
        expect(calls[0]).toMatchObject({ op: 'list', site: SITE, path: ROOT + '/Subsystems/Seal _ Gland' });
        expect(files.map(f => f.name)).toEqual(['a.txt', 'b.pdf']);
    });

    it('treats a folder not created yet as empty, and an unlinked project as empty', async () => {
        const missing = provider(() => ({ status: 404, body: { error: 'not_found', message: 'No folder' } }));
        expect(await missing.p.listFiles('p1', ['Subsystems', 'X'])).toEqual([]);
        const unlinked = provider(() => ({ status: 200, body: {} }), null);
        expect(await unlinked.p.listFiles('p1', ['Subsystems'])).toEqual([]);
        expect(unlinked.calls).toHaveLength(0);
        expect(await unlinked.p.hasRoot('p1')).toBe(false);
    });

    it('uploads into the entity folder, creating it, replacing same-named files', async () => {
        const { p, calls } = provider(b => ({ status: 200, body: b.op === 'mkdir' ? { path: b.path, created: true } : { path: b.path + '/' + b.name, size: 1, etag: 'e' } }));
        const n = await p.writeChosenFiles('p1', ['Subsystems', 'Pump'], [new File(['x'], 'spec 10%.pdf')]);
        expect(n).toBe(1);
        expect(calls[0]).toMatchObject({ op: 'mkdir', path: ROOT + '/Subsystems/Pump' });
        expect(calls[1]).toMatchObject({ op: 'write', path: ROOT + '/Subsystems/Pump', name: 'spec 10pct.pdf', overwrite: true });
    });

    it('uploads several files at once, after one mkdir, and skips mkdir once the folder was listed', async () => {
        let live = 0, peak = 0;
        const calls: any[] = [];
        const transport: SpTransport = async b => {
            calls.push(b);
            if (b.op === 'list') return { status: 200, text: JSON.stringify({ path: b.path, folders: [], files: [] }) };
            if (b.op === 'mkdir') return { status: 200, text: JSON.stringify({ path: b.path, created: false }) };
            live++; peak = Math.max(peak, live);
            await new Promise(r => setTimeout(r, 5));
            live--;
            return { status: 200, text: JSON.stringify({ path: b.path + '/' + b.name, size: 1, etag: 'e' }) };
        };
        const p = new SharePointStorageProvider({
            client: new SharePointFiles(transport),
            getRoot: () => ({ site: SITE, path: ROOT }), setRoot: () => {}, pickFolder: async () => null,
        });
        await p.listFiles('p1', ['Pump']);
        const files = ['a', 'b', 'c', 'd'].map(n => new File(['x'], n + '.txt'));
        expect(await p.writeChosenFiles('p1', ['Pump'], files)).toBe(4);
        expect(calls.filter(c => c.op === 'mkdir')).toHaveLength(0);
        expect(peak).toBe(3);
        // The panel's reload after the upload is served from the patched listing.
        expect((await p.listFiles('p1', ['Pump'])).map(f => f.name)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
        expect(calls.filter(c => c.op === 'list')).toHaveLength(1);
        expect((await p.cachedFiles('p1', ['Pump']))?.length).toBe(4);
        expect(await p.cachedFiles('p1', ['Other'])).toBeNull();
    });

    it('reads a listed file through fetch, typed by name', async () => {
        const { p } = provider(b => b.op === 'list'
            ? { status: 200, body: { path: b.path, folders: [], files: [{ name: 'a.txt', path: b.path + '/a.txt', size: 2, modified: '', etag: 'e' }] } }
            : { status: 200, body: { name: 'a.txt', path: b.path, size: 2, contentType: 'application/octet-stream', etag: 'e', contentBase64: btoa('hi') } });
        const [entry] = await p.listFiles('p1', []);
        const blob = await p.readFile(entry);
        expect(await blob.text()).toBe('hi');
        expect(blob.type).toBe('text/plain');
    });

    it('ignores deleting a file that is already gone, and words other errors plainly', async () => {
        const gone = provider(() => ({ status: 404, body: { error: 'not_found', message: 'x' } }));
        await expect(gone.p.deleteFile('p1', ['S'], 'a.txt')).resolves.toBeUndefined();
        const denied = provider(() => ({ status: 403, body: { error: 'not_allowed', message: '{"odata.error":...}' } }));
        await expect(denied.p.deleteFile('p1', ['S'], 'a.txt')).rejects.toThrow('You do not have access to this SharePoint location.');
    });

    it('chooseRoot stores the picked folder; cancelling is a cancellation', async () => {
        const { p, root } = provider(() => ({ status: 200, body: {} }), null);
        await p.chooseRoot('p1');
        expect(root()).toEqual({ site: SITE, path: ROOT + '/picked' });

        const cancelled = new SharePointStorageProvider({
            client: new SharePointFiles(async () => ({ status: 200, text: '{}' })),
            getRoot: () => null, setRoot: () => {}, pickFolder: async () => null,
        });
        const err = await cancelled.chooseRoot('p1').catch(e => e);
        expect(isCancellation(err)).toBe(true);
    });
});
