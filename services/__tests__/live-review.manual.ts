/**
 * Manual live check of the knowledge-card review (one call).
 *   KNOWLEDGE_FILE=<path> OUT_DIR=<dir> npm run test:live -- live-review
 */
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AIService } from '../AIService';
import { reviewKnowledge, dutyCandidates } from '../CardReview';

const envUrl = () => {
    if (process.env.COPILOT_URL) return process.env.COPILOT_URL;
    if (!existsSync('.env.local')) return '';
    const lines = readFileSync('.env.local', 'utf8').split('\n').filter(l => l.startsWith('COPILOT_URL='));
    return (lines.pop() || '').slice('COPILOT_URL='.length).trim().replace(/^['"]|['"]$/g, '');
};

describe('live card review', () => {
    it('selects missing duties', { timeout: 900000 }, async () => {
        const text = readFileSync(process.env.KNOWLEDGE_FILE!, 'utf8');
        const flags = reviewKnowledge(text);
        const missing = await AIService.selectMissingDuties({ cards: dutyCandidates(text, flags), key: '', modelName: '', aiProvider: 'copilot', powerAutomateUrl: envUrl(), sessionId: `review-${Date.now()}` });
        const byId = new Map(flags.map(f => [f.id, f]));
        writeFileSync(`${process.env.OUT_DIR}/review.json`, JSON.stringify(missing.map(m => ({ ...m, flag: byId.get(m.id) })), null, 2));
    });
});
