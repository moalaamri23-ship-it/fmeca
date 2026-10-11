import { describe, it, expect } from 'vitest';
import {
    buildBreakdownRows,
    buildControlOwnershipBlock,
    FUNCTION_DESCRIPTION_TECHNICAL_RULES,
    FUNCTION_BREAKDOWN_TECHNICAL_RULES,
    RawBreakdownRow,
} from '../AIService';

// Duty ownership: a shared control / changeover duty is written once, in the
// subsystem whose hardware performs it. Cases deliberately span unrelated
// systems so the rule is proven general, not fitted to one package.

const row = (over: Partial<RawBreakdownRow>): RawBreakdownRow => ({
    function: 'store process fluid',
    standard: 'working volume as specified',
    snippet: 'stores process fluid',
    functionClass: 'primary',
    quantified: false,
    evidence: 'evident',
    standardParameters: [],
    ...over,
});

describe('function description prompt rules', () => {
    it('carries the ownership rule', () => {
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/ONLY the duties this subsystem's own hardware performs/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/Passive equipment .* has no control duty/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/changeover.*belong to the subsystem that commands the start/);
    });

    it('no longer forces coverage of every dimension', () => {
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).not.toMatch(/Cover each dimension/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).not.toMatch(/Controlled performance:/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).not.toMatch(/when the system context states one/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/Output 1 to 3 plain sentences, one per duty/);
    });

    it('breakdown rules apply the same ownership rule', () => {
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/Ownership: create a control, sequencing, load\/unload, standby or changeover row ONLY/);
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/belong ONLY to the subsystem that commands the changeover/);
    });

    it('general rules hold no equipment literals', () => {
        for (const rules of [FUNCTION_DESCRIPTION_TECHNICAL_RULES]) {
            expect(rules).not.toMatch(/\b(air|compressor|barg|psig|instrument air)\b/i);
        }
    });
});

describe('buildControlOwnershipBlock', () => {
    it('names the control sibling as owner for a driven machine', () => {
        const block = buildControlOwnershipBlock('Fire Water Pump', ['Diesel Driver', 'Pump Control Panel', 'Suction Tank']);
        expect(block).toContain('"Pump Control Panel"');
        expect(block).toContain('Leave those duties out of "Fire Water Pump"');
        expect(block).not.toMatch(/passive equipment/);
    });

    it('tells the control subsystem to state shared duties once', () => {
        const block = buildControlOwnershipBlock('Generator PLC', ['Diesel Engine', 'Alternator']);
        expect(block).toMatch(/state each of them ONCE, in this subsystem/);
    });

    it('marks passive equipment as having no control duty', () => {
        const block = buildControlOwnershipBlock('Chilled Water Expansion Tank', ['Chiller', 'BMS Controller']);
        expect(block).toMatch(/passive equipment/);
        expect(block).toContain('"BMS Controller"');
    });

    it('falls back to own-hardware wording when no sibling is a control subsystem', () => {
        const block = buildControlOwnershipBlock('Cooling Tower Fan', ['Basin', 'Circulating Pump']);
        expect(block).toMatch(/No sibling is identifiable as the control subsystem/);
    });
});

describe('buildBreakdownRows duty ownership', () => {
    it('a vessel whose description mentions load/unload yields no control row', () => {
        const out = buildBreakdownRows([
            row({ function: 'store process fluid', functionClass: 'primary' }),
            row({ function: 'contain stored fluid', functionClass: 'containment', standard: 'within design envelope' }),
            row({ function: 'buffer load/unload cycling', functionClass: 'control', standard: 'between cut-in and cut-out' }),
            row({ function: 'provide level feedback', functionClass: 'control', standard: 'to control system' }),
        ], 'Storage Vessel', 'Any Package', 'detailed', ['Feed Pump', 'Unit Control Panel']);
        expect(out.map(r => r.functionClass).sort()).toEqual(['containment', 'primary']);
    });

    it('drops a vessel control row even when no sibling owns control', () => {
        const out = buildBreakdownRows([
            row({ function: 'store process fluid', functionClass: 'primary' }),
            row({ function: 'stabilize downstream pressure', functionClass: 'control', standard: 'operating range' }),
        ], 'Surge Drum', 'Any Package', 'detailed', ['Booster Pump']);
        expect(out).toHaveLength(1);
        expect(out[0].functionClass).toBe('primary');
    });

    it('drops the standby takeover and sequencing rows from a driven unit when a control sibling exists', () => {
        const out = buildBreakdownRows([
            row({ function: 'deliver rated flow', functionClass: 'primary', standard: 'rated flow at rated head', quantified: true }),
            row({ function: 'maintain supply when duty unit fails', functionClass: 'protection', evidence: 'hidden', standard: '2 x 100% duty/standby' }),
            row({ function: 'load and unload on demand', functionClass: 'control', standard: 'per control band' }),
            row({ function: 'shut down on high bearing temperature', functionClass: 'protection', evidence: 'hidden', standard: 'trip setpoint as specified' }),
        ], 'Transfer Pump', 'Any Package', 'detailed', ['Pump Motor', 'Package PLC']);
        expect(out.map(r => r.function)).toEqual(['deliver rated flow', 'shut down on high bearing temperature']);
    });

    it('keeps the shared duties in the control subsystem itself', () => {
        const out = buildBreakdownRows([
            row({ function: 'start standby unit on duty unit trip', functionClass: 'protection', evidence: 'hidden', standard: 'within specified time' }),
            row({ function: 'load and unload the duty unit', functionClass: 'control', standard: 'per control band' }),
        ], 'Package PLC', 'Any Package', 'detailed', ['Transfer Pump', 'Pump Motor']);
        expect(out).toHaveLength(2);
    });

    it('keeps a driven unit\'s own control duty when no sibling owns control', () => {
        const out = buildBreakdownRows([
            row({ function: 'deliver rated flow', functionClass: 'primary', standard: 'rated flow', quantified: true }),
            row({ function: 'load and unload on demand', functionClass: 'control', standard: 'per control band' }),
        ], 'Transfer Pump', 'Any Package', 'detailed', ['Pump Motor']);
        expect(out).toHaveLength(2);
    });

    it('keeps a driven unit\'s own regulating duty that is not a shared package duty', () => {
        const out = buildBreakdownRows([
            row({ function: 'regulate lube oil temperature', functionClass: 'control', standard: 'operating range' }),
        ], 'Gearbox', 'Any Package', 'detailed', ['Motor', 'Unit Control Panel']);
        expect(out).toHaveLength(1);
    });

    it('does not treat every subsystem as a control subsystem because of the project name', () => {
        const out = buildBreakdownRows([
            row({ function: 'store process fluid', functionClass: 'primary' }),
            row({ function: 'report level to transmitter', functionClass: 'primary', standard: 'monitored by PLC' }),
        ], 'Day Tank', 'Instrumentation and Control Upgrade', 'detailed', []);
        expect(out.map(r => r.function)).toEqual(['store process fluid']);
    });
});
