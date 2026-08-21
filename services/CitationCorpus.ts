/**
 * Everything one field is allowed to cite.
 *
 * A field is cited against four kinds of source, and no others: the two
 * app-wide knowledge files, the documents filed under the field's subsystem,
 * and — for a field that belongs to a functional failure — the documents filed
 * under that failure. Not every field sees all four: `sourceAppliesTo` says
 * which kinds a given field may be cited against. Scoping it this tightly is what keeps a citation run
 * affordable and its result explainable: every passage came from a document the
 * reader could have opened from this row.
 *
 * The knowledge and checklist files are text in localStorage rather than files
 * on disk. They are given a `.txt` name and carried as text, so the viewer
 * renders and highlights them exactly like any other reference.
 */

import { sanitizeName } from './FileSystem';
import type { LocalFileSystemProvider } from './FileSystem';
import type { CitableField } from './FieldClaims';
import type { CitedSourceKind, CitedSourceRef, FileEntry } from '../types';

/** A source with what it takes to read it — a file handle, or its text. */
export interface CiteSource extends CitedSourceRef {
    /** The file on disk, for a source that is one. */
    entry?: FileEntry;
    /** The text itself, for the knowledge and checklist sources. */
    text?: string;
    /** Human label for the panel, e.g. "Subsystem reference". */
    origin: string;
}

const ORIGIN_LABELS: Record<CitedSourceKind, string> = {
    knowledge: 'Knowledge file',
    checklist: 'PM checklist',
    subsystem: 'Subsystem reference',
    function: 'Failure reference',
};

/**
 * Whether a field is cited against a kind of source at all.
 *
 * Specs are cited on documents that STATE a value — the knowledge file and the
 * subsystem's and the failure's attachments. A PM checklist records when a task
 * is performed, never what the equipment is rated for, so a specification
 * "found" there is a coincidence of wording. It is left out of the scope rather
 * than searched and then argued with: a source that cannot answer the question
 * costs a model call and can only produce a wrong answer.
 */
export const sourceAppliesTo = (field: CitableField, kind: CitedSourceKind): boolean =>
    !(field === 'specs' && kind === 'checklist');

/** The sources of `sources` this field is allowed to cite. */
export const sourcesForField = (field: CitableField, sources: CiteSource[]): CiteSource[] =>
    sources.filter(source => sourceAppliesTo(field, source.kind));

/** Attachment folder of a subsystem — the path the References panel opens. */
export const subsystemPath = (subName: string): string[] => ['Subsystems', sanitizeName(subName)];

/** Attachment folder of one functional failure inside a subsystem. */
export const failurePath = (subName: string, failDesc: string): string[] => [
    ...subsystemPath(subName),
    'Failures',
    sanitizeName(failDesc),
];

/** A folder's files, or none — an unlinked project and a missing folder are the same thing here. */
async function listOrEmpty(
    provider: LocalFileSystemProvider,
    projectId: string,
    pathParts: string[]
): Promise<FileEntry[]> {
    try {
        return await provider.listFiles(projectId, pathParts);
    } catch {
        return [];
    }
}

/** A source that carries text rather than a file. Named `.txt` so it renders as one. */
function textSource(kind: 'knowledge' | 'checklist', name: string, text: string): CiteSource | null {
    if (!text.trim()) return null;
    const fileName = name.trim() || (kind === 'checklist' ? 'PM checklist.txt' : 'Knowledge file.txt');
    return {
        id: kind,
        kind,
        fileName: /\.[a-z0-9]{1,5}$/i.test(fileName) ? fileName : `${fileName}.txt`,
        pathParts: [],
        text,
        origin: ORIGIN_LABELS[kind],
    };
}

export interface CorpusRequest {
    provider: LocalFileSystemProvider | null;
    projectId: string | null;
    subName: string;
    /** Set for a field that belongs to a functional failure. */
    failDesc?: string;
    knowledgeName: string;
    knowledgeText: string;
    checklistName: string;
    checklistText: string;
}

/**
 * The sources one field may cite, in the order they are searched: the app-wide
 * knowledge first, then the documents closest to the field.
 *
 * Never throws. A project with no linked folder still cites its knowledge files.
 */
export async function collectCiteSources(req: CorpusRequest): Promise<CiteSource[]> {
    const sources: CiteSource[] = [];

    const knowledge = textSource('knowledge', req.knowledgeName, req.knowledgeText);
    if (knowledge) sources.push(knowledge);
    const checklist = textSource('checklist', req.checklistName, req.checklistText);
    if (checklist) sources.push(checklist);

    if (!req.provider || !req.projectId || !req.subName.trim()) return sources;

    const folders: { kind: CitedSourceKind; pathParts: string[] }[] = [
        { kind: 'subsystem', pathParts: subsystemPath(req.subName) },
    ];
    if (req.failDesc?.trim()) {
        folders.push({ kind: 'function', pathParts: failurePath(req.subName, req.failDesc) });
    }

    for (const folder of folders) {
        const files = await listOrEmpty(req.provider, req.projectId, folder.pathParts);
        for (const entry of files) {
            sources.push({
                id: [...folder.pathParts, entry.name].join('/'),
                kind: folder.kind,
                fileName: entry.name,
                pathParts: folder.pathParts,
                entry,
                origin: ORIGIN_LABELS[folder.kind],
            });
        }
    }

    return sources;
}

/**
 * Rebuild the readable sources behind a stored citation set.
 *
 * The items persist with the project; the documents do not — they live on disk
 * and in localStorage. Reopening a stored set therefore re-lists the folders it
 * named, so a file that has since been deleted shows as missing instead of
 * opening something else that drifted into its place.
 */
export async function rehydrateSources(
    refs: CitedSourceRef[],
    req: CorpusRequest
): Promise<CiteSource[]> {
    const live = await collectCiteSources(req);
    const byId = new Map(live.map(source => [source.id, source]));
    const rehydrated: CiteSource[] = [];
    for (const ref of refs) {
        const match = byId.get(ref.id);
        rehydrated.push(match ?? { ...ref, origin: ORIGIN_LABELS[ref.kind] });
    }
    // A document added since the last run is citable now, so offer it too.
    for (const source of live) {
        if (!refs.some(ref => ref.id === source.id)) rehydrated.push(source);
    }
    return rehydrated;
}

/** Drop the read-time extras — what gets stored with the project. */
export const toSourceRef = (source: CiteSource): CitedSourceRef => ({
    id: source.id,
    kind: source.kind,
    fileName: source.fileName,
    pathParts: source.pathParts,
});
