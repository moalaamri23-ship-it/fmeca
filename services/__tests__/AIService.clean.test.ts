import { describe, it, expect } from 'vitest';
import { AIService } from '../AIService';

/**
 * The cleaner is the single highest-leverage pure function in the generation
 * chain. It used to return a template built from the row when it rejected text,
 * so a broken generation degraded toward a confident wrong answer instead of
 * toward nothing. It returns null now, and these tests pin both halves of that:
 * excess-side and leak wordings must be ACCEPTED, causes and mechanisms REJECTED.
 */
describe('cleanFunctionalFailureText', () => {
    const accepted = [
        'Supplies no instrument air at compressor battery limit',
        'Supplies instrument air below 599 Sm3/hr',
        'Discharge pressure exceeds 12.0 barg design limit',
        'Releases lubricating oil from pressurized boundary',
        'Supplies instrument air erratically below required capacity',
        'Unable to shut down on high discharge temperature',
    ];
    it.each(accepted)('accepts unmet performance however it opens: %s', text => {
        expect(AIService.cleanFunctionalFailureText(text)).toBe(text);
    });

    const rejected: Array<[string, string]> = [
        ['cause', 'No instrument air due to seized airend bearings'],
        ['cause', 'Low discharge pressure caused by worn rotor clearance'],
        ['effect', 'Instrument air loss requires repair of the compressor block'],
        ['bare mechanism', 'Seized airend screw'],
        ['bare mechanism', 'Leaking gasket'],
        ['too short', 'No air'],
        ['reasoning leak', 'Wait, let me reconsider the discharge pressure failure'],
    ];
    it.each(rejected)('rejects a %s: %s', (_kind, text) => {
        expect(AIService.cleanFunctionalFailureText(text)).toBeNull();
    });

    it('rejects text past 22 words rather than truncating it', () => {
        const long = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
        expect(AIService.cleanFunctionalFailureText(long)).toBeNull();
    });
});

/**
 * Regression for the unit-in-value dedupe. The old test was a \b-anchored regex,
 * and \b needs a word character on the boundary -- so every symbol unit slipped
 * through and rendered twice on the chip.
 */
describe('cleanStandardParameters', () => {
    const one = (raw: unknown) => AIService.cleanStandardParameters([raw])[0];

    it('drops a unit the value already carries', () => {
        expect(one({ name: 'discharge pressure', value: '130 psig (9 barg)', unit: 'psig', bound: 'min' }).unit).toBeNull();
    });

    it('drops a redundant percent sign', () => {
        expect(one({ name: 'filtration degree', value: '99.99%', unit: '%', bound: 'min' }).unit).toBeNull();
    });

    it('drops a redundant degree symbol unit', () => {
        expect(one({ name: 'design temperature', value: '150 °C', unit: '°C', bound: 'max' }).unit).toBeNull();
    });

    it('keeps a unit the value does not carry', () => {
        expect(one({ name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'min' }).unit).toBe('Sm3/hr');
    });

    it('falls back to the permissive bound rather than guessing min', () => {
        // Guessing "min" would silently suppress the excess-side failure.
        expect(one({ name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'nonsense' }).bound).toBe('target');
    });

    it('drops a parameter with no value: it cannot be enumerated against', () => {
        expect(AIService.cleanStandardParameters([{ name: 'flow', value: '', bound: 'min' }])).toHaveLength(0);
    });

    it('deduplicates by name', () => {
        const out = AIService.cleanStandardParameters([
            { name: 'flow', value: '599', unit: 'Sm3/hr', bound: 'min' },
            { name: 'Flow', value: '600', unit: 'Sm3/hr', bound: 'min' },
        ]);
        expect(out).toHaveLength(1);
    });
});

describe('cleanStandardParameters — composite units', () => {
    /**
     * From a live run: the model answered a dual-unit value with a dual-unit
     * unit string, and the chip rendered "130 psig (9 barg) psig (barg)". A
     * plain substring test misses it because the value interleaves a number.
     */
    it('drops a composite unit whose tokens are all already in the value', () => {
        const p = AIService.cleanStandardParameters([
            { name: 'discharge pressure', value: '130 psig (9 barg)', unit: 'psig (barg)', bound: 'min' },
        ])[0];
        expect(p.unit).toBeNull();
    });

    it('keeps a composite unit carrying a token the value lacks', () => {
        const p = AIService.cleanStandardParameters([
            { name: 'flow', value: '599 Sm3', unit: 'Sm3/hr', bound: 'min' },
        ])[0];
        expect(p.unit).toBe('Sm3/hr');
    });
});
