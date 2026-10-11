import { describe, it, expect } from 'vitest';
import { AIService, applyOwnerRules, OWNER_ASSIGNMENT_RULES, splitCombinedDriverSubsystems } from '../AIService';

describe('owner assignment prompt rules', () => {
    it('routes vibration analysis and oil analysis to fixed teams', () => {
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/Vibration analysis.*→ \(Condition Monitoring Team\)/);
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/Oil analysis.*→ \(Operations Team\)/);
    });

    it('gives a stand-alone device no owner, and a reaction task an owner', () => {
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/safety device listed on its own.*NO owner/);
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/in response to an alarm or reading.*the team that performs the task/);
    });

    it('no longer assigns every tag to the instrument team', () => {
        expect(OWNER_ASSIGNMENT_RULES).not.toMatch(/tag → \(Instrument team\)/);
    });
});

describe('applyOwnerRules', () => {
    it('moves vibration analysis to Condition Monitoring whatever owner the model gave', () => {
        expect(applyOwnerRules('1- Perform monthly vibration analysis on bearings (Mechanical team)'))
            .toBe('1- Perform monthly vibration analysis on bearings (Condition Monitoring Team)');
    });

    it('adds the owner when the model gave none', () => {
        expect(applyOwnerRules('2- Quarterly vibration survey of gearbox'))
            .toBe('2- Quarterly vibration survey of gearbox (Condition Monitoring Team)');
    });

    it('moves oil analysis to Operations', () => {
        expect(applyOwnerRules('1- Take lube oil sample for analysis every 3 months (Mechanical team)'))
            .toBe('1- Take lube oil sample for analysis every 3 months (Operations Team)');
        expect(applyOwnerRules('1- Quarterly oil analysis for wear metals (Mechanical team)'))
            .toBe('1- Quarterly oil analysis for wear metals (Operations Team)');
    });

    it('strips the owner from a stand-alone trip, alarm or tag', () => {
        expect(applyOwnerRules('1- [Tag: TT-101 (Hi-Hi: 110 C)] (Instrument team)'))
            .toBe('1- [Tag: TT-101 (Hi-Hi: 110 C)]');
        expect(applyOwnerRules('2- High bearing temperature trip [Tag: TT-102 (Hi-Hi: 95 C)] (Instrument team)'))
            .toBe('2- High bearing temperature trip [Tag: TT-102 (Hi-Hi: 95 C)]');
        expect(applyOwnerRules('3- Low level alarm [Tag: LT-201 (Lo: 20 %)] (Operations Team)'))
            .toBe('3- Low level alarm [Tag: LT-201 (Lo: 20 %)]');
    });

    it('keeps the owner when someone reacts to the alarm', () => {
        const line = '1- Clean suction filter when differential pressure reaches Hi-Hi [Tag: PDT-301 (Hi-Hi: 0.8 bar)] (Mechanical team)';
        expect(applyOwnerRules(line)).toBe(line);
    });

    it('keeps the owner on a task performed on a safety device', () => {
        const line = '1- Proof test high temperature trip [Tag: TT-101] (Instrument team)';
        expect(applyOwnerRules(line)).toBe(line);
        const psv = '2- Bench test relief valve at set pressure (Mechanical team)';
        expect(applyOwnerRules(psv)).toBe(psv);
    });

    it('leaves ordinary tasks alone', () => {
        const text = '1- Replace mechanical seal at overhaul (Mechanical team)\n2- Check oil level on daily round (Operations Team)';
        expect(applyOwnerRules(text)).toBe(text);
    });

    it('runs inside the numbered action list cleaner', () => {
        expect(AIService.cleanNumberedActionList('1- Vibration analysis monthly (Instrument team)\n2- [Tag: PT-1 (Hi: 9 bar)] (Instrument team)'))
            .toBe('1- Vibration analysis monthly (Condition Monitoring Team)\n2- [Tag: PT-1 (Hi: 9 bar)]');
    });
});

describe('splitCombinedDriverSubsystems', () => {
    it('splits a driven machine from its driver and moves driver specs with it', () => {
        const out = splitCombinedDriverSubsystems([
            { name: 'Pump and Motor', specs: 'Flow: 120 m3/h, Head: 45 m, Motor Power: 30 kW, Voltage: 400 V' },
        ]);
        expect(out.map(s => s.name)).toEqual(['Pump', 'Pump Drive Motor']);
        expect(out[0].specs).toBe('Flow: 120 m3/h, Head: 45 m');
        expect(out[1].specs).toBe('Motor Power: 30 kW, Voltage: 400 V');
    });

    it('handles &, / and named drivers', () => {
        expect(splitCombinedDriverSubsystems([{ name: 'Compressor & Drive Motor', specs: '' }]).map(s => s.name))
            .toEqual(['Compressor', 'Drive Motor']);
        expect(splitCombinedDriverSubsystems([{ name: 'Generator / Gas Turbine', specs: '' }]).map(s => s.name))
            .toEqual(['Generator', 'Gas Turbine']);
    });

    it('leaves names where the driver is not the head noun', () => {
        for (const name of ['Motor Control Center / Switchboard', 'Engine Cooling and Lube System', 'Inlet and Outlet Piping', 'Fan Drive Motor']) {
            expect(splitCombinedDriverSubsystems([{ name, specs: 'X: 1' }])).toEqual([{ name, specs: 'X: 1' }]);
        }
    });
});
