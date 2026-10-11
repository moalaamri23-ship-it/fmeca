import { describe, it, expect } from 'vitest';
import {
    applyOwnerRules,
    buildBreakdownRows,
    FUNCTION_BREAKDOWN_TECHNICAL_RULES,
    FUNCTION_DESCRIPTION_TECHNICAL_RULES,
    OWNER_ASSIGNMENT_RULES,
    RawBreakdownRow,
} from '../AIService';
import { StandardParameter } from '../../types';

// The rules below were found on one package but are written for classes of
// equipment. Every case here is a DIFFERENT system -- fire water pumps, a lube
// oil console, a hydraulic power unit, a switchboard, a cooler -- so a rule that
// only works for the package it was found on fails here.

const row = (over: Partial<RawBreakdownRow>): RawBreakdownRow => ({
    function: 'deliver rated flow',
    standard: 'rated flow at rated head',
    snippet: 'delivers rated flow',
    functionClass: 'primary',
    quantified: true,
    evidence: 'evident',
    standardParameters: [],
    ...over,
});
const param = (name: string, value: string, unit: string | null, bound: StandardParameter['bound']): StandardParameter =>
    ({ name, value, unit, bound });

describe('general prompt rules', () => {
    it('the breakdown rules exclude certifications, own supply, and pass-through conditions', () => {
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/Certifications and classifications .* are NOT functions and NOT parameters/);
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/OWN supply .* is NOT a function/);
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/A quality requirement .* is ONE requirement/);
        expect(FUNCTION_BREAKDOWN_TECHNICAL_RULES).toMatch(/not the upstream flow, pressure or temperature/);
    });

    it('the description rules say passive and pass-through equipment do not own the stream conditions', () => {
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/passing through it are set by other equipment/);
        expect(FUNCTION_DESCRIPTION_TECHNICAL_RULES).toMatch(/owns only what it changes in that stream/);
    });

    it('general rules hold no instance literals from the package they were found on', () => {
        for (const rules of [FUNCTION_DESCRIPTION_TECHNICAL_RULES]) {
            expect(rules).not.toMatch(/\b(instrument air|compressor|barg|psig|Sm3|8573)\b/i);
        }
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/by sense on a round is NOT vibration analysis/);
    });
});

describe('fire water pump package', () => {
    const siblings = ['Fire Water Pump', 'Pump Drive Motor', 'Fire Water Storage Tank', 'Pump Control Panel'];

    it('a storage tank keeps its capacity as a whole-or-nothing requirement and loses the pass-through flow and pressure', () => {
        const [store] = buildBreakdownRows([
            row({
                function: 'store fire water',
                standard: '500 m3 at 300 m3/h outlet, 2 barg',
                standardParameters: [
                    param('storage capacity', '500', 'm3', 'min'),
                    param('outlet flow', '300', 'm3/h', 'min'),
                    param('outlet pressure', '2', 'barg', 'min'),
                    param('outlet capacity', '300', 'm3/h', 'min'),
                ],
            }),
        ], 'Fire Water Storage Tank', 'Fire Water System', 'detailed', siblings.filter(n => n !== 'Fire Water Storage Tank'));
        expect(store.standardParameters).toEqual([param('storage capacity', '500', 'm3', 'spec')]);
    });

    it('a tank keeps its containment and relief rows untouched', () => {
        const out = buildBreakdownRows([
            row({ function: 'contain fire water', functionClass: 'containment', standardParameters: [param('fire water', 'retained', null, 'spec')] }),
            row({ function: 'relieve overpressure', functionClass: 'protection', evidence: 'hidden', standard: 'PSV set 3 barg', standardParameters: [param('set pressure', '3', 'barg', 'max')] }),
        ], 'Fire Water Storage Tank', 'Fire Water System', 'detailed', siblings);
        expect(out).toHaveLength(2);
        expect(out[1].standardParameters).toHaveLength(1);
    });

    it('the pump keeps its own flow and pressure -- it drives the stream', () => {
        const [pump] = buildBreakdownRows([
            row({ standardParameters: [param('flow', '300', 'm3/h', 'min'), param('discharge pressure', '10', 'barg', 'min')] }),
        ], 'Fire Water Pump', 'Fire Water System', 'detailed', siblings);
        expect(pump.standardParameters).toHaveLength(2);
    });

    it('the control panel loses its own-supply row and its certification rows and parameters', () => {
        const out = buildBreakdownRows([
            row({ function: 'start standby pump on duty pump failure', functionClass: 'protection', evidence: 'hidden', standard: 'within 10 s', standardParameters: [param('start time', '10', 's', 'max')] }),
            row({ function: 'power control circuits', functionClass: 'support', standard: '24 V DC, 230 V AC', standardParameters: [param('control voltage', '24', 'V DC', 'target'), param('auxiliary supply', '230', 'V AC', 'target')] }),
            row({ function: 'maintain hazardous area certification', functionClass: 'support', standard: 'ATEX Zone 2', standardParameters: [param('certification', 'ATEX Zone 2', null, 'spec')] }),
            row({ function: 'monitor pump status', functionClass: 'primary', standard: 'IP55 enclosure, continuous', standardParameters: [param('enclosure', 'IP55', null, 'spec'), param('scan', 'continuous', null, 'spec')] }),
        ], 'Pump Control Panel', 'Fire Water System', 'detailed', siblings);
        expect(out.map(r => r.function)).toEqual(['start standby pump on duty pump failure', 'monitor pump status']);
        expect(out[1].standardParameters.map(p => p.name)).toEqual(['scan']);
    });
});

describe('other system types', () => {
    it('a switchboard keeps its supply rows -- supplying others is its purpose', () => {
        const out = buildBreakdownRows([
            row({ function: 'supply power to control circuits', functionClass: 'support', standard: '110 V DC', standardParameters: [param('voltage', '110', 'V DC', 'target')] }),
        ], '11 kV Switchboard', 'Substation', 'detailed', ['Transformer', 'Battery Charger']);
        expect(out).toHaveLength(1);
    });

    it('a hydraulic conditioning unit states a cleanliness class once, not once per filter', () => {
        const out = buildBreakdownRows([
            row({ function: 'deliver conditioned hydraulic oil', standard: 'ISO 4406 16/14/11, water below 200 ppm', standardParameters: [param('cleanliness', 'ISO 4406 16/14/11', null, 'spec'), param('water content', '200', 'ppm', 'max')] }),
            row({ function: 'retain particles in return filter', standard: 'cleanliness 16/14/11', standardParameters: [param('particle retention', '16/14/11', null, 'spec')] }),
            row({ function: 'cool hydraulic oil', standard: 'below 50 deg C', standardParameters: [param('oil temperature', '50', 'deg C', 'max')] }),
        ], 'Hydraulic Power Unit', 'Hydraulic System', 'detailed', ['Accumulator', 'HPU Control Panel']);
        expect(out.map(r => r.function)).toEqual(['deliver conditioned hydraulic oil', 'cool hydraulic oil']);
    });

    it('does not merge two DIFFERENT quality requirements', () => {
        const out = buildBreakdownRows([
            row({ function: 'deliver dry gas', standardParameters: [param('water dew point', 'class 2', null, 'spec')] }),
            row({ function: 'deliver clean gas', standardParameters: [param('particle class', 'class 1', null, 'spec')] }),
        ], 'Gas Conditioning Skid', 'Fuel Gas System', 'detailed', []);
        expect(out).toHaveLength(2);
    });

    it('does not treat bare matching numbers as the same requirement', () => {
        const out = buildBreakdownRows([
            row({ function: 'deliver sealing water', standardParameters: [param('seal plan', '1', null, 'spec')] }),
            row({ function: 'deliver flushing water', standardParameters: [param('flush grade', '1', null, 'spec')] }),
        ], 'Seal Support System', 'Pump Package', 'detailed', []);
        expect(out).toHaveLength(2);
    });

    it('a lube oil cooler is not passive: its own heat-duty parameters stay', () => {
        const [cool] = buildBreakdownRows([
            row({ function: 'cool lube oil', standard: 'outlet 45 deg C at 200 l/min', standardParameters: [param('oil outlet temperature', '45', 'deg C', 'max'), param('design pressure', '16', 'barg', 'max')] }),
        ], 'Lube Oil Cooler', 'Lube Oil Console', 'detailed', ['Lube Oil Pump', 'Lube Oil Tank']);
        // The design rating is dropped everywhere; the duty it delivers is not.
        expect(cool.standardParameters.map(p => p.name)).toEqual(['oil outlet temperature']);
    });
});

describe('owners on any system', () => {
    it('a by-sense noise/vibration round check goes to Operations, real analysis to Condition Monitoring', () => {
        expect(applyOwnerRules('1- Check pump for abnormal noise and vibration on daily round (Condition Monitoring Team)'))
            .toBe('1- Check pump for abnormal noise and vibration on daily round (Operations Team)');
        expect(applyOwnerRules('1- Fan bearing vibration spectrum trend monthly (Mechanical team)'))
            .toBe('1- Fan bearing vibration spectrum trend monthly (Condition Monitoring Team)');
        expect(applyOwnerRules('1- Gearbox oil analysis quarterly (Mechanical team)'))
            .toBe('1- Gearbox oil analysis quarterly (Operations Team)');
        expect(applyOwnerRules('1- Low suction pressure trip [Tag: PT-210 (Lo-Lo: 0.5 barg)] (Instrument team)'))
            .toBe('1- Low suction pressure trip [Tag: PT-210 (Lo-Lo: 0.5 barg)]');
    });
});
