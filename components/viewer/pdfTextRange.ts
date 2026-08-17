export interface TextRangeFractions {
    from: number;
    to: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}

/** Map a substring to horizontal fractions using rendered glyph advances. */
export function textRangeFractions(
    text: string,
    start: number,
    end: number,
    measureWidth?: (value: string) => number,
    direction: 'ltr' | 'rtl' = 'ltr'
): TextRangeFractions {
    const length = text.length || 1;
    const startIndex = clamp(start, 0, text.length);
    const endIndex = clamp(end, startIndex, text.length);
    const linear = { from: startIndex / length, to: endIndex / length };
    if (!measureWidth || !text) return linear;

    const total = measureWidth(text);
    const before = measureWidth(text.slice(0, startIndex));
    const through = measureWidth(text.slice(0, endIndex));
    if (![total, before, through].every(Number.isFinite) || total <= 0 || through < before) {
        return linear;
    }

    if (direction === 'rtl') {
        return {
            from: clamp(1 - through / total, 0, 1),
            to: clamp(1 - before / total, 0, 1),
        };
    }
    return {
        from: clamp(before / total, 0, 1),
        to: clamp(through / total, 0, 1),
    };
}
