/**
 * Attachments in SharePoint, behind the same interface as LocalFileSystemProvider.
 *
 * The project's root folder is a SharePoint location stored on the project
 * (`Project.spAttachmentRoot`), so it travels with the project JSON and is the same
 * in Teams and in the browser. Each entity's files live under it exactly as they do
 * locally: <root>/Subsystems/<sub>/Failures/<failure>.
 *
 * Nothing here needs a popup or a user gesture: every call goes through the OXY
 * Connection Flow. So this provider reports `embedded: false`, and the Attachments
 * panel takes its plain path (no helper-window sessions). Picking the root folder
 * is the one step with UI; App supplies it as `pickFolder` (the SharePoint picker).
 */
import type { FileEntry } from '../types';
import type { AttachmentProvider, DirHandleLike, WriteSession } from './FileSystem';
import { FolderSelectionCancelled, sanitizeName } from './FileSystem';
import {
    SharePointFiles, SpError, SpListing, SpLocation, describeSpError, guessContentType, joinSpPath, mapLimit, spBaseName,
    SP_MAX_FILE_BYTES, SP_UPLOAD_CONCURRENCY,
} from './SharePointFiles';

export interface SharePointStorageOptions {
    client: SharePointFiles;
    /** The project's linked folder, or null. */
    getRoot: (projectId: string) => SpLocation | null;
    /** Store the project's folder (App writes it onto the project). */
    setRoot: (projectId: string, root: SpLocation) => void;
    /** Show the picker; resolves with the chosen folder, or null when cancelled. */
    pickFolder: (projectId: string, current: SpLocation | null) => Promise<SpLocation | null>;
}

/** SharePoint's own errors as one sentence for the panel; anything else as it is. */
async function plainly<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (e) {
        throw e instanceof SpError ? new Error(describeSpError(e)) : e;
    }
}

/** A session that holds nothing: SharePoint writes need no window. */
const NO_SESSION: WriteSession = {
    rootPromise: Promise.resolve(null as unknown as DirHandleLike),
    done: () => {},
    isLive: () => true,
};

export class SharePointStorageProvider implements AttachmentProvider {
    readonly kind = 'sharepoint' as const;
    readonly embedded = false;

    constructor(private opts: SharePointStorageOptions) {}

    private root(projectId: string): SpLocation {
        const root = this.opts.getRoot(projectId);
        if (!root) throw new Error('No SharePoint folder is linked to this project yet. Pick one first.');
        return root;
    }

    /** The entity folder, named the way local folders are. */
    private folder(projectId: string, pathParts: string[]): SpLocation {
        const root = this.root(projectId);
        return { site: root.site, path: joinSpPath(root.path, ...pathParts.map(sanitizeName)) };
    }

    isLinkedSync(projectId: string): boolean {
        return !!this.opts.getRoot(projectId);
    }

    async hasRoot(projectId: string): Promise<boolean> {
        return this.isLinkedSync(projectId);
    }

    async rootName(projectId: string): Promise<string | null> {
        const root = this.opts.getRoot(projectId);
        return root ? 'SharePoint / ' + spBaseName(root.path) : null;
    }

    async chooseRoot(projectId: string): Promise<SpLocation> {
        const picked = await this.opts.pickFolder(projectId, this.opts.getRoot(projectId));
        if (!picked) throw new FolderSelectionCancelled();
        this.opts.setRoot(projectId, { site: picked.site, path: picked.path });
        return picked;
    }

    /** Only the embedded local provider picks in a helper window. */
    beginPick(): WriteSession & { picked: Promise<unknown> } {
        throw new Error('SharePoint folders are picked with chooseRoot.');
    }

    beginWrite(): WriteSession {
        return NO_SESSION;
    }

    async describeWrite(): Promise<void> {}

    async ensureFolderForEntity(projectId: string, pathParts: string[]): Promise<void> {
        const { site, path } = this.folder(projectId, pathParts);
        await plainly(() => this.opts.client.mkdir(site, path));
    }

    /** Uploads replace a file of the same name, as saving to a local folder does. */
    async writeChosenFiles(projectId: string, pathParts: string[], files: File[]): Promise<number> {
        const { site, path } = this.folder(projectId, pathParts);
        const tooBig = files.filter(f => f.size > SP_MAX_FILE_BYTES);
        if (tooBig.length) {
            throw new Error(`${tooBig.map(f => f.name).join(', ')}: over ${SP_MAX_FILE_BYTES / 1024 / 1024} MB, the SharePoint upload limit.`);
        }
        await plainly(async () => {
            // Skipped without a call when the panel's listing already found the folder.
            await this.opts.client.mkdir(site, path);
            await mapLimit(files, SP_UPLOAD_CONCURRENCY, file =>
                this.opts.client.write(site, path, file.name, file, { overwrite: true }));
        });
        return files.length;
    }

    async deleteFile(projectId: string, pathParts: string[], name: string): Promise<void> {
        const { site, path } = this.folder(projectId, pathParts);
        try {
            await this.opts.client.remove(site, joinSpPath(path, name));
        } catch (e) {
            if (e instanceof SpError && e.code === 'not_found') return;
            throw e instanceof SpError ? new Error(describeSpError(e)) : e;
        }
    }

    /** Files in the entity folder. A folder not created yet is simply empty. */
    async listFiles(projectId: string, pathParts: string[]): Promise<FileEntry[]> {
        if (!this.opts.getRoot(projectId)) return [];
        const { site, path } = this.folder(projectId, pathParts);
        let listing;
        try {
            listing = await this.opts.client.list(site, path);
        } catch (e) {
            if (e instanceof SpError && e.code === 'not_found') return [];
            throw e instanceof SpError ? new Error(describeSpError(e)) : e;
        }
        return this.entries(site, listing);
    }

    /**
     * The folder's last known files, without a call, or null when this browser has
     * never listed it. The panel shows these at once while `listFiles` refreshes.
     */
    async cachedFiles(projectId: string, pathParts: string[]): Promise<FileEntry[] | null> {
        if (!this.opts.getRoot(projectId)) return null;
        const { site, path } = this.folder(projectId, pathParts);
        const listing = await this.opts.client.cachedList(site, path).catch(() => null);
        return listing ? this.entries(site, listing) : null;
    }

    /** List the folder in the background, so opening its panel later finds it cached. */
    prefetch(projectId: string, pathParts: string[]): void {
        if (!this.opts.getRoot(projectId)) return;
        const { site, path } = this.folder(projectId, pathParts);
        this.opts.client.list(site, path).catch(() => {});
    }

    private entries(site: string, listing: SpListing): FileEntry[] {
        const client = this.opts.client;
        return listing.files
            .filter(f => !f.name.startsWith('.'))
            .map(f => ({
                name: f.name,
                handle: {
                    kind: 'file' as const,
                    name: f.name,
                    async getFile(): Promise<File> {
                        if (f.size > SP_MAX_FILE_BYTES) {
                            throw new Error(`${f.name} is over ${SP_MAX_FILE_BYTES / 1024 / 1024} MB, too large to open through SharePoint here.`);
                        }
                        // Opened before and unchanged since: no call.
                        const blob = await plainly(() => client.readBlob(site, f.path, f.etag));
                        return new File([blob], f.name, { type: guessContentType(f.name) });
                    },
                },
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    async readFile(entry: FileEntry): Promise<Blob> {
        if (!entry.handle) throw new Error('That file is no longer available.');
        return entry.handle.getFile();
    }
}
