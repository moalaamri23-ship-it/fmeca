export interface SystemMode {
    component: string;
    mode: string;
    count: number;
}

export interface SystemModeGroup {
    component: string;
    totalOccurrences: number;
    modes: SystemMode[];
}

export interface SystemModesImportSummary {
    sourceRows: number;
    acceptedRows: number;
    componentGroups: number;
    uniqueModes: number;
    duplicateRows: number;
    skippedBlankComponent: number;
    skippedBlankMode: number;
    skippedInvalidOccurrences: number;
}

export interface SubsystemModeTarget {
    name: string;
    specs?: string;
    func?: string;
}

export interface ParsedSystemModes {
    modes: SystemMode[];
    groups: SystemModeGroup[];
    summary: SystemModesImportSummary;
}

const CONTEXT_CHARACTER_LIMIT = 8000;
const MAX_MATCHED_COMPONENTS = 3;
const GENERIC_COMPONENT_WORDS = new Set([
    'system', 'subsystem', 'unit', 'package', 'assembly', 'equipment', 'machine',
    'train', 'skid', 'auxiliary', 'main', 'the', 'and', 'for', 'with', 'from',
]);

export const normalizeSystemModeKey = (value: unknown): string => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeHeaderKey = (value: unknown): string => normalizeSystemModeKey(value).replace(/\s+/g, '');

const meaningfulTokens = (value: unknown): string[] => normalizeSystemModeKey(value)
    .split(' ')
    .filter(token => token.length > 1 && !GENERIC_COMPONENT_WORDS.has(token));

export const sanitizeStoredSystemModes = (value: unknown): SystemMode[] => {
    if (!Array.isArray(value)) return [];
    return value
        .map((row: any) => ({
            component: String(row?.component ?? '').trim(),
            mode: String(row?.mode ?? '').trim(),
            count: Number(row?.count),
        }))
        .filter(row => row.component && row.mode && Number.isFinite(row.count) && row.count >= 1)
        .map(row => ({ ...row, count: Math.trunc(row.count) }));
};

export const parseSystemModesRows = (rows: unknown[][]): ParsedSystemModes => {
    const headerSearch = rows.slice(0, 10);
    let headerRowIndex = -1;
    let componentColumn = -1;
    let modeColumn = -1;
    let occurrencesColumn = -1;

    headerSearch.some((row, rowIndex) => {
        const headers = Array.isArray(row) ? row.map(normalizeHeaderKey) : [];
        const nextComponent = headers.findIndex(header => header === 'component');
        const nextMode = headers.findIndex(header => header === 'failuremodefailedstate' || header === 'failuremode');
        const nextOccurrences = headers.findIndex(header => header === 'occurrences' || header === 'occurrence');
        if (nextComponent < 0 || nextMode < 0 || nextOccurrences < 0) return false;
        headerRowIndex = rowIndex;
        componentColumn = nextComponent;
        modeColumn = nextMode;
        occurrencesColumn = nextOccurrences;
        return true;
    });

    if (headerRowIndex < 0) {
        throw new Error('Required headings not found: Component, Failure Mode (Failed State), Occurrences.');
    }

    const dataRows = rows
        .slice(headerRowIndex + 1)
        .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim()));
    const validRows: SystemMode[] = [];
    let skippedBlankComponent = 0;
    let skippedBlankMode = 0;
    let skippedInvalidOccurrences = 0;

    dataRows.forEach(row => {
        const component = String(row[componentColumn] ?? '').trim();
        const mode = String(row[modeColumn] ?? '').trim();
        const rawCount = String(row[occurrencesColumn] ?? '').replace(/,/g, '').trim();
        const numericCount = Number(rawCount);
        const count = Math.trunc(numericCount);
        if (!component) { skippedBlankComponent += 1; return; }
        if (!mode) { skippedBlankMode += 1; return; }
        if (!Number.isFinite(numericCount) || count < 1) { skippedInvalidOccurrences += 1; return; }
        validRows.push({ component, mode, count });
    });

    const aggregated = aggregateSystemModes(validRows);
    return {
        modes: aggregated.modes,
        groups: aggregated.groups,
        summary: {
            sourceRows: dataRows.length,
            acceptedRows: validRows.length,
            componentGroups: aggregated.groups.length,
            uniqueModes: aggregated.modes.length,
            duplicateRows: aggregated.duplicateRows,
            skippedBlankComponent,
            skippedBlankMode,
            skippedInvalidOccurrences,
        },
    };
};

export const groupSystemModes = (rows: SystemMode[]): SystemModeGroup[] => {
    const components = new Map<string, {
        component: string;
        modes: Map<string, SystemMode>;
    }>();

    sanitizeStoredSystemModes(rows).forEach(row => {
        const componentKey = normalizeSystemModeKey(row.component);
        const modeKey = normalizeSystemModeKey(row.mode);
        if (!componentKey || !modeKey) return;

        let group = components.get(componentKey);
        if (!group) {
            group = { component: row.component, modes: new Map() };
            components.set(componentKey, group);
        }

        const existing = group.modes.get(modeKey);
        if (existing) existing.count += row.count;
        else group.modes.set(modeKey, { ...row, component: group.component });
    });

    return [...components.values()]
        .map(group => {
            const modes = [...group.modes.values()].sort((a, b) => b.count - a.count || a.mode.localeCompare(b.mode));
            return {
                component: group.component,
                totalOccurrences: modes.reduce((sum, mode) => sum + mode.count, 0),
                modes,
            };
        })
        .sort((a, b) => b.totalOccurrences - a.totalOccurrences || a.component.localeCompare(b.component));
};

export const aggregateSystemModes = (rows: SystemMode[]): { modes: SystemMode[]; groups: SystemModeGroup[]; duplicateRows: number } => {
    const cleanRows = sanitizeStoredSystemModes(rows);
    const groups = groupSystemModes(cleanRows);
    const modes = groups.flatMap(group => group.modes);
    return {
        modes,
        groups,
        duplicateRows: Math.max(0, cleanRows.length - modes.length),
    };
};

const componentMatchScore = (component: string, target: SubsystemModeTarget): number => {
    const componentKey = normalizeSystemModeKey(component);
    const nameKey = normalizeSystemModeKey(target.name);
    const detailsKey = normalizeSystemModeKey(`${target.specs || ''} ${target.func || ''}`);
    const componentTokens = meaningfulTokens(component);
    if (!componentKey || !nameKey || !componentTokens.length) return 0;

    if (componentKey === nameKey) return 120;
    if (` ${nameKey} `.includes(` ${componentKey} `) || ` ${componentKey} `.includes(` ${nameKey} `)) return 105;

    const nameTokens = new Set(meaningfulTokens(target.name));
    const nameOverlap = componentTokens.filter(token => nameTokens.has(token)).length;
    if (nameOverlap === componentTokens.length) return 90 + Math.min(componentTokens.length, 5);
    if (nameOverlap > 0 && nameOverlap / componentTokens.length >= 0.5) return 65 + nameOverlap * 5;

    if (detailsKey && ` ${detailsKey} `.includes(` ${componentKey} `)) return 60;
    const detailTokens = new Set(meaningfulTokens(`${target.specs || ''} ${target.func || ''}`));
    const detailOverlap = componentTokens.filter(token => detailTokens.has(token)).length;
    if (detailOverlap === componentTokens.length) return 55;
    if (detailOverlap > 0 && detailOverlap / componentTokens.length >= 0.5) return 45 + detailOverlap * 3;
    return 0;
};

export const selectSystemModeGroups = (rows: SystemMode[], target: SubsystemModeTarget): SystemModeGroup[] => groupSystemModes(rows)
    .map(group => ({ group, score: componentMatchScore(group.component, target) }))
    .filter(item => item.score >= 45)
    .sort((a, b) => b.score - a.score || b.group.totalOccurrences - a.group.totalOccurrences)
    .slice(0, MAX_MATCHED_COMPONENTS)
    .map(item => item.group);

export const isHistoricalFailureModeCandidate = (mode: string): boolean => {
    const key = normalizeSystemModeKey(mode);
    if (!key) return false;
    if (/^(unknown|unknown review required|review required|no fault found|non equipment activity|no failure found|not applicable|n a)$/.test(key)) return false;
    if (/\b(preventive maintenance|scheduled maintenance|inspection|calibration|lubrication|overhaul|replaced|replacement|repaired|repair completed|service completed)\b/.test(key)) return false;
    return true;
};

export const getScopedSystemModes = (rows: SystemMode[], target: SubsystemModeTarget): SystemMode[] => selectSystemModeGroups(rows, target)
    .flatMap(group => group.modes.filter(mode => isHistoricalFailureModeCandidate(mode.mode)));

const appendWithinLimit = (parts: string[], line: string): boolean => {
    const currentLength = parts.reduce((sum, part) => sum + part.length + 1, 0);
    if (currentLength + line.length + 1 > CONTEXT_CHARACTER_LIMIT) return false;
    parts.push(line);
    return true;
};

export const buildComponentCatalogContext = (systemType: string, rows: SystemMode[]): string => {
    const groups = groupSystemModes(rows);
    if (!groups.length) return '';
    const parts = [
        '---',
        'OPERATIONAL COMPONENT CATALOG (subsystem-boundary evidence only):',
        `System Type: ${systemType || 'N/A'}`,
        'Use component names and occurrence totals only to help identify credible subsystem boundaries. Do not infer specifications or copy maintenance-event wording.',
    ];
    groups.forEach((group, index) => {
        appendWithinLimit(parts, `${index + 1}. ${group.component} — ${group.totalOccurrences} occurrences across ${group.modes.length} unique historical records`);
    });
    parts.push('---');
    return parts.join('\n');
};

export const buildScopedSystemModesContext = (systemType: string, rows: SystemMode[], target: SubsystemModeTarget): string => {
    const groups = selectSystemModeGroups(rows, target)
        .map(group => ({ ...group, modes: group.modes.filter(mode => isHistoricalFailureModeCandidate(mode.mode)) }))
        .filter(group => group.modes.length > 0);
    if (!groups.length) return '';

    const parts = [
        '---',
        'COMPONENT-SCOPED OPERATIONAL FAILURE HISTORY (advisory evidence only):',
        `System Type: ${systemType || 'N/A'}`,
        `Target Subsystem: ${target.name || 'N/A'}`,
        'Use these records only to prioritize credible failure concepts for this subsystem and Functional Failure.',
        'Do not copy historical labels as output. Apply FMECA failed-state wording rules and generate a normalized mode from the Functional Failure.',
        'Do not generate a mode merely because it appears here. Do not omit a credible mode merely because it is absent here.',
    ];

    let omitted = 0;
    groups.forEach(group => {
        if (!appendWithinLimit(parts, `Component: ${group.component} (${group.totalOccurrences} total occurrences)`)) {
            omitted += group.modes.length;
            return;
        }
        group.modes.forEach(mode => {
            if (!appendWithinLimit(parts, `- ${mode.mode} — ${mode.count} occurrences`)) omitted += 1;
        });
    });
    if (omitted > 0) appendWithinLimit(parts, `- ${omitted} lower-ranked historical record(s) omitted by context limit`);
    parts.push('---');
    return parts.join('\n');
};

export const buildFullSystemModesContext = (systemType: string, rows: SystemMode[]): string => {
    const groups = groupSystemModes(rows);
    if (!groups.length) return '';
    const parts = [
        '---',
        'GROUPED OPERATIONAL FAILURE HISTORY:',
        `System Type: ${systemType || 'N/A'}`,
        'These are historical records grouped by component. Treat them as operational evidence, not mandatory FMECA naming.',
    ];
    let omitted = 0;
    groups.forEach(group => {
        if (!appendWithinLimit(parts, `Component: ${group.component} (${group.totalOccurrences} total occurrences)`)) {
            omitted += group.modes.length;
            return;
        }
        group.modes.forEach(mode => {
            if (!appendWithinLimit(parts, `- ${mode.mode} — ${mode.count} occurrences`)) omitted += 1;
        });
    });
    if (omitted > 0) appendWithinLimit(parts, `- ${omitted} lower-ranked historical record(s) omitted by context limit`);
    parts.push('---');
    return parts.join('\n');
};
