import { describe, expect, it } from 'vitest';
import {
    buildDescriptionPrompt,
    buildRegisterPayload,
    buildSummary,
    computeSummaryStats,
    REGISTER_LIST,
} from '../RcmRegisterService';

const mode = (over: Record<string, unknown> = {}) => ({
    id: Math.random().toString(36).slice(2),
    mode: 'Bearing wear',
    effect: '',
    cause: '',
    currentControls: '',
    mitigation: '',
    rpn: { s: '', o: '', d: '' },
    ...over,
});

const project: any = {
    id: 'p1',
    name: 'Instrument Air Package',
    desc: '',
    created: '2026-10-01T00:00:00Z',
    updated: '2026-10-01T00:00:00Z',
    subsystems: [
        {
            id: 's1', name: 'Compressor', func: 'Compress air to 7 barg', specs: '',
            failures: [
                {
                    id: 'f1', desc: 'Fails to deliver air',
                    modes: [
                        mode({ currentControls: 'Vibration monitoring', mitigation: 'Add oil analysis', rpn: { s: 8, o: 5, d: 4 } }),
                        mode({ currentControls: '  vibration   MONITORING ', rpn: { s: 2, o: 2, d: 2 } }),
                    ],
                },
            ],
        },
        {
            id: 's2', name: 'Dryer', func: '', specs: '',
            failures: [
                { id: 'f2', desc: 'Dew point high', modes: [mode({ mitigation: 'Replace desiccant every 3 years' })] },
                { id: 'f3', desc: 'Pressure drop high', modes: [] },
            ],
        },
    ],
};

describe('computeSummaryStats', () => {
    it('counts scope, controls, mitigations and risk from the project', () => {
        expect(computeSummaryStats(project)).toEqual({
            subsystems: 2,
            functionalFailures: 3,
            failureModes: 3,
            modesWithControls: 2,
            distinctControls: 1,
            modesWithMitigations: 2,
            distinctMitigations: 2,
            highRpnModes: 1,
            maxRpn: 160,
        });
    });
});

describe('buildSummary', () => {
    it('puts the description above the counted figures', () => {
        const text = buildSummary(project, 'Supplies dry instrument air.');
        expect(text.split('\n')[0]).toBe('Supplies dry instrument air.');
        expect(text).toContain('Scope: 2 subsystems · 3 functional failures · 3 failure modes');
        expect(text).toContain('Current controls: 2 modes covered (1 distinct task)');
        expect(text).toContain('Suggested mitigations: 2 modes (2 distinct actions)');
        expect(text).toContain('High risk: 1 mode at RPN ≥ 100 · max RPN 160');
    });

    it('falls back to the subsystem list without a description', () => {
        expect(buildSummary(project).split('\n')[0]).toBe('Instrument Air Package: Compressor, Dryer.');
    });
});

describe('buildDescriptionPrompt', () => {
    it('gives the AI descriptions but no figures', () => {
        const prompt = buildDescriptionPrompt(project);
        expect(prompt).toContain('- Compressor: Compress air to 7 barg');
        expect(prompt).toContain('- Dryer');
        expect(prompt).not.toContain('Vibration monitoring');
        expect(prompt).not.toContain('Scope:');
    });
});

describe('buildRegisterPayload', () => {
    it('writes the summary to the column whose internal name is fixed', () => {
        const payload = buildRegisterPayload(project, {
            engineerEmail: '', status: 'FMECA', startDate: '2026-10-01', summary: 'Edited summary',
            fileName: 'a.xlsx', fileContentBase64: 'x', jsonFileName: 'a.json', jsonContentBase64: 'y',
        });
        expect(REGISTER_LIST.columns.summary).toBe('SummaryofActions');
        expect(payload.fields.SummaryofActions).toBe('Edited summary');
    });
});
