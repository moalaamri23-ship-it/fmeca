import { describe, it, expect, vi } from 'vitest';
import { buildBreakdownRows, RawBreakdownRow } from '../AIService';

const row = (over: Partial<RawBreakdownRow>): RawBreakdownRow => ({
    function: 'supply instrument air',
    standard: '599 Sm3/hr at 9 barg',
    snippet: 'supplies instrument air',
    functionClass: 'primary',
    quantified: true,
    evidence: 'evident',
    standardParameters: [],
    ...over,
});

describe('buildBreakdownRows', () => {
    /**
     * Regression: bucketOf prefixes the class so two same-worded duties in
     * different classes survive merging, and addRow then re-derived a bare key
     * and dropped the second anyway -- taking its parameters with it. The merge
     * decided to keep two rows; the dedupe overruled it without telling anyone.
     */
    it('keeps one function phrase that appears under two different classes', () => {
        const out = buildBreakdownRows([
            row({
                function: 'limit discharge temperature',
                functionClass: 'protection',
                standard: 'HH trip 120 deg C',
                standardParameters: [{ name: 'trip setpoint', value: '120', unit: 'deg C', bound: 'max' }],
            }),
            row({
                function: 'limit discharge temperature',
                functionClass: 'control',
                standard: 'held below 100 deg C in normal running',
                standardParameters: [{ name: 'running temperature', value: '100', unit: 'deg C', bound: 'max' }],
            }),
        ], 'Air Compressor System', 'Instrument Air Package');
        expect(out).toHaveLength(2);
        expect(out.map(r => r.functionClass).sort()).toEqual(['control', 'protection']);
    });

    it('merges one duty stated twice and unions the parameters', () => {
        const out = buildBreakdownRows([
            row({
                function: 'contain air and oil',
                functionClass: 'containment',
                standard: '13.8 barg, 150 deg C',
                standardParameters: [{ name: 'compressed air', value: 'retained', unit: null, bound: 'spec' }],
            }),
            row({
                function: 'contains air and oil',   // inflected form: same duty
                functionClass: 'containment',
                standard: 'retained within pressure envelope',
                quantified: false,
                standardParameters: [{ name: 'lubricating oil', value: 'retained', unit: null, bound: 'spec' }],
            }),
        ], 'Air Compressor System', 'Instrument Air Package');
        expect(out).toHaveLength(1);
        expect(out[0].standardParameters.map(p => p.name).sort()).toEqual(['compressed air', 'lubricating oil']);
    });

    it('keeps the quantified member when merging, not the first one', () => {
        const out = buildBreakdownRows([
            row({ function: 'supply instrument air', standard: 'as required', quantified: false }),
            row({ function: 'supply instrument air', standard: '599 Sm3/hr at 9 barg', quantified: true }),
        ], 'Air Compressor System', 'Instrument Air Package');
        expect(out).toHaveLength(1);
        expect(out[0].standard).toContain('599');
    });

    it('a hidden member makes the merged function hidden', () => {
        const out = buildBreakdownRows([
            row({ function: 'maintain supply on duty loss', evidence: 'evident' }),
            row({ function: 'maintain supply on duty loss', evidence: 'hidden' }),
        ], 'Air Compressor System', 'Instrument Air Package');
        expect(out[0].evidence).toBe('hidden');
    });

    /** Silent truncation was the same family of loss as the dedupe bug. */
    it('warns when the row cap drops functions instead of dropping them silently', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const many = Array.from({ length: 11 }, (_, i) => row({ function: `deliver service ${i}`, snippet: `s${i}` }));
        const out = buildBreakdownRows(many, 'Air Compressor System', 'Instrument Air Package');
        expect(out).toHaveLength(8);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain('dropped');
        warn.mockRestore();
    });

    it('drops a row whose standard is a weak adjective with no requirement in it', () => {
        const out = buildBreakdownRows([
            row({ function: 'operate reliably', standard: 'reliable', quantified: false }),
        ], 'Air Compressor System', 'Instrument Air Package');
        expect(out).toHaveLength(0);
    });
});
