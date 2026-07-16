import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PhotoInboxService } from './photo-inbox.service.js';

// A hoisted control the mocked `open` reads: when armed, the Nth handle's writeFile rejects (to exercise a
// mid-batch write failure). A static ESM named import cannot be spied (non-configurable binding), so the
// standard vitest tool is vi.mock over node:fs/promises, spreading the real module and wrapping only `open`.
const ctl = vi.hoisted(() => ({ failWriteOnCall: 0, openCalls: 0 }));
vi.mock('node:fs/promises', async (importOriginal: () => Promise<typeof import('node:fs/promises')>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (ctl.failWriteOnCall && ++ctl.openCalls === ctl.failWriteOnCall) {
        handle.writeFile = async () => { throw new Error('disk write failed'); };
      }
      return handle;
    },
  };
});

function svc(dir: string, freeBytes = 50 * 1024 * 1024 * 1024) {
  // Inject a stubbed free-space probe so the capacity guard is deterministic (no real disk dependency).
  return new PhotoInboxService(
    { PHOTO_INBOX_DIR: dir, INBOX_MIN_FREE_MB: 1024 } as never,
    { freeBytes: async () => freeBytes },
  );
}

describe('PhotoInboxService', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'inbox-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('stages each file atomically to <id>.bin and returns its absolute path', async () => {
    const staged = await svc(dir).stage([{ buffer: Buffer.from('hello'), originalName: 'IMG_1.JPG' }]);
    expect(staged).toHaveLength(1);
    expect(staged[0].inboxPath.startsWith(resolve(dir))).toBe(true);
    expect(staged[0].inboxPath.endsWith('.bin')).toBe(true);
    expect(staged[0].originalName).toBe('IMG_1.JPG');
    expect(await readFile(staged[0].inboxPath, 'utf8')).toBe('hello');
    // No leftover .tmp
    expect((await readdir(dir)).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('rejects the WHOLE batch with 503 photo_storage_busy below the free-space floor (no partial save)', async () => {
    // Free space already under the 1 GB floor.
    const s = svc(dir, 500 * 1024 * 1024);
    await expect(s.stage([{ buffer: Buffer.from('x'), originalName: 'a.jpg' }]))
      .rejects.toMatchObject({ code: 'photo_storage_busy' });
    expect(await readdir(dir)).toHaveLength(0); // nothing staged
  });

  it('deletes staged files (compensation)', async () => {
    const s = svc(dir);
    const staged = await s.stage([{ buffer: Buffer.from('x'), originalName: 'a.jpg' }]);
    await s.deleteMany(staged.map((f) => f.inboxPath));
    expect(await readdir(dir)).toHaveLength(0);
  });

  it('leaves NO .tmp behind when a write fails mid-batch (SHOULD-FIX 9)', async () => {
    // Arm the mocked open so the SECOND handle's writeFile rejects after the first file committed. Assert both
    // the committed .bin AND the in-flight .tmp are gone afterwards.
    ctl.openCalls = 0; ctl.failWriteOnCall = 2;
    try {
      const s = svc(dir);
      await expect(s.stage([
        { buffer: Buffer.from('a'), originalName: 'a.jpg' },
        { buffer: Buffer.from('b'), originalName: 'b.jpg' },
      ])).rejects.toThrow();
      const names = await readdir(dir);
      expect(names.filter((f) => f.endsWith('.tmp'))).toHaveLength(0); // no leaked .tmp
      expect(names.filter((f) => f.endsWith('.bin'))).toHaveLength(0); // first .bin compensated
    } finally {
      ctl.failWriteOnCall = 0; // disarm so no other test is affected
    }
  });

  it('sweeps orphan .bin/.tmp with no matching row, past the grace period', async () => {
    const s = svc(dir);
    const orphan = join(dir, 'zzzzorphan.bin');
    await writeFile(orphan, 'x');
    // Force its mtime old enough by passing now far in the future to the sweep.
    const deleted = await s.sweepOrphans({ knownPaths: new Set(), now: Date.now() + 3_600_000 });
    expect(deleted).toContain(orphan);
    expect((await stat(orphan).catch(() => null))).toBeNull();
  });
});
