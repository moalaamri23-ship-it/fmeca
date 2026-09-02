import { OperatingContext, Project } from '../types';

/**
 * RCM Studio round-trip: the approved RCM outcome per failure mode plus the gaps RCM Studio
 * found in the FMECA itself. Matched on subsystem / mode ids, which both apps keep stable.
 * Shape mirrors services/fmecaFeedback.ts in RCM Studio.
 */
export interface RcmFeedbackMode {
    modeId: string;
    subsystemId: string;
    failureMode: string;
    consequenceCategory: string;
    multipleFailureConsequence?: string;
    policy: string;
    revisedCurrentControl: string;
    revisedMitigation: string;
    task?: { type: string; description: string; interval?: number; intervalUnit?: string; basis: string; basisNote: string };
    reviewer?: string;
}

export interface RcmFeedbackGap {
    code: string;
    severity: 'Blocking' | 'Major' | 'Minor';
    subsystemId?: string;
    modeId?: string;
    text: string;
}

export interface RcmFeedback {
    kind: 'rcm-feedback';
    version: number;
    sourceProjectId: string;
    sourceProjectName: string;
    rcmProjectName: string;
    generatedAt: string;
    operatingContext?: OperatingContext;
    modes: RcmFeedbackMode[];
    gaps: RcmFeedbackGap[];
}

export type FeedbackMergeMode = 'replace' | 'append';

export interface ApplyFeedbackResult {
    project: Project;
    updatedModes: number;
    unmatchedModes: string[];
    matchedSubsystems: number;
}

export const isRcmFeedback = (value: unknown): value is RcmFeedback =>
    Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && (value as { kind?: unknown }).kind === 'rcm-feedback'
        && Array.isArray((value as { modes?: unknown }).modes));

/** How many of the feedback's subsystem ids exist in this project — the match signal the
 * caller uses to pick the target project (project ids never survive import). */
export const countMatchingSubsystems = (project: Project, feedback: RcmFeedback): number => {
    const ids = new Set(project.subsystems.map(s => s.id));
    const wanted = new Set(feedback.modes.map(m => m.subsystemId).filter(Boolean));
    let count = 0;
    wanted.forEach(id => { if (ids.has(id)) count += 1; });
    return count;
};

const RCM_TAG = 'RCM';

const mergeText = (current: string, incoming: string, mode: FeedbackMergeMode): string => {
    const next = (incoming || '').trim();
    if (!next) return current;
    if (mode === 'replace' || !(current || '').trim()) return next;
    // Append: keep the FMECA lines, add the RCM lines that are not already present, renumber.
    const strip = (line: string) => line.replace(/^\d{1,2}\s*[-.)]\s*/, '').trim();
    const existing = current.split(/\r?\n/).map(strip).filter(Boolean);
    const added = next.split(/\r?\n/).map(strip).filter(line => line && !existing.some(item => item.toLowerCase() === line.toLowerCase()));
    return [...existing, ...added].map((line, index) => `${index + 1}- ${line}`).join('\n');
};

/**
 * Writes the approved RCM controls / mitigations onto the matching failure modes, stores the
 * operating context when the project has none, and records the FMECA-facing gaps on the
 * project for the banner. Pure: returns a new project.
 */
export const applyRcmFeedback = (project: Project, feedback: RcmFeedback, mode: FeedbackMergeMode): ApplyFeedbackResult => {
    const byMode = new Map(feedback.modes.map(m => [m.modeId, m]));
    const matched = new Set<string>();
    const subsystemsTouched = new Set<string>();

    const subsystems = project.subsystems.map(sub => ({
        ...sub,
        failures: sub.failures.map(failure => ({
            ...failure,
            modes: failure.modes.map(m => {
                const incoming = byMode.get(m.id);
                if (!incoming) return m;
                matched.add(m.id);
                subsystemsTouched.add(sub.id);
                const tags = new Set(m.sourceTags || []);
                tags.add(RCM_TAG);
                return {
                    ...m,
                    currentControls: mergeText(m.currentControls || '', incoming.revisedCurrentControl, mode),
                    mitigation: mergeText(m.mitigation || '', incoming.revisedMitigation, mode),
                    sourceTags: [...tags],
                };
            }),
        })),
    }));

    const unmatchedModes = feedback.modes.filter(m => !matched.has(m.modeId)).map(m => m.failureMode || m.modeId);
    const hasContext = (context?: OperatingContext) => Boolean(context && Object.values(context).some(v => String(v || '').trim()));

    return {
        project: {
            ...project,
            subsystems,
            operatingContext: hasContext(project.operatingContext) ? project.operatingContext : (hasContext(feedback.operatingContext) ? feedback.operatingContext : project.operatingContext),
            rcmFeedback: {
                importedAt: new Date().toISOString(),
                rcmProjectName: feedback.rcmProjectName,
                generatedAt: feedback.generatedAt,
                updatedModes: matched.size,
                gaps: feedback.gaps || [],
            },
        },
        updatedModes: matched.size,
        unmatchedModes,
        matchedSubsystems: subsystemsTouched.size,
    };
};
