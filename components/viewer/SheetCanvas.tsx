import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx-js-style';
import { cn } from './util';
import { JumpToInput } from './JumpToInput';
import { scrollElementToTop } from './viewerScroll';
import { useSearchTarget } from './searchContext';
import { MAX_MATCHES, valueMatches } from './textSearch';
import type { ViewerCitation } from '../../types';

const MAX_ROWS = 2000;
const MAX_COLS = 60;

interface Sheet {
    name: string;
    rows: unknown[][];
    truncated: boolean;
}

function normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Words worth matching a cell against — drops noise from a long anchor. */
function anchorTerms(anchor: string): string[] {
    return normalize(anchor)
        .split(' ')
        .filter(w => w.length > 2)
        .slice(0, 12);
}

function readWorkbook(bytes: ArrayBuffer): { sheets: Sheet[]; error: string | null } {
    try {
        const wb = XLSX.read(bytes.slice(0), { type: 'array', cellDates: true });
        const sheets = wb.SheetNames.map((name: string) => {
            const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null });
            return {
                name,
                rows: grid.slice(0, MAX_ROWS).map(row => row.slice(0, MAX_COLS)),
                truncated: grid.length > MAX_ROWS,
            };
        });
        return { sheets, error: null };
    } catch (e) {
        return { sheets: [], error: e instanceof Error ? e.message : String(e) };
    }
}

interface Matches {
    sheet: number;
    cells: Set<string>;
    firstCell: string;
}

/** Spreadsheets render as their real grid; matching cells are highlighted. */
export const SheetCanvas: React.FC<{ bytes: ArrayBuffer; citation: ViewerCitation | null }> = ({ bytes, citation }) => {
    const hitRef = useRef<HTMLTableCellElement | null>(null);
    const searchRef = useRef<HTMLTableCellElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [picked, setPicked] = useState<{ key: string; index: number } | null>(null);
    const { terms: searchTerms, active, report } = useSearchTarget();

    const anchor = citation?.quote?.trim() || citation?.anchor?.trim() || '';
    const citationKey = `${citation?.id ?? ''}:${anchor}`;

    const { sheets, error } = useMemo(() => readWorkbook(bytes), [bytes]);

    // Cells containing the query, sheet by sheet, in reading order.
    const searchHits = useMemo(() => {
        const found: { sheet: number; row: number; col: number }[] = [];
        if (searchTerms.length === 0) return found;
        for (const [sheet, s] of sheets.entries()) {
            for (const [row, cells] of s.rows.entries()) {
                for (const [col, cell] of cells.entries()) {
                    if (cell == null) continue;
                    if (!valueMatches(String(cell), searchTerms)) continue;
                    found.push({ sheet, row, col });
                    if (found.length >= MAX_MATCHES) return found;
                }
            }
        }
        return found;
    }, [sheets, searchTerms]);

    useEffect(() => report(searchHits.length), [searchHits, report]);

    const currentHit = searchHits[active] ?? null;

    // Which cells match the cited text, and on which sheet.
    const matches = useMemo<Matches | null>(() => {
        if (sheets.length === 0 || !anchor) return null;
        const terms = anchorTerms(anchor);
        const needle = normalize(anchor);
        if (terms.length === 0) return null;

        let best: Matches | null = null;
        sheets.forEach((sheet, sheetIndex) => {
            const cells = new Set<string>();
            let firstCell = '';
            sheet.rows.forEach((row, r) => {
                row.forEach((cell, c) => {
                    if (cell == null) return;
                    const value = normalize(String(cell));
                    if (value.length <= 2) return;
                    const hit = needle.includes(value) || value.includes(needle) || terms.some(t => value === t);
                    if (!hit) return;
                    const key = `${r}:${c}`;
                    cells.add(key);
                    if (!firstCell) firstCell = key;
                });
            });
            if (cells.size === 0) return;
            // Keep only the row that matches best — a long anchor also brushes
            // single words in unrelated rows, and highlighting those is just noise.
            const perRow = new Map<number, string[]>();
            for (const key of cells) {
                const row = Number(key.split(':')[0]);
                perRow.set(row, [...(perRow.get(row) ?? []), key]);
            }
            const bestRow = [...perRow.entries()].sort((a, b) => b[1].length - a[1].length)[0];
            const rowCells = new Set(bestRow[1]);
            firstCell = bestRow[1][0];
            if (!best || rowCells.size > best.cells.size) {
                best = { sheet: sheetIndex, cells: rowCells, firstCell };
            }
        });
        return best;
    }, [sheets, anchor]);

    // The match being searched for wins; otherwise a sheet the user clicked, but
    // only for the citation they clicked it on.
    const activeSheet = currentHit?.sheet ?? (picked?.key === citationKey ? picked.index : matches?.sheet ?? 0);

    const sheetHits = useMemo(
        () => new Set(searchHits.filter(hit => hit.sheet === activeSheet).map(hit => `${hit.row}:${hit.col}`)),
        [searchHits, activeSheet]
    );

    useEffect(() => {
        if (currentHit) return;
        hitRef.current?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }, [matches, activeSheet, currentHit]);

    useEffect(() => {
        if (!currentHit) return;
        searchRef.current?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }, [currentHit]);

    if (error) {
        return (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-slate-400">
                This spreadsheet could not be rendered ({error}).
            </div>
        );
    }

    const sheet = sheets[activeSheet];
    const highlightHere = matches && matches.sheet === activeSheet ? matches : null;

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 px-3 py-1.5">
                {sheets.map((s, i) => (
                    <button
                        key={s.name}
                        onClick={() => setPicked({ key: citationKey, index: i })}
                        className={cn(
                            'shrink-0 rounded px-2 py-0.5 text-[11px] font-bold transition',
                            i === activeSheet ? 'bg-brand-50 text-brand-700' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                        )}
                    >
                        {s.name}
                    </button>
                ))}
                {highlightHere && searchHits.length === 0 && (
                    <span className="ml-2 shrink-0 rounded-full bg-yellow-100 px-2 py-0.5 text-[10px] font-mono text-yellow-800">
                        {highlightHere.cells.size} cell{highlightHere.cells.size > 1 ? 's' : ''} highlighted
                    </span>
                )}
                {searchHits.length > 0 && (
                    <span className="ml-2 shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-mono text-orange-800">
                        {searchHits.length} matching cell{searchHits.length > 1 ? 's' : ''}
                    </span>
                )}
                <div className="ml-2">
                    {/* Row numbers are rendered in the gutter, so the typed number
                        is the one the reader can already see. */}
                    <JumpToInput
                        unit="row"
                        max={sheet?.rows.length ?? 0}
                        onJump={row =>
                            scrollElementToTop(scrollRef.current, scrollRef.current?.querySelector(`tr[data-row="${row}"]`))
                        }
                    />
                </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-auto scroll-thin bg-slate-100 p-3">
                {!sheet || sheet.rows.length === 0 ? (
                    <p className="p-4 text-xs text-slate-400 italic">This sheet is empty.</p>
                ) : (
                    <table className="border-collapse bg-white text-[11px]">
                        <tbody>
                            {sheet.rows.map((row, r) => (
                                <tr key={r} data-row={r + 1}>
                                    <td className="sticky left-0 z-10 border border-slate-200 bg-slate-100 px-2 py-1 text-right font-mono text-[10px] text-slate-400">
                                        {r + 1}
                                    </td>
                                    {row.map((cell, c) => {
                                        const key = `${r}:${c}`;
                                        const isHit = !!highlightHere?.cells.has(key);
                                        const isMatch = sheetHits.has(key);
                                        const isCurrent =
                                            !!currentHit && currentHit.sheet === activeSheet && currentHit.row === r && currentHit.col === c;
                                        return (
                                            <td
                                                key={c}
                                                ref={isCurrent ? searchRef : highlightHere?.firstCell === key ? hitRef : undefined}
                                                className="max-w-[280px] truncate border border-slate-200 px-2 py-1 align-top text-slate-700"
                                                style={
                                                    isCurrent
                                                        ? { background: 'rgba(251,146,60,0.6)', outline: '1px solid rgb(234,88,12)', fontWeight: 500 }
                                                        : isMatch
                                                          ? { background: 'rgba(253,186,116,0.35)' }
                                                          : isHit
                                                            ? { background: 'rgba(253,224,71,0.6)', outline: '1px solid rgba(234,179,8,0.6)', fontWeight: 500 }
                                                            : undefined
                                                }
                                                title={cell == null ? '' : String(cell)}
                                            >
                                                {cell == null ? '' : String(cell)}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {sheet?.truncated && (
                    <p className="mt-2 text-[10px] font-mono text-slate-400">
                        Showing the first {MAX_ROWS} rows of this sheet.
                    </p>
                )}
            </div>
        </div>
    );
};
