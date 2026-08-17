/**
 * One Copilot conversation for the whole app, and a ledger of what it already
 * holds.
 *
 * The Power Automate flow feeds `sessionId` to Execute Agent's Conversation ID,
 * and an agent thread keeps its attachments for the life of that conversation.
 * So a file uploaded once does not have to travel again — which is the only
 * reason sending real files is affordable at all: a scanned procedure costs
 * megabytes per question otherwise, multiplied again by every tool round.
 *
 * Two things make that safe rather than merely cheap:
 *
 *   1. The session is not forever. A Copilot Studio conversation expires on
 *      idle, and a file skipped after that has silently vanished from the
 *      agent's view — no error, no failed run, just a worse answer. So the
 *      session has an idle TTL and the ledger has a shorter resend window; both
 *      cost one upload after a quiet spell and remove that class of failure.
 *   2. A turn carrying a spreadsheet gets a conversation of its own. FileLM
 *      measured this against the production flow: once a conversation has
 *      carried a spreadsheet, every later request on that Conversation ID comes
 *      back "Error code: SystemError" — a plain text follow-up as readily as
 *      another upload. The conversation is finished, not the file state. A
 *      throwaway id per spreadsheet turn keeps the shared session alive.
 *
 * Ported from FileLM's copilot-helper ledger, with one difference the app asked
 * for: FileLM keys a thread per set of files, this keeps ONE session for every
 * call so nothing is ever re-attached inside its active period.
 */

const SESSION_KEY = 'fmeca_copilot_session_v1';
const LEDGER_KEY = 'fmeca_copilot_ledger_v1';

/**
 * Idle window before the conversation is assumed gone. Copilot Studio idles a
 * conversation out around 30 minutes; staying under that means the app rotates
 * before the agent does, so a rotation is never a surprise mid-answer.
 */
const SESSION_IDLE_MS = 25 * 60 * 1000;
/** Absolute lifetime, however busy — a very long session drifts in context. */
const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/**
 * Resend window for one attachment. Deliberately shorter than the session's own
 * idle TTL: the cost of being wrong here is an answer about a document the agent
 * cannot see, and the cost of being early is one upload.
 */
const ATTACHMENT_RESEND_AFTER_MS = 10 * 60 * 1000;
/** Ledger entries kept before the oldest is dropped. Forgetting only re-sends. */
const LEDGER_LIMIT = 64;

export interface CopilotAttachment {
    name: string;
    contentType: string;
    /** Raw base64 only (no data URL prefix), ready for Power Automate file inputs. */
    contentBytes: string;
}

interface SessionRecord {
    id: string;
    startedAt: number;
    lastUsedAt: number;
}

/** attachment key → when the flow last accepted it. */
type Ledger = Record<string, number>;

function readJson<T>(key: string): T | null {
    try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // A full or blocked store only costs re-attachment, never correctness.
    }
}

function readLedger(): Ledger {
    return readJson<Ledger>(LEDGER_KEY) ?? {};
}

/** True when this record can still be the agent's live conversation. */
function isLive(record: SessionRecord, now: number): boolean {
    return now - record.lastUsedAt < SESSION_IDLE_MS && now - record.startedAt < SESSION_MAX_MS;
}

/**
 * The current conversation id, starting one if there is none and replacing it
 * when it has expired. Every call touches it, so an active app keeps its thread.
 *
 * `oneShot` returns a conversation used once and abandoned — for the turns that
 * are known to finish a conversation (a spreadsheet upload).
 */
export function copilotSessionId(options: { oneShot?: boolean } = {}): string {
    if (options.oneShot) return crypto.randomUUID();

    const now = Date.now();
    const current = readJson<SessionRecord>(SESSION_KEY);
    if (current?.id && isLive(current, now)) {
        writeJson(SESSION_KEY, { ...current, lastUsedAt: now });
        return current.id;
    }

    // Expired or absent: a new conversation holds nothing, so the ledger of what
    // the old one held has to go with it.
    const fresh: SessionRecord = { id: crypto.randomUUID(), startedAt: now, lastUsedAt: now };
    writeJson(SESSION_KEY, fresh);
    writeJson(LEDGER_KEY, {});
    return fresh.id;
}

/**
 * Abandon the current conversation. Called when the agent's reply shows it has
 * lost the thread, so the retry starts clean and re-attaches everything.
 */
export function rotateCopilotSession(): string {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch {
        /* falls through to a fresh record below */
    }
    writeJson(LEDGER_KEY, {});
    return copilotSessionId();
}

/** How long the live conversation has left before it is assumed gone, in ms. */
export function copilotSessionAge(): { id: string | null; idleMs: number; ageMs: number } {
    const record = readJson<SessionRecord>(SESSION_KEY);
    if (!record) return { id: null, idleMs: 0, ageMs: 0 };
    const now = Date.now();
    return { id: record.id, idleMs: now - record.lastUsedAt, ageMs: now - record.startedAt };
}

// Byte length is part of the key so an edited or re-imported file counts as new
// and goes again, rather than being mistaken for the copy already in the thread.
function attachmentKey(attachment: CopilotAttachment): string {
    return `${attachment.name}:${attachment.contentType}:${attachment.contentBytes.length}`;
}

/**
 * The attachments this turn actually has to upload: everything the agent's
 * current conversation is not already holding a fresh copy of.
 */
export function pendingAttachments(
    attachments: CopilotAttachment[],
    now: number = Date.now()
): CopilotAttachment[] {
    const ledger = readLedger();
    return attachments.filter(attachment => {
        const sentAt = ledger[attachmentKey(attachment)];
        return sentAt == null || now - sentAt >= ATTACHMENT_RESEND_AFTER_MS;
    });
}

/**
 * Record attachments the flow accepted. Called only after a successful request —
 * a failed one never reached the agent, so it must not suppress the next try.
 */
export function markAttachmentsSent(attachments: CopilotAttachment[], now: number = Date.now()): void {
    if (attachments.length === 0) return;
    const ledger = readLedger();
    for (const attachment of attachments) ledger[attachmentKey(attachment)] = now;

    const keys = Object.keys(ledger);
    if (keys.length > LEDGER_LIMIT) {
        // Oldest first, since forgetting an entry only ever costs a re-send.
        keys.sort((a, b) => ledger[a] - ledger[b])
            .slice(0, keys.length - LEDGER_LIMIT)
            .forEach(key => delete ledger[key]);
    }
    writeJson(LEDGER_KEY, ledger);
}

/** Forget everything the conversation was holding. Only ever forces a re-send. */
export function forgetSentAttachments(): void {
    writeJson(LEDGER_KEY, {});
}

const SPREADSHEET_FILE = /\.(?:csv|xlsx|xlsm|xls)$/i;

/** True when an attachment set contains a spreadsheet, which ends a conversation. */
export function carriesSpreadsheet(attachments: CopilotAttachment[]): boolean {
    return attachments.some(a => SPREADSHEET_FILE.test(a.name));
}

// What a lost conversation looks like coming back: either the agent says it
// cannot see the file, or the flow returns the agent's own error as the body
// (Power Automate reports the run as Succeeded either way, so nothing but the
// text tells us). Both are worth one clean retry with everything re-attached.
const LOST_SESSION_PATTERNS = [
    /error code:\s*systemerror/i,
    /\bconversation\b[^.]{0,40}\b(?:not found|expired|no longer)\b/i,
    /\bsession\b[^.]{0,40}\b(?:not found|expired|invalid)\b/i,
    /\b(?:i|we)\s+(?:can(?:'|no)?t|do(?:n'|\s+no)?t)\s+(?:see|have|find|access)\b[^.]{0,40}\b(?:file|document|attachment|image)/i,
    /\bno\s+(?:file|document|attachment)s?\s+(?:were\s+)?(?:attached|provided|available)/i,
];

/**
 * Whether a reply suggests the agent no longer holds what it was sent — the one
 * signal available while the flow returns a bare string.
 *
 * A flow that returns `{ reply, sessionFound }` would make this a fact instead of
 * an inference; until then this is deliberately narrow, because a false positive
 * costs a re-upload and a retry.
 */
export function looksLikeLostSession(reply: string): boolean {
    const text = (reply || '').slice(0, 2000);
    return LOST_SESSION_PATTERNS.some(re => re.test(text));
}
