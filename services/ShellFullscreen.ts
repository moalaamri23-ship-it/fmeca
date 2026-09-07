// Fullscreen handoff for when FMECA Studio runs inside a host shell.
//
// Chromium refuses to grant fullscreen to a cross-origin frame while the
// embedding document already holds fullscreen itself. The request does not
// reject — it simply never settles, and no fullscreenerror fires, so the button
// looks dead. Releasing the host's fullscreen afterwards does not revive it
// either: the request has to be made while no ancestor is fullscreen.
//
// So the frame asks first and requests second. Transient activation survives
// the postMessage round-trip, so the request still counts as user-initiated.
//
//   frame → host : { fs: 'request' }    from the click, before requesting
//   host  → frame: { fs: 'clear' }      once the host has left fullscreen
//   frame → host : { fs: 'released' }   when this frame leaves fullscreen
//
// A host that does not speak this protocol simply never replies; the timeout
// then requests anyway, which is exactly the old behaviour.

import { IN_IFRAME } from './FsBridge';

/** How long to wait for the host before giving up and requesting regardless. */
const HOST_REPLY_TIMEOUT_MS = 400;

/**
 * Enter fullscreen, standing the host down first when embedded.
 *
 * Must be called during a user gesture, like requestFullscreen itself: the
 * activation has to still be live when the host's reply comes back.
 */
export function requestFullscreenViaHost(element: Element): Promise<void> {
    if (!IN_IFRAME) return element.requestFullscreen();

    return new Promise<void>((resolve, reject) => {
        let requested = false;

        const request = () => {
            if (requested) return;
            requested = true;
            window.removeEventListener('message', onMessage);
            window.clearTimeout(timer);
            element.requestFullscreen().then(resolve, reject);
        };

        const onMessage = (event: MessageEvent) => {
            if (event.source !== window.parent) return;
            const data = event.data as { fs?: string } | null;
            if (!data || data.fs !== 'clear') return;
            request();
        };

        window.addEventListener('message', onMessage);
        const timer = window.setTimeout(request, HOST_REPLY_TIMEOUT_MS);
        // The host's origin is not known here, and the message carries nothing
        // worth protecting.
        window.parent.postMessage({ fs: 'request' }, '*');
    });
}

/**
 * Tell the host this frame is out of fullscreen, so it can take its own back.
 *
 * Only useful when the frame left fullscreen from a click: the host needs the
 * activation that propagates from it. After Esc the browser has already dropped
 * every level anyway.
 */
export function notifyHostFullscreenReleased(): void {
    if (!IN_IFRAME) return;
    window.parent.postMessage({ fs: 'released' }, '*');
}
