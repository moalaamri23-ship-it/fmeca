import { describe, it, expect } from 'vitest';
import { checkRow, checkBreakdown, checkProject, matchesByRow } from '../CoverageCheck';
import { BreakdownRow, Failure, Project } from '../../types';

const brow = (over: Partial<BreakdownRow> = {}): BreakdownRow => ({
    id: 'r1',
    function: 'supply instrument air',
    standard: '599 Sm3/hr at 9 barg',
    snippet: 'supplies instrument air',
    functionClass: 'primary',
    quantified: true,
    evidence: 'evident',
    standardParameters: [{ name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'min' }],
    ...over,
});

const fail = (over: Partial<Failure> = {}): Failure => ({
    id: 'f1',
    desc: 'Supplies instrument air below 599 Sm3/hr',
    modes: [],
    collapsed: false,
    sourceBreakdownRowId: 'r1',
    parameter: 'flow',
    failedState: 'partial',
    ...over,
} as Failure);

const labels = (fs: ReturnType<typeof checkRow>) => fs.map(f => f.label);

describe('checkRow', () => {
    it('is quiet when the requirement is covered', () => {
        expect(checkRow(brow(), [fail()])).toEqual([]);
    });

    it('reports a requirement with no failure at all', () => {
        const row = brow({
            standardParameters: [
                { name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'min' },
                { name: 'discharge pressure', value: '9', unit: 'barg', bound: 'min' },
            ],
        });
        expect(labels(checkRow(row, [fail()]))).toContain('Uncovered requirement');
    });

    it('reports a row with no failures at all', () => {
        expect(labels(checkRow(brow(), []))).toContain('No failures');
    });

    /**
     * JA1011 5.1.5: a protective function's only failed state is inability to
     * protect. Reporting its trip setpoint as uncovered is what pushed the
     * excursion back in as a second row on the same duty.
     */
    it('accepts on_demand alone as full coverage of a protective function', () => {
        const row = brow({
            function: 'be able to shut down on high discharge temperature',
            functionClass: 'protection',
            evidence: 'hidden',
            standardParameters: [{ name: 'trip setpoint', value: '120', unit: 'deg C', bound: 'max' }],
        });
        const f = fail({ desc: 'Unable to shut down on high discharge temperature', parameter: 'trip setpoint', failedState: 'on_demand' });
        expect(labels(checkRow(row, [f]))).not.toContain('Uncovered requirement');
    });

    it('still reports a hidden function with no on-demand failure', () => {
        const row = brow({ evidence: 'hidden' });
        expect(labels(checkRow(row, [fail()]))).toContain('Hidden, no on-demand failure');
    });

    it('reports total and on_demand together as a duplicate', () => {
        const row = brow({ evidence: 'hidden' });
        const fs = [
            fail({ id: 'a', failedState: 'total' }),
            fail({ id: 'b', failedState: 'on_demand' }),
        ];
        expect(labels(checkRow(row, fs))).toContain('Total and on-demand both present');
    });

    it('detects a Fahrenheit/Celsius pair that does not convert', () => {
        // 198.2 deg F is 92.3 deg C, not 59 -- a real value in a real datasheet.
        const row = brow({
            standard: 'maximum discharge temperature 198.2 deg F (59 deg C)',
            standardParameters: [{ name: 'discharge temperature', value: '198.2', unit: 'deg F', bound: 'max' }],
        });
        expect(labels(checkRow(row, [fail({ parameter: 'discharge temperature', failedState: 'upper_limit' })]))).toContain('Unit conflict');
    });

    /** New: two disagreeing magnitudes sharing one unit, which findUnitConflict misses. */
    it('detects two different values stated for one requirement', () => {
        const row = brow({
            standardParameters: [{ name: 'design pressure', value: '12 barg (13.8 barg design)', unit: 'barg', bound: 'max' }],
        });
        expect(labels(checkRow(row, [fail({ parameter: 'design pressure', failedState: 'upper_limit' })]))).toContain('Disputed value');
    });

    it('does not call a rounded restatement a disputed value', () => {
        const row = brow({
            standardParameters: [{ name: 'flow', value: '599 (600 nominal)', unit: 'Sm3/hr', bound: 'min' }],
        });
        expect(labels(checkRow(row, [fail()]))).not.toContain('Disputed value');
    });

    it('flags legacy template text', () => {
        expect(labels(checkRow(brow(), [fail({ needsReview: true })]))).toContain('Placeholder text');
    });
});

describe('checkBreakdown', () => {
    it('falls back to the match result when sourceBreakdownRowId is orphaned', () => {
        // Re-decomposing mints fresh row ids, so every existing failure loses its
        // link. A checker that silently reports nothing is the one failure mode a
        // safety net must not have.
        const row = brow({ id: 'new-row' });
        const f = fail({ sourceBreakdownRowId: 'stale-row' });
        const out = checkBreakdown([row], [f], [{ rowId: 'new-row', failureIds: ['f1'] }]);
        expect(out).toEqual([]);
    });

    it('reports "No failures" when nothing links and no match exists', () => {
        const out = checkBreakdown([brow({ id: 'new-row' })], [fail({ sourceBreakdownRowId: 'stale' })], null);
        expect(out.map(f => f.label)).toContain('No failures');
    });
});

describe('checkProject', () => {
    const proj = (a: string, b: string): Project => ({
        id: 'p', name: 'Instrument Air', desc: '', created: '', updated: '',
        subsystems: [
            {
                id: 's1', name: 'Air Compressor System', specs: '', func: '', failures: [],
                functionBreakdown: [brow({ id: 'r1', standardParameters: [{ name: 'cut in pressure', value: a, unit: 'barg', bound: 'min' }] })],
            },
            {
                id: 's2', name: 'Wet Air Receiver', specs: '', func: '', failures: [],
                functionBreakdown: [brow({ id: 'r2', standardParameters: [{ name: 'cut-in pressure', value: b, unit: 'barg', bound: 'min' }] })],
            },
        ],
    } as unknown as Project);

    /**
     * A real run: the compressor said the unit loads at 8.5 barg while the wet
     * receiver said 8.0. Both values were in the source documents, which
     * contradicted each other, and each subsystem quietly picked a side.
     */
    it('reports one setpoint stated differently in two subsystems', () => {
        const out = checkProject(proj('8.5', '8.0'));
        expect(out.map(f => f.label)).toEqual(['Cross-subsystem conflict', 'Cross-subsystem conflict']);
        expect(out.map(f => f.rowId).sort()).toEqual(['r1', 'r2']);
        expect(out[0].detail).toContain('Air Compressor System');
        expect(out[0].detail).toContain('Wet Air Receiver');
    });

    it('is quiet when the two subsystems agree', () => {
        expect(checkProject(proj('8.0', '8.0'))).toEqual([]);
    });

    it('does not compare values carrying different units', () => {
        // 9 barg and 130 psig are the same pressure; flagging them would bury the
        // real disagreements.
        const p = proj('9', '130');
        (p.subsystems[1].functionBreakdown![0].standardParameters![0] as any).unit = 'psig';
        expect(checkProject(p)).toEqual([]);
    });
});

describe('matchesByRow', () => {
    /**
     * Auto-Fill wrote one match entry PER FAILURE — [{r1,[f1]},{r1,[f2]},{r1,[f3]}]
     * — while MasterGen grouped them. Every reader assumed one entry per row: the
     * modal used map.set and kept the LAST, checkBreakdown used .find and kept the
     * FIRST. A row with five generated failures displayed one.
     */
    it('merges duplicate rowId entries instead of keeping one', () => {
        const out = matchesByRow([
            { rowId: 'r1', failureIds: ['f1'] },
            { rowId: 'r1', failureIds: ['f2'] },
            { rowId: 'r1', failureIds: ['f3'] },
            { rowId: 'r2', failureIds: ['f4'] },
        ]);
        expect(out.get('r1')).toEqual(['f1', 'f2', 'f3']);
        expect(out.get('r2')).toEqual(['f4']);
    });

    it('handles the already-grouped shape unchanged', () => {
        const out = matchesByRow([{ rowId: 'r1', failureIds: ['f1', 'f2', 'f3'] }]);
        expect(out.get('r1')).toEqual(['f1', 'f2', 'f3']);
    });

    it('deduplicates a failure listed under one row twice', () => {
        const out = matchesByRow([
            { rowId: 'r1', failureIds: ['f1', 'f2'] },
            { rowId: 'r1', failureIds: ['f2', 'f3'] },
        ]);
        expect(out.get('r1')).toEqual(['f1', 'f2', 'f3']);
    });

    it('returns an empty map for null', () => {
        expect(matchesByRow(null).size).toBe(0);
    });
});

describe('checkBreakdown with per-failure match entries', () => {
    it('sees every failure on a row split across duplicate match entries', () => {
        // Two requirements, both covered, but the matches arrive one-per-entry.
        const row = brow({
            id: 'r1',
            standardParameters: [
                { name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'min' },
                { name: 'discharge pressure', value: '9', unit: 'barg', bound: 'min' },
            ],
        });
        const fs = [
            fail({ id: 'f1', sourceBreakdownRowId: 'stale', parameter: 'flow', failedState: 'partial' }),
            fail({ id: 'f2', sourceBreakdownRowId: 'stale', parameter: 'discharge pressure', failedState: 'partial' }),
        ];
        const out = checkBreakdown([row], fs, [
            { rowId: 'r1', failureIds: ['f1'] },
            { rowId: 'r1', failureIds: ['f2'] },
        ]);
        // Before the fix .find() saw only f1 and reported discharge pressure uncovered.
        expect(out).toEqual([]);
    });
});

describe('findValueConflict — dual-unit restatements are not disputes', () => {
    const detailFor = (value: string, unit: string | null = null) => {
        const row = brow({ standardParameters: [{ name: 'discharge pressure', value, unit, bound: 'min' }] });
        return checkRow(row, [fail({ parameter: 'discharge pressure', failedState: 'partial' })])
            .filter(f => f.label === 'Disputed value');
    };

    it('does not flag one pressure written in two units', () => {
        // Regression: "130 psig (9 barg)" was reported as "states both 130 and 9".
        expect(detailFor('130 psig (9 barg)')).toEqual([]);
    });

    it('does not flag one temperature written in two units', () => {
        // The F/C case that IS wrong is findUnitConflict's job -- it can convert.
        expect(detailFor('198.2 deg F (59 deg C)')).toEqual([]);
    });

    it('still flags two different figures sharing one unit', () => {
        expect(detailFor('12 barg (13.8 barg design)')).toHaveLength(1);
    });

    it('still flags two bare figures with no unit at all', () => {
        expect(detailFor('8.5 (8.0 per control philosophy)')).toHaveLength(1);
    });
});
