/**
 * Manual live A/B of failure modes with and without the knowledge card's
 * boundary block (file-only). Costs 2 calls per case.
 *   KNOWLEDGE_FILE=<path> CHECKLIST_FILE=<path> OUT_DIR=<dir> npm run test:live -- live-modes
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AIService } from '../AIService';
import { findCardSubsystem } from '../KnowledgeCards';

const envUrl = () => {
    if (process.env.COPILOT_URL) return process.env.COPILOT_URL;
    if (!existsSync('.env.local')) return '';
    const lines = readFileSync('.env.local', 'utf8').split('\n').filter(l => l.startsWith('COPILOT_URL='));
    return (lines.pop() || '').slice('COPILOT_URL='.length).trim().replace(/^['"]|['"]$/g, '');
};

// CASES='[{"sub":"...","ff":"..."}]' overrides the default pair.
const CASES: Array<{ sub: string; ff: string }> = process.env.CASES ? JSON.parse(process.env.CASES) : [
    { sub: 'Wet Air Receiver', ff: 'Does not contain compressed wet air, loses containment' },
    { sub: 'Common Control, MCC and Instrumentation', ff: 'Does not issue trip command on protective demand' },
];

describe('live modes batch', () => {
    // BATCH='{"sub":"...","ffs":["..."]}' runs one subsystem's failures in one call, as MasterGen does.
    it.runIf(!!process.env.BATCH)('one subsystem batch', { timeout: 900000 }, async () => {
        const text = readFileSync(process.env.KNOWLEDGE_FILE!, 'utf8');
        const checklist = process.env.CHECKLIST_FILE ? readFileSync(process.env.CHECKLIST_FILE, 'utf8') : '';
        const b = JSON.parse(process.env.BATCH!);
        const card = findCardSubsystem(text, b.sub)!;
        const res = await AIService.generateModesForFailuresBatch({ project: 'Instrument Air Compressor Package in Thulailat', subName: b.sub, subSpecs: card.specs, subFunc: card.func, failures: b.ffs.map((desc: string, i: number) => ({ id: `f${i}`, desc })), key: '', modelName: '', mode: 'file', refText: text, aiProvider: 'copilot', checklistText: checklist, powerAutomateUrl: envUrl(), sessionId: `batch-${Date.now()}` });
        writeFileSync(`${process.env.OUT_DIR}/batch.json`, JSON.stringify(res.failures.map(f => ({ ff: b.ffs[Number(f.failureId.slice(1))], modes: f.modes.map((m: any) => ({ mode: m.mode, cause: m.cause, mitigation: m.mitigation })) })), null, 2));
    });
});

describe('live modes', () => {
    it.runIf(!process.env.BATCH)('with and without boundary', { timeout: 900000 }, async () => {
        const text = readFileSync(process.env.KNOWLEDGE_FILE!, 'utf8');
        const checklist = process.env.CHECKLIST_FILE ? readFileSync(process.env.CHECKLIST_FILE, 'utf8') : '';
        const url = envUrl();
        const out: any[] = [];
        await Promise.all(CASES.flatMap(c => {
            const card = findCardSubsystem(text, c.sub)!;
            return (process.env.ONLY_BOUNDARY ? [true] : [true, false]).map(async withBoundary => {
                // Without: a name the card lookup cannot match, same everything else.
                const name = withBoundary ? c.sub : `${c.sub} `.replace(/ $/, ' (unmatched)');
                const modes = await AIService.generateModesForFailure(c.ff, name, card.specs, card.func, 'Instrument Air Compressor Package in Thulailat', '', '', 'file', text, 'copilot', '', '', checklist, url, [], `modes-${Date.now()}-${withBoundary}`);
                out.push({ sub: c.sub, withBoundary, modes: modes.map((m: any) => ({ mode: m.mode, cause: m.cause, controls: m.currentControls, mitigation: m.mitigation })) });
            });
        }));
        writeFileSync(`${process.env.OUT_DIR}/modes.json`, JSON.stringify(out, null, 2));
    });
});
