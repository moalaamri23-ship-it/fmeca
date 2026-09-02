import { describe, expect, it } from 'vitest';
import { applyRcmFeedback, countMatchingSubsystems, isRcmFeedback, type RcmFeedback } from '../RcmFeedbackService';
import type { Project } from '../../types';

const project: Project = {
    id: 'p1',
    name: 'Pump Station',
    desc: '',
    created: '',
    updated: '',
    subsystems: [{
        id: 's1', name: 'Pump', specs: '', func: '', imageData: '', imageName: '', imageJson: '', showImageJson: false,
        failures: [{
            id: 'f1', desc: 'No flow',
            modes: [
                { id: 'm1', mode: 'Impeller wear', effect: 'Low flow', cause: 'Erosion', currentControls: '1- Monthly vibration route (Rotating Team)', mitigation: '1- Replace impeller (Rotating Team)', rpn: { s: 5, o: 4, d: 4 } },
                { id: 'm2', mode: 'Seal leak', effect: 'Drip', cause: 'Wear', currentControls: '', mitigation: '', rpn: { s: 3, o: 3, d: 3 } },
            ],
        }],
    }],
};

const feedback: RcmFeedback = {
    kind: 'rcm-feedback',
    version: 1,
    sourceProjectId: 'p1',
    sourceProjectName: 'Pump Station',
    rcmProjectName: 'Pump Station RCM',
    generatedAt: '2026-03-01T00:00:00Z',
    operatingContext: { summary: 'ctx', redundancy: '2x100%', dutyCycle: '', environment: '', productionImpactRule: '', safetyEnvRegime: '' },
    modes: [
        { modeId: 'm1', subsystemId: 's1', failureMode: 'Impeller wear', consequenceCategory: 'Operational', policy: 'On-condition', revisedCurrentControl: '1- Monthly vibration route, alarm at 7.1 mm/s (Rotating Team)', revisedMitigation: '1- Replace impeller on confirmed wear (Rotating Team)\n2- Install upstream strainer (Projects Team)', reviewer: 'A' },
        { modeId: 'ghost', subsystemId: 's1', failureMode: 'Unknown mode', consequenceCategory: 'Operational', policy: 'Redesign', revisedCurrentControl: '', revisedMitigation: 'x' },
    ],
    gaps: [{ code: 'unlisted-protective', severity: 'Major', subsystemId: 's1', text: 'trip not modelled' }],
};

describe('RCM feedback import', () => {
    it('recognises feedback files and scores subsystem matches', () => {
        expect(isRcmFeedback(feedback)).toBe(true);
        expect(isRcmFeedback(project)).toBe(false);
        expect(countMatchingSubsystems(project, feedback)).toBe(1);
    });

    it('replaces controls and mitigations, tags the mode, stores context and gaps, reports unmatched', () => {
        const result = applyRcmFeedback(project, feedback, 'replace');
        const mode = result.project.subsystems[0].failures[0].modes[0];
        expect(mode.currentControls).toContain('7.1 mm/s');
        expect(mode.mitigation).toContain('2- Install upstream strainer');
        expect(mode.sourceTags).toContain('RCM');
        expect(result.project.subsystems[0].failures[0].modes[1].mitigation).toBe('');
        expect(result.project.operatingContext?.redundancy).toBe('2x100%');
        expect(result.project.rcmFeedback?.gaps).toHaveLength(1);
        expect(result.updatedModes).toBe(1);
        expect(result.unmatchedModes).toEqual(['Unknown mode']);
    });

    it('appends without duplicating existing lines and renumbers', () => {
        const result = applyRcmFeedback(project, feedback, 'append');
        const mode = result.project.subsystems[0].failures[0].modes[0];
        expect(mode.mitigation).toBe('1- Replace impeller (Rotating Team)\n2- Replace impeller on confirmed wear (Rotating Team)\n3- Install upstream strainer (Projects Team)');
    });

    it('never overwrites an operating context the FMECA already states', () => {
        const withContext = { ...project, operatingContext: { summary: 'own', redundancy: '', dutyCycle: '', environment: '', productionImpactRule: '', safetyEnvRegime: '' } };
        expect(applyRcmFeedback(withContext, feedback, 'replace').project.operatingContext?.summary).toBe('own');
    });
});
