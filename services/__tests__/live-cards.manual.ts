/**
 * Manual live check for knowledge-card MasterGen input. Costs real calls.
 *
 *   KNOWLEDGE_FILE=<path> SUBSYSTEM='^compressor air' OUT_DIR=<dir> npm run test:live -- live-cards
 *
 * PROJECT_JSON (optional) supplies the system name and description, which
 * MasterGen passes to the FF step as the system context.
 * Reads COPILOT_URL from the environment or .env.local (last assignment wins).
 * Takes one subsystem's name, specs and function from the cards, then runs the
 * same breakdown and functional-failure steps MasterGen runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AIService } from '../AIService';
import { subsystemsFromKnowledge } from '../KnowledgeCards';

const envUrl = () => {
    if (process.env.COPILOT_URL) return process.env.COPILOT_URL;
    if (!existsSync('.env.local')) return '';
    const lines = readFileSync('.env.local', 'utf8').split('\n').filter(l => l.startsWith('COPILOT_URL='));
    return (lines.pop() || '').slice('COPILOT_URL='.length).trim().replace(/^['"]|['"]$/g, '');
};

describe('live knowledge cards', () => {
    it('runs breakdown and FFs for one card subsystem', { timeout: 900000 }, async () => {
        const url = envUrl();
        const subs = subsystemsFromKnowledge(readFileSync(process.env.KNOWLEDGE_FILE!, 'utf8'));
        const pick = new RegExp(process.env.SUBSYSTEM || '.', 'i');
        const sub = subs.find(s => pick.test(s.name))!;
        expect(sub).toBeTruthy();
        const siblings = subs.filter(s => s !== sub).map(s => s.name);
        const project = process.env.PROJECT_JSON ? JSON.parse(readFileSync(process.env.PROJECT_JSON, 'utf8')) : null;
        const systemName = project?.desc ? `${project.name}: ${project.desc}` : (project?.name || 'Instrument Air Compressor Package');
        const rows = sub.rows.map((r, i) => ({ ...r, snippet: r.function, id: `row${i}` }));
        const open = rows.filter(r => !r.failureShape);
        const shapes = await AIService.classifyFailureShapes({ subsystemName: sub.name, subsystemSpecs: sub.specs, rows: open, key: '', modelName: '', aiProvider: 'copilot', powerAutomateUrl: url, sessionId: `cards-${Date.now()}-shape` });
        open.forEach((r: any, i) => { if (shapes[i].length) { r.failureShape = shapes[i][0]; r.failureShapes = shapes[i]; } });
        const ff = await AIService.generateFFsForBreakdownRows({
            systemName, subsystemName: sub.name, subsystemSpecs: sub.specs,
            funcDesc: sub.func, rows, existingFailures: [], key: '', modelName: '',
            aiProvider: 'copilot', powerAutomateUrl: url, systemContext: '',
            sessionId: `cards-${Date.now()}-ff`, siblingSubsystems: siblings,
        });
        writeFileSync(`${process.env.OUT_DIR}/cards-result.json`, JSON.stringify({ sub, rows, ff }, null, 2));
        expect(rows.length).toBeGreaterThan(0);
    });
});
