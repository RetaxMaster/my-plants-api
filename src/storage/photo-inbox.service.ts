import { randomUUID } from 'node:crypto';
import { open, mkdir, rename, unlink, readdir, stat, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { Env } from '../config/env.js';
import { ImageUploadError } from './image-upload.errors.js';

export interface StagedFile { inboxPath: string; originalName: string; sizeBytes: number }
interface DiskProbe { freeBytes: (dir: string) => Promise<number> }

// Default free-space probe via statfs (bavail * bsize). Injected in tests for determinism.
const realDisk: DiskProbe = {
  async freeBytes(dir) { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); },
};

@Injectable()
export class PhotoInboxService {
  private readonly logger = new Logger(PhotoInboxService.name);
  private readonly dir: string;
  private readonly minFreeBytes: number;

  constructor(private readonly env: Env, private readonly disk: DiskProbe = realDisk) {
    this.dir = env.PHOTO_INBOX_DIR;                       // already resolved absolute by the schema
    this.minFreeBytes = env.INBOX_MIN_FREE_MB * 1024 * 1024;
  }

  // Path containment (spec §3.2): the final path is resolve(dir, '<id>.bin') and MUST start with the
  // resolved dir — defence against any separator/.. in a derived name even though the name is a server id.
  private binPath(id: string): string {
    const p = resolve(this.dir, `${id}.bin`);
    if (!p.startsWith(resolve(this.dir))) throw new Error('inbox path escaped PHOTO_INBOX_DIR');
    return p;
  }

  // Stage ALL files or NONE (spec §3.2/§5.1): capacity guard first, then atomic temp→fsync→rename per file.
  // On any mid-batch failure, delete what was already staged and rethrow (compensation).
  async stage(files: { buffer: Buffer; originalName: string }[]): Promise<StagedFile[]> {
    await mkdir(this.dir, { recursive: true });
    const incoming = files.reduce((n, f) => n + f.buffer.byteLength, 0);
    const free = await this.disk.freeBytes(this.dir);
    // Reject the WHOLE request if staging would drop below the floor AFTER the incoming bytes.
    if (free - incoming < this.minFreeBytes) {
      throw new ImageUploadError('photo_storage_busy', 'photo storage is temporarily busy; try again later');
    }
    const staged: StagedFile[] = [];
    let currentTmp: string | null = null; // the .tmp being written RIGHT NOW (not yet renamed → not in `staged`)
    try {
      for (const f of files) {
        const id = randomUUID();
        const finalPath = this.binPath(id);
        const tmpPath = `${finalPath}.tmp`;
        currentTmp = tmpPath; // remember it BEFORE any write so a failure mid-write can still clean it up
        // Exclusive open (wx) → never clobber; restrictive perms; fsync; atomic rename onto the same fs.
        const handle = await open(tmpPath, 'wx', 0o600);
        try {
          await handle.writeFile(f.buffer);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmpPath, finalPath);
        currentTmp = null; // renamed → it is now a committed .bin tracked in `staged`
        staged.push({ inboxPath: finalPath, originalName: f.originalName, sizeBytes: f.buffer.byteLength });
      }
      return staged;
    } catch (err) {
      // ENOSPC racing the check (or any write failure): compensate every ALREADY-COMMITTED .bin AND delete the
      // in-flight .tmp (a failed writeFile before rename leaves it — it is not in `staged`, so it would leak
      // until the orphan sweep, SHOULD-FIX 9). Then map ENOSPC to the same typed 503, never a raw 500.
      await this.deleteMany(staged.map((s) => s.inboxPath));
      await this.delete(currentTmp);
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
        throw new ImageUploadError('photo_storage_busy', 'photo storage is full; try again later');
      }
      throw err;
    }
  }

  async deleteMany(paths: (string | null | undefined)[]): Promise<void> {
    await Promise.all(paths.map((p) => this.delete(p)));
  }

  // Best-effort single delete — never throws into the caller.
  async delete(path: string | null | undefined): Promise<void> {
    if (!path) return;
    try { await unlink(path); } catch { /* already gone */ }
  }

  // True iff the staged file is present + readable. Used by the retry atomic re-check (CRUD spec §2.2): the
  // TTL sweep may have reclaimed the bytes since the page loaded, so retry must confirm they still exist.
  async exists(path: string | null | undefined): Promise<boolean> {
    if (!path) return false;
    try { await stat(path); return true; } catch { return false; }
  }

  // Orphan sweep (spec §3.2): delete any .bin/.tmp with no matching photo row, older than a short grace so it
  // never races an in-flight request. `knownPaths` = the set of inboxPaths still referenced by a photo row.
  async sweepOrphans(opts: { knownPaths: Set<string>; now?: number; graceMs?: number }): Promise<string[]> {
    const grace = opts.graceMs ?? 60_000;
    const now = opts.now ?? Date.now();
    const deleted: string[] = [];
    let names: string[] = [];
    try { names = await readdir(this.dir); } catch { return deleted; }
    for (const name of names) {
      if (!name.endsWith('.bin') && !name.endsWith('.tmp')) continue;
      const full = join(this.dir, name);
      if (opts.knownPaths.has(full)) continue;
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (now - info.mtimeMs < grace) continue; // too young — may be an in-flight stage
      await this.delete(full);
      deleted.push(full);
      this.logger.warn(`Swept orphan inbox file ${full}`);
    }
    return deleted;
  }
}
