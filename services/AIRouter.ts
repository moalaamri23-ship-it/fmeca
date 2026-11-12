/**
 * OXY Connection Flow — one signed Power Automate URL that fronts every flow the app calls.
 *
 * Every flow call goes to that URL with its own body plus `task` (and `target` for chat);
 * the flow strips both before forwarding and returns the target flow's status, content
 * type and body unchanged. There is no per-flow URL any more.
 *
 * The AI layer still takes the URL as `powerAutomateUrl`: that parameter now carries the
 * OXY Connection Flow URL.
 */

/** localStorage key of the "OXY Connection Flow URL" setting (kept so saved values survive). */
export const AI_ROUTER_URL_KEY = 'fmeca_ai_router_url';

/** Tasks this app uses. Tasks are defined by the flow, not here. */
export type RouterTask = 'chat' | 'sp_read' | 'sp_register' | 'sp_files' | 'sp_files_child';

/** Where a `chat` task is forwarded: `flow` is the classic AI flow (attachments, session memory). */
export type ChatTarget = 'agent' | 'flow' | 'light';

/** Message shown when a flow call is attempted without the setting. */
export const MISSING_FLOW_URL = 'Set the OXY Connection Flow URL in Settings.';

/** True when the OXY Connection Flow URL is set. */
export function hasFlowRoute(flowUrl: string | undefined): boolean {
    return !!(flowUrl && flowUrl.trim());
}

/** URL and body for one flow call: the call's own body plus `task` (and `target` for chat). */
export function routeFlowCall<T extends object>(
    flowUrl: string | undefined,
    task: RouterTask,
    body: T,
    target?: ChatTarget,
): { url: string; body: T & { task: RouterTask; target?: ChatTarget } } {
    return { url: (flowUrl || '').trim(), body: { ...body, task, ...(target ? { target } : {}) } };
}
