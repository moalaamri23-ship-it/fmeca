import { describe, it, expect } from 'vitest';
import { routeFlowCall, hasFlowRoute } from '../AIRouter';

describe('OXY Connection Flow routing', () => {
    it('sends the body unchanged plus its task', () => {
        const body = { action: 'list', site: 's', list: 'l' };
        const route = routeFlowCall(' https://flow.example/x ', 'sp_read', body);
        expect(route.url).toBe('https://flow.example/x');
        expect(route.body).toEqual({ ...body, task: 'sp_read' });
        expect(body).not.toHaveProperty('task');
    });

    it('adds the chat target', () => {
        const route = routeFlowCall('https://flow.example/x', 'chat', { sessionId: 'a', prompt: 'p' }, 'flow');
        expect(route.body).toEqual({ sessionId: 'a', prompt: 'p', task: 'chat', target: 'flow' });
    });

    it('has no fallback: an empty setting means no route', () => {
        expect(hasFlowRoute('')).toBe(false);
        expect(hasFlowRoute('   ')).toBe(false);
        expect(hasFlowRoute(undefined)).toBe(false);
        expect(hasFlowRoute('https://flow.example/x')).toBe(true);
    });
});
