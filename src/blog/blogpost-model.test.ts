import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';

// Guards that the migration + client regeneration landed the new model surface later phases compile
// against. Reads Prisma's DMMF (no DB, env-hermetic).
describe('blogpost prisma client surface', () => {
  const models = Prisma.dmmf.datamodel.models.map((m) => m.name);

  it('exposes the Blogpost and MediaAsset models', () => {
    expect(models).toContain('Blogpost');
    expect(models).toContain('MediaAsset');
  });

  it('no longer exposes brief columns on Species', () => {
    const species = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Species')!;
    const fields = species.fields.map((f) => f.name);
    expect(fields).not.toContain('briefEs');
    expect(fields).not.toContain('briefEn');
    expect(fields).toContain('blogpost'); // 1:1 back-relation
  });

  it('exposes the coverImagePrompt field on Blogpost (mapped to cover_image_prompt)', () => {
    const blogpost = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Blogpost')!;
    const field = blogpost.fields.find((f) => f.name === 'coverImagePrompt');
    expect(field).toBeDefined();
    expect(field!.dbName).toBe('cover_image_prompt');
    expect(field!.isRequired).toBe(false); // nullable
  });
});
