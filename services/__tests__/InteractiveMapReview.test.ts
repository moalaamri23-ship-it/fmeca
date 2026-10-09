import { describe, expect, it } from 'vitest';
import { REVIEW_NOTES_CSS, REVIEW_NOTES_JS } from '../InteractiveMapReview';

// Both strings are pasted verbatim into the exported HTML's inline <style> and
// <script>. A slip here breaks every reviewed export silently, so check the
// things a template literal or an HTML parser would trip over.
describe('interactive map review notes', () => {
    it('is a script the browser can parse', () => {
        expect(() => new Function(REVIEW_NOTES_JS)).not.toThrow();
    });

    it('cannot close its own script or style tag early', () => {
        expect(REVIEW_NOTES_JS.toLowerCase()).not.toContain('</script');
        expect(REVIEW_NOTES_CSS.toLowerCase()).not.toContain('</style');
    });

    it('survives being interpolated into the export template', () => {
        for (const src of [REVIEW_NOTES_JS, REVIEW_NOTES_CSS]) {
            expect(src).not.toContain('`');
            expect(src).not.toContain('${');
        }
    });
});
