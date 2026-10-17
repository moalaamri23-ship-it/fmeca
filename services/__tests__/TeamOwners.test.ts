import { describe, it, expect } from 'vitest';
import { normalizeMitigationOwners, stripControlOwners, canonicalTeam } from '../TeamOwners';

describe('team owners', () => {
    it('writes checklist headings and old names as the plant teams', () => {
        expect(canonicalTeam('Motor mechanical maintenance tasks')).toBe('Mechanical');
        expect(canonicalTeam('Operation team')).toBe('Operations');
        expect(canonicalTeam('PSV team')).toBe('PRV');
        expect(canonicalTeam('Electrical Low Voltage Motor PM')).toBe('Electrical');
        expect(canonicalTeam('Material Integrity')).toBe('MI');
        expect(canonicalTeam('Hi: 10 barg')).toBeNull();
    });

    it('normalizes each mitigation owner and applies the stated exceptions', () => {
        const out = normalizeMitigationOwners([
            '1- Grease motor DE and NDE bearings at 8000 h (Electrical team)',
            '2- Megger test motor windings (Motor mechanical maintenance tasks)',
            '3- Bench test separator safety valve at 12.0 barg (Mechanical team)',
            '4- Calibrate PDT [Tag: 66-PDT-127373 (Hi: 0.2 bar)] (Instrument team)',
            '5- Drain condensate from receiver weekly (Operation team)',
            '6- Monitor oil-filter differential pressure for restriction (Instrument team)',
            '7- UT thickness measurement of wet air receiver shell for corrosion (Mechanical team)',
            '8- Inspect coupling elements for cracks (Mechanical team)',
            '9- Trend insulation resistance and schedule rewind [Tag: 66-KM-127451] (Operations team)',
        ].join('\n'));
        expect(out.split('\n')).toEqual([
            '1- Grease motor DE and NDE bearings at 8000 h (Mechanical team)',
            '2- Megger test motor windings (Electrical team)',
            '3- Bench test separator safety valve at 12.0 barg (PRV team)',
            '4- Calibrate PDT [Tag: 66-PDT-127373 (Hi: 0.2 bar)] (Instrument team)',
            '5- Drain condensate from receiver weekly (Operations team)',
            '6- Monitor oil-filter differential pressure for restriction (Operations team)',
            '7- UT thickness measurement of wet air receiver shell for corrosion (MI team)',
            '8- Inspect coupling elements for cracks (Mechanical team)',
            '9- Trend insulation resistance and schedule rewind [Tag: 66-KM-127451] (Electrical team)',
        ]);
    });

    it('removes owners from current controls but keeps tag limits', () => {
        expect(stripControlOwners('1- [Tag: 66-TT-127404 (HH: 120 deg C)] (Instrument team)\n2- Replace air filter every 3000 h (Compressor maintenance tasks)'))
            .toBe('1- [Tag: 66-TT-127404 (HH: 120 deg C)]\n2- Replace air filter every 3000 h');
        expect(stripControlOwners('1- Weekly visual check (Operations team)')).toBe('1- Weekly visual check');
    });
});
