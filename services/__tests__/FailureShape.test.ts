import { describe, it, expect, vi, afterEach } from 'vitest';
import { allowedFailedStates, allowedStatesForRow, normalizeFailureShape } from '../FailureShape';
import { AIService } from '../AIService';
import { checkRow } from '../CoverageCheck';
import { BreakdownRow, Failure } from '../../types';

describe('allowedFailedStates', () => {
    it('maps each shape to the states it can reach', () => {
        expect(allowedFailedStates('binary', 'evident')).toEqual(['total']);
        expect(allowedFailedStates('below', 'evident')).toEqual(['total', 'partial']);
        expect(allowedFailedStates('above', 'evident')).toEqual(['upper_limit']);
        expect(allowedFailedStates('band', 'evident')).toEqual(['partial', 'upper_limit', 'intermittent']);
        expect(allowedFailedStates('conformance', 'evident')).toEqual(['partial']);
        expect(allowedFailedStates('protective', 'hidden')).toEqual(['on_demand', 'upper_limit']);
    });

    it('turns total loss into on-demand loss for a hidden function', () => {
        expect(allowedFailedStates('binary', 'hidden')).toEqual(['on_demand']);
        expect(allowedFailedStates('below', 'hidden')).toEqual(['on_demand', 'partial']);
    });

    it('places no restriction on a row without a shape', () => {
        expect(allowedFailedStates(undefined, 'evident')).toBeNull();
        expect(normalizeFailureShape('BELOW ')).toBe('below');
        expect(normalizeFailureShape('sometimes')).toBeUndefined();
    });
});

describe('generateFFsForBreakdownRows with a declared shape', () => {
    afterEach(() => vi.restoreAllMocks());

    const rows = [
        { id: 'r1', function: 'drive pump shaft', standard: '75 kW at 1480 rpm', snippet: 's', evidence: 'evident' as const, failureShape: 'below' as const,
          standardParameters: [{ name: 'power', value: '75', unit: 'kW', bound: 'min' as const }, { name: 'speed', value: '1480', unit: 'rpm', bound: 'min' as const }] },
        { id: 'r2', function: 'contain stored air', standard: 'no leakage', snippet: 's', evidence: 'evident' as const, failureShape: 'binary' as const, standardParameters: [] },
        { id: 'r3', function: 'relieve overpressure', standard: 'set 12 barg', snippet: 's', evidence: 'hidden' as const, failureShape: 'protective' as const, standardParameters: [] },
    ];
    const args = {
        systemName: 'Sys', subsystemName: 'Sub', subsystemSpecs: '', funcDesc: 'f', rows, existingFailures: [],
        key: 'sk-test-key-long-enough', modelName: 'm', aiProvider: 'openai',
    };

    /**
     * Live runs: one row with two parameters came back as total + power below +
     * speed below + erratic, and a fixed capacity came back "partial". The shape
     * keeps one failure per admissible state and drops the rest without a repair
     * call, which would only restate them.
     */
    it('keeps one failure per admissible state and drops the rest without repairing them', async () => {
        const chat = vi.spyOn(AIService, 'chat').mockResolvedValue(JSON.stringify({ failures: [
            { rowId: 'r1', parameter: '', failedState: 'total', desc: 'Delivers no shaft power to the pump' },
            { rowId: 'r1', parameter: 'power', failedState: 'partial', desc: 'Delivers shaft power below 75 kW' },
            { rowId: 'r1', parameter: 'speed', failedState: 'partial', desc: 'Runs below 1480 rpm required speed' },
            { rowId: 'r1', parameter: '', failedState: 'intermittent', desc: 'Delivers shaft power erratically during running' },
            { rowId: 'r2', parameter: '', failedState: 'total', desc: 'Loses containment of stored air' },
            { rowId: 'r2', parameter: '', failedState: 'partial', desc: 'Leaks stored air in small amounts to atmosphere' },
            { rowId: 'r3', parameter: '', failedState: 'total', desc: 'Does not relieve overpressure at 12 barg on demand' },
        ] }));
        const out = await AIService.generateFFsForBreakdownRows(args);
        expect(out.failures.map(f => `${f.rowId}:${f.failedState}`)).toEqual(['r1:total', 'r1:partial', 'r2:total', 'r3:on_demand']);
        // r1: speed-below (a second partial) and the erratic one; r2's partial was
        // relabelled to the binary row's only state and then deduplicated.
        expect(out.rejected.map(r => r.rowId)).toEqual(['r1']);
        expect(chat).toHaveBeenCalledTimes(1);
    });

    /**
     * Deployed run: a dryer's drying duty (conformance) came back with "does not
     * dry" tagged total and "dew point above -15 deg C" tagged partial. The first
     * was out of shape, the second's "above" read as contradicting "partial", and
     * the primary function of the subsystem ended with no failure at all.
     */
    it('never leaves a shaped row empty, and does not apply the wording check to a single-state row', async () => {
        vi.spyOn(AIService, 'chat').mockResolvedValue(JSON.stringify({ failures: [
            { rowId: 'd1', parameter: 'dew point', failedState: 'total', desc: 'Does not dry the compressed air' },
            { rowId: 'd1', parameter: 'dew point', failedState: 'partial', desc: 'Delivers air with dew point above -15 deg C' },
            { rowId: 'p1', parameter: '', failedState: 'intermittent', desc: 'Delivers flow erratically to the header' },
        ] }));
        const out = await AIService.generateFFsForBreakdownRows({
            ...args,
            rows: [
                { id: 'd1', function: 'dry compressed air', standard: 'dew point -15 deg C', snippet: 's', evidence: 'evident', failureShape: 'conformance', standardParameters: [] },
                { id: 'p1', function: 'deliver flow', standard: '510 Sm3/hr', snippet: 's', evidence: 'evident', failureShape: 'below', standardParameters: [] },
            ],
        });
        expect(out.failures.map(f => `${f.rowId}:${f.failedState}`)).toEqual(['d1:partial', 'p1:total']);
    });
});

describe('checkRow with a declared shape', () => {
    const row = (over: Partial<BreakdownRow>): BreakdownRow => ({
        id: 'r1', function: 'drive pump shaft', standard: '75 kW', snippet: 's', functionClass: 'primary', evidence: 'evident',
        standardParameters: [{ name: 'power', value: '75', unit: 'kW', bound: 'min' }, { name: 'speed', value: '1480', unit: 'rpm', bound: 'min' }],
        failureShape: 'below', ...over,
    });
    const fail = (failedState: any, parameter?: string): Failure => ({ id: failedState, desc: 'x', modes: [], sourceBreakdownRowId: 'r1', failedState, parameter } as Failure);

    it('judges coverage per state, so an unmentioned parameter is not a gap', () => {
        expect(checkRow(row({}), [fail('total'), fail('partial', 'power')]).map(f => f.label)).toEqual([]);
    });

    it('reports a missing expected state and a state the shape cannot reach', () => {
        expect(checkRow(row({}), [fail('total')]).map(f => f.label)).toContain('Expected state missing');
        expect(checkRow(row({ failureShape: 'binary', standardParameters: [] }), [fail('total'), fail('partial')]).map(f => f.label)).toContain('State outside failure shape');
    });
});

describe('allowedStatesForRow', () => {
    it('unions the states of every requirement in the standard', () => {
        expect(allowedStatesForRow({ failureShapes: ['below', 'above'], evidence: 'evident' })?.sort()).toEqual(['partial', 'total', 'upper_limit']);
        expect(allowedStatesForRow({ failureShape: 'binary', evidence: 'hidden' })).toEqual(['on_demand']);
        expect(allowedStatesForRow({ evidence: 'evident' })).toBeNull();
    });
});
