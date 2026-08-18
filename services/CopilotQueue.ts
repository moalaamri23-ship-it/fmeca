/**
 * One turn at a time per Copilot conversation — and no fewer.
 *
 * Power Automate itself is not the constraint. An instant flow has Concurrency
 * Control OFF by default, which means unlimited concurrent runs, and the
 * platform tolerates roughly a thousand concurrent inbound calls before it
 * cares. Firing several requests at the flow at once is well inside what it is
 * built for.
 *
 * The constraint is the agent on the other side. A Copilot Studio Conversation
 * ID is a thread with a history, and two turns in flight on one thread
 * interleave: each request's prompt lands in the other's context, and both
 * answers get worse in ways nothing reports. Two sharper failures sit behind
 * that as well —
 *
 *   - a reply that looks like a lost session calls `rotateCopilotSession()`,
 *     which throws away the conversation other in-flight turns are still using;
 *   - the attachment ledger is a read-modify-write in localStorage, so parallel
 *     turns on one conversation each decide a file still needs uploading and
 *     then lose each other's writes.
 *
 * So the queue is per conversation, not global. Turns on the SAME conversation
 * are serialized, because that thread can only hold one. Turns on DIFFERENT
 * conversations run side by side, because the flow is happy to take them — which
 * is what lets several fields be cited at once, each on a conversation of its
 * own.
 */

/** Conversation id → tail of that conversation's queue. */
const tails = new Map<string, Promise<unknown>>();
/** Conversation id → turns queued or running on it. */
const depths = new Map<string, number>();

/**
 * Run `turn` once every turn already queued on `conversationId` has finished.
 *
 * A turn that throws does not break its queue: the chain continues from a
 * settled promise, so one failed request never strands the next one.
 */
export function runExclusive<T>(conversationId: string, turn: () => Promise<T>): Promise<T> {
    depths.set(conversationId, (depths.get(conversationId) ?? 0) + 1);
    const tail = tails.get(conversationId) ?? Promise.resolve();

    const result = tail.then(turn, turn);
    // The chain must not inherit this turn's rejection, or every later turn on
    // this conversation would reject with an error from someone else's request.
    tails.set(
        conversationId,
        result.then(
            () => undefined,
            () => undefined
        )
    );

    return result.finally(() => {
        const left = (depths.get(conversationId) ?? 1) - 1;
        if (left > 0) {
            depths.set(conversationId, left);
            return;
        }
        // Nothing left on this conversation — drop it, so a long session does
        // not accumulate an entry per citation run it ever made.
        depths.delete(conversationId);
        tails.delete(conversationId);
    });
}

/** Turns queued or running on one conversation. */
export const copilotQueueDepth = (conversationId: string): number => depths.get(conversationId) ?? 0;

/**
 * A conversation of this run's own.
 *
 * Work that is a burst of independent questions — citing a field against four
 * documents — has no use for the shared thread's history, and every reason not
 * to be stuck behind it. Its own id lets it run beside everything else.
 */
export const newConversationId = (): string => crypto.randomUUID();
