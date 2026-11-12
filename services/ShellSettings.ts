/**
 * Shared settings from Reliability Shell.
 *
 * The engineer enters the OXY Connection Flow URL and their company email once, in
 * the shell's Settings. Every built-in app runs on its own origin and cannot read the
 * shell's storage, so the values come over postMessage:
 *
 *   app   → shell : { cfg: 'request' }                       on load
 *   shell → app   : { cfg: 'settings', aiRouterUrl?, engineerEmail? }
 *
 * The shell also pushes `settings` again whenever the engineer saves. A filled shell
 * value replaces the app's own (so rotating the URL in the shell reaches every app);
 * a field the shell leaves blank is not sent and the app keeps its value.
 *
 * Only the shell may set these: the flow URL decides where the app sends its data, so
 * a message from any other parent is ignored. Standalone, nothing is asked.
 */

export interface ShellSettings {
    aiRouterUrl?: string;
    engineerEmail?: string;
}

const SHELL_ORIGINS = new Set(['https://relshell.moalaamri23.workers.dev']);

/** The deployed shell, or a shell run locally while developing it. */
const isShellOrigin = (origin: string) =>
    SHELL_ORIGINS.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

/**
 * Ask the shell for its settings and apply each reply. Returns the unsubscribe.
 * `apply` receives only the fields the shell filled, already checked.
 */
export function listenForShellSettings(apply: (settings: ShellSettings) => void): () => void {
    if (typeof window === 'undefined' || window.parent === window) return () => {};

    const onMessage = (event: MessageEvent) => {
        if (event.source !== window.parent || !isShellOrigin(event.origin)) return;
        const data = event.data as { cfg?: unknown; aiRouterUrl?: unknown; engineerEmail?: unknown } | null;
        if (!data || data.cfg !== 'settings') return;

        const settings: ShellSettings = {};
        const url = typeof data.aiRouterUrl === 'string' ? data.aiRouterUrl.trim() : '';
        if (/^https:\/\/\S+$/i.test(url)) settings.aiRouterUrl = url;
        const email = typeof data.engineerEmail === 'string' ? data.engineerEmail.trim() : '';
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) settings.engineerEmail = email;

        if (settings.aiRouterUrl || settings.engineerEmail) apply(settings);
    };

    window.addEventListener('message', onMessage);
    // The request carries nothing, so any parent may see it; only the shell's reply is used.
    window.parent.postMessage({ cfg: 'request' }, '*');
    return () => window.removeEventListener('message', onMessage);
}
