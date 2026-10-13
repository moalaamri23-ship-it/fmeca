import { FailedStateType, FailureShape } from '../types';

export const FAILURE_SHAPES: FailureShape[] = ['binary', 'below', 'above', 'band', 'conformance', 'protective'];

/**
 * The failed states a function of this shape can physically reach.
 *
 * Failed states used to be produced per parameter: a row holding power and speed
 * came back as total + power below + speed below + erratic, whatever the
 * equipment could do. The shape is declared per function by the breakdown step,
 * where the physics is in view, and this table turns it into the states the FF
 * step may write -- one failure per state, never one per parameter.
 *
 * A hidden function's total loss is only discovered on demand, so "total"
 * becomes "on_demand" for it (JA1011 5.2), the same substitution the FF prompt
 * already makes.
 */
export function allowedFailedStates(shape: FailureShape | undefined, evidence: 'evident' | 'hidden' | undefined): FailedStateType[] | null {
    if (!shape) return null;
    const loss: FailedStateType = evidence === 'hidden' ? 'on_demand' : 'total';
    switch (shape) {
        // Done or not done; there is no "less" of it.
        case 'binary': return [loss];
        // Delivers an amount that can fall short.
        case 'below': return [loss, 'partial'];
        // Must keep something under a limit; only exceeding it is a failure.
        case 'above': return ['upper_limit'];
        // Holds a variable at a setpoint: too low and too high both matter, and a
        // loop that hunts is a third distinct state. "Does not control at all" is
        // one of the two directions, never a fourth row.
        case 'band': return ['partial', 'upper_limit', 'intermittent'];
        // Meets a grade or not.
        case 'conformance': return ['partial'];
        // Acts on demand: fails to act, or acts when it should not (spurious trip).
        case 'protective': return [loss === 'total' ? 'total' : 'on_demand', 'upper_limit'];
    }
    return null;
}

export function normalizeFailureShape(value: unknown): FailureShape | undefined {
    const v = String(value ?? '').toLowerCase().trim() as FailureShape;
    return FAILURE_SHAPES.includes(v) ? v : undefined;
}
