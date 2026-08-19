import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { CHANNEL } from './services/FsBridge';

/**
 * Never boot the app inside a window opened for the folder helper.
 *
 * The site answers a path it cannot find with the app shell rather than a 404,
 * so a request for /folder-picker.html that misses — the asset absent from a
 * deployment, an embedder serving the app under its own root, a stale cached
 * fallback — comes back as FMECA Studio. The popup then shows the whole app in
 * a 480×360 window while the opener waits for a handshake that can never come.
 *
 * The window's name says what it was opened to be, so the app can tell the
 * opener that its helper never loaded and get out of the way. Costs the real
 * helper nothing: it is a different page, and never runs this.
 */
function reportHijackedHelperWindow(): boolean {
    if (!window.opener || !window.name.startsWith(CHANNEL)) return false;

    const params = new URLSearchParams(window.location.search);
    const message =
        'The folder helper page did not load — the app opened in its place. Reload FMECA Studio and try again.';
    // Shaped as the window it stood in for would have reported the failure:
    // a bridge session speaks in sessions, the plain picker in outcomes.
    const payload =
        params.get('mode') === 'bridge'
            ? { source: CHANNEL, bridge: true, session: params.get('session') || '', type: 'error', name: 'NotFoundError', message }
            : { source: CHANNEL, ok: false, name: 'NotFoundError', message };

    try {
        window.opener.postMessage(payload, window.location.origin);
    } catch {
        // Nothing left to tell it with — the window closing is the only signal
        // the app still gets, and it treats that as a cancel.
    }
    window.setTimeout(() => window.close(), 60);
    return true;
}

if (!reportHijackedHelperWindow()) {
    const rootElement = document.getElementById('root');
    if (!rootElement) {
        throw new Error("Could not find root element to mount to");
    }

    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    );
}
