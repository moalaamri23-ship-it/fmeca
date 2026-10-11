import { describe, it, expect } from 'vitest';
import {
    AIService,
    applyOwnerRules,
    OWNER_ASSIGNMENT_RULES,
} from '../AIService';

describe('PSV team', () => {
    it('is named in the owner rules', () => {
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/pressure safety or relief valve .* → \(PSV team\)/);
    });

    it('owns every task on a PSV, PRV or safety valve on any system', () => {
        expect(applyOwnerRules('1- Bench test and recertify oil separator PSV [Tag: PSV-16 (set 12 barg)] (Instrument team)'))
            .toBe('1- Bench test and recertify oil separator PSV [Tag: PSV-16 (set 12 barg)] (PSV team)');
        expect(applyOwnerRules('1- Overhaul pump discharge relief valve every 2 years (Mechanical team)'))
            .toBe('1- Overhaul pump discharge relief valve every 2 years (PSV team)');
        expect(applyOwnerRules('2- Inspect boiler safety valve seat'))
            .toBe('2- Inspect boiler safety valve seat (PSV team)');
    });

    it('leaves a PSV listed as a stand-alone control with no owner', () => {
        expect(applyOwnerRules('1- Oil separator safety valve [Tag: PSV-16 (12 barg)] (Instrument team)'))
            .toBe('1- Oil separator safety valve [Tag: PSV-16 (12 barg)]');
        expect(applyOwnerRules('1- Tank relief valve [Tag: PSV-3 (3 barg)]'))
            .toBe('1- Tank relief valve [Tag: PSV-3 (3 barg)]');
    });
});

describe('Electrical team for electric motors', () => {
    it('is named in the owner rules, with greasing kept mechanical', () => {
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/Greasing or lubricating an electric motor's bearings → \(Mechanical team\)/);
        expect(OWNER_ASSIGNMENT_RULES).toMatch(/Any other task on an electric motor .* → \(Electrical team\)/);
    });

    it('motor tasks go to Electrical, motor bearing greasing to Mechanical', () => {
        expect(applyOwnerRules('1- Measure motor winding insulation resistance yearly (Mechanical team)'))
            .toBe('1- Measure motor winding insulation resistance yearly (Electrical team)');
        expect(applyOwnerRules('1- Regrease motor bearings every 2000 h (Electrical team)'))
            .toBe('1- Regrease motor bearings every 2000 h (Mechanical team)');
        expect(applyOwnerRules('1- Inspect cooler fan motor terminal box (Mechanical team)'))
            .toBe('1- Inspect cooler fan motor terminal box (Electrical team)');
    });

    it('in a motor subsystem a task need not say "motor"', () => {
        expect(applyOwnerRules('1- Megger stator windings (Instrument team)\n2- Grease drive-end bearing (Electrical team)', 'Pump Drive Motor'))
            .toBe('1- Megger stator windings (Electrical team)\n2- Grease drive-end bearing (Mechanical team)');
    });

    it('vibration analysis, round checks, coupling alignment and motor-driven equipment keep their own owners', () => {
        expect(applyOwnerRules('1- Motor bearing vibration spectrum trend (Electrical team)'))
            .toBe('1- Motor bearing vibration spectrum trend (Condition Monitoring Team)');
        const round = '1- Check motor for abnormal noise on daily round (Operations Team)';
        expect(applyOwnerRules(round, 'Fan Drive Motor')).toBe(round);
        const align = '1- Laser-align motor to pump coupling (Mechanical team)';
        expect(applyOwnerRules(align)).toBe(align);
        const mov = '1- Stroke test motor-operated valve (Instrument team)';
        expect(applyOwnerRules(mov)).toBe(mov);
        const pump = '1- Replace pump mechanical seal (Mechanical team)';
        expect(applyOwnerRules(pump, 'Fire Water Pump')).toBe(pump);
    });

    it('a turbine or engine is not an electric motor', () => {
        const line = '1- Borescope inspect hot section (Mechanical team)';
        expect(applyOwnerRules(line, 'Gas Turbine')).toBe(line);
    });

    it('reaches the wand cleaner with the subsystem name', () => {
        expect(AIService.cleanNumberedActionList('1- Check winding temperature trend (Mechanical team)', 'Compressor Drive Motor'))
            .toBe('1- Check winding temperature trend (Electrical team)');
    });
});
