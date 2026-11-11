/**
 * Live check of the SharePoint client against the real OXY Connection Flow.
 * Writes only inside a scratch folder it creates, and recycles that folder at the end.
 *
 *   COPILOT_URL='<OXY Connection Flow URL>' npm run test:live -- live-sp-files
 */
import { describe, it, expect } from 'vitest';
import { SharePointFiles, joinSpPath } from '../SharePointFiles';

const URL = process.env.COPILOT_URL || '';
const SITE = 'https://oxyinc.sharepoint.com/sites/AIProduction';
const ROOT = '/sites/AIProduction/Shared Documents';

describe.skipIf(!URL)('SharePoint client, live', () => {
    it('lists, creates, writes, fetches and recycles', async () => {
        const sp = SharePointFiles.forFlow(URL);
        const sites = await sp.sites();
        expect(sites.some(s => s.site === SITE)).toBe(true);

        const folder = joinSpPath(ROOT, `_fmeca_client_test_${Date.now()}`);
        try {
            expect((await sp.mkdir(SITE, joinSpPath(folder, 'sub'))).created).toBe(true);
            const root = await sp.list(SITE, folder, { fresh: true });
            expect(root.folders.map(f => f.name)).toEqual(['sub']);

            const bytes = new Uint8Array(4096).map((_, i) => (i * 37) % 256);
            const written = await sp.write(SITE, folder, '50% check.bin', new Blob([bytes]));
            expect(written.path.endsWith('/50pct check.bin')).toBe(true);
            expect(written.size).toBe(bytes.length);

            const { blob } = await sp.fetchBlob(SITE, written.path);
            expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);

            await sp.write(SITE, folder, 'note.txt', new Blob(['hello']));
            const many = await sp.fetchMany(SITE, [joinSpPath(folder, 'note.txt'), joinSpPath(folder, 'missing.txt')]);
            expect(atob((many[0] as any).contentBase64)).toBe('hello');
            expect(many[1]).toEqual({ path: joinSpPath(folder, 'missing.txt'), error: 'not_found' });

            const err = await sp.write(SITE, folder, 'note.txt', new Blob(['again'])).catch(e => e);
            expect(err.code).toBe('exists');

            const after = await sp.list(SITE, folder);
            expect(after.files.map(f => f.name).sort()).toEqual(['50pct check.bin', 'note.txt']);
        } finally {
            await sp.remove(SITE, folder);
        }
        const gone = await sp.list(SITE, folder, { fresh: true }).catch(e => e);
        expect(gone.code).toBe('not_found');
    });
});
