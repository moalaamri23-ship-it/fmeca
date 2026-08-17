/**
 * Scroll `el` to the top of its scroll container.
 *
 * Not scrollIntoView: these canvases scroll horizontally too (a wide sheet), and
 * scrollIntoView would yank the view sideways as well as down.
 */
export function scrollElementToTop(
    scroller: HTMLElement | null,
    el: Element | null | undefined,
    margin = 8
): void {
    if (!scroller || !el) return;
    scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin;
}
