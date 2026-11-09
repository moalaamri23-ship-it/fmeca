/**
 * AI Router — one signed Power Automate URL that fronts every flow the app calls.
 *
 * When the "AI Router URL" setting is filled, a flow call goes to the router with the
 * same body plus `task` (and `target` for chat); the router strips both before
 * forwarding and returns the target flow's status, content type and body unchanged.
 * When the setting is empty, the call goes to its own flow URL exactly as before.
 */

export const AI_ROUTER_URL_KEY = 'fmeca_ai_router_url';

/** Router tasks this app uses. Tasks are defined by the router, not here. */
export type RouterTask = 'chat' | 'sp_read' | 'sp_register';

/** Where a `chat` task is forwarded: the classic AI flow (attachments, session memory). */
export type ChatTarget = 'agent' | 'flow' | 'light';

/** The router URL from Settings, or '' when not set. Read at call time. */
export function getAiRouterUrl(): string {
    try {
        return (localStorage.getItem(AI_ROUTER_URL_KEY) || '').trim();
    } catch {
        return '';
    }
}

/** True when the call can be made: either its own flow URL or the router is set. */
export function hasFlowRoute(directUrl: string | undefined): boolean {
    return !!(directUrl && directUrl.trim()) || !!getAiRouterUrl();
}

/**
 * Picks the URL and body for one flow call. The body is the call's own body unchanged;
 * through the router it only gains `task` (and `target` for chat).
 */
export function routeFlowCall<T extends object>(
    directUrl: string | undefined,
    task: RouterTask,
    body: T,
    target?: ChatTarget,
): { url: string; body: T | (T & { task: RouterTask; target?: ChatTarget }) } {
    const router = getAiRouterUrl();
    if (!router) return { url: (directUrl || '').trim(), body };
    return { url: router, body: { ...body, task, ...(target ? { target } : {}) } };
}
