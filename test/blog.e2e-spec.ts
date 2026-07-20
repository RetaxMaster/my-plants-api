import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ImageUploadService } from '../src/storage/image-upload.service.js';
import { WeatherService } from '../src/weather/weather.service.js';
import { configureApp } from '../src/config/configure-app.js';

// End-to-end for the Blog + Media surface over the REAL HTTP stack against a running MariaDB.
// Hermetic: ImageUploadService is FAKED (no R2, records calls, returns a stub incl. size/dims) and
// WeatherService returns null so the startup recompute can't hang offline. fileParallelism:false comes
// from vitest.e2e.config.ts.
describe('Blog + Media (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const adminName = `e2e-blog-admin-${randomUUID()}`;
  const admin2Name = `e2e-blog-admin2-${randomUUID()}`;
  const userName = `e2e-blog-user-${randomUUID()}`;
  const password = 'e2e-secret';
  let adminOwnerId: string;
  let admin2OwnerId: string;
  let userOwnerId: string;
  let adminUserId: string;
  let admin2UserId: string;
  let userUserId: string;
  let adminToken: string;
  let admin2Token: string;
  let userToken: string;

  // Track what we create so teardown is precise.
  const createdSlugs = new Set<string>();
  const createdMediaIds = new Set<string>();
  let freeSlug: string; // the API-DERIVED slug of the free-form test post (captured from create)
  let testSpeciesSlug: string; // a throwaway species for the species-linked delete-guard fixture

  const uploadCalls: { keyPrefix: string }[] = [];
  const deleteCalls: string[] = [];
  let uploadSeq = 0;
  const fakeImages = {
    upload: async ({ keyPrefix }: { buffer: Buffer; keyPrefix: string }) => {
      uploadSeq += 1;
      uploadCalls.push({ keyPrefix });
      return {
        imageUrl: `https://cdn.test/${uploadSeq}.webp`,
        imageObjectKey: `${keyPrefix}/${uploadSeq}.webp`,
        sizeBytes: 1234,
        width: 800,
        height: 600,
      };
    },
    delete: async (key: string | null | undefined) => {
      if (key) deleteCalls.push(key);
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ImageUploadService).useValue(fakeImages)
      .overrideProvider(WeatherService).useValue({ forLocation: async () => null, forCity: async () => null })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app); // the SAME configuration main.ts applies — never a hand-kept copy
    await app.init();
    prisma = app.get(PrismaService);

    const mkUser = async (username: string, role: 'ADMIN' | 'USER') => {
      const owner = await prisma.owner.create({ data: { name: username } });
      const user = await prisma.user.create({
        data: { username, passwordHash: await bcrypt.hash(password, 10), role, ownerId: owner.id },
      });
      const login = await request(app.getHttpServer()).post('/auth/login').send({ username, password }).expect(201);
      return { ownerId: owner.id, userId: user.id, token: login.body.token as string };
    };

    ({ ownerId: adminOwnerId, userId: adminUserId, token: adminToken } = await mkUser(adminName, 'ADMIN'));
    ({ ownerId: admin2OwnerId, userId: admin2UserId, token: admin2Token } = await mkUser(admin2Name, 'ADMIN'));
    ({ ownerId: userOwnerId, userId: userUserId, token: userToken } = await mkUser(userName, 'USER'));

    // A throwaway species for the species-linked delete-guard fixture (its record is never read here).
    testSpeciesSlug = `e2e-blog-species-${randomUUID()}`;
    await prisma.species.create({
      data: { slug: testSpeciesSlug, scientificName: `E2E Species ${testSpeciesSlug}`, record: {} },
    });
  });

  afterAll(async () => {
    if (prisma) {
      if (createdSlugs.size) await prisma.blogpost.deleteMany({ where: { slug: { in: [...createdSlugs] } } });
      if (testSpeciesSlug) {
        await prisma.blogpost.deleteMany({ where: { speciesSlug: testSpeciesSlug } });
        await prisma.species.deleteMany({ where: { slug: testSpeciesSlug } });
      }
      if (createdMediaIds.size) await prisma.mediaAsset.deleteMany({ where: { id: { in: [...createdMediaIds] } } });
      await prisma.user.deleteMany({ where: { id: { in: [adminUserId, admin2UserId, userUserId] } } });
      await prisma.owner.deleteMany({ where: { id: { in: [adminOwnerId, admin2OwnerId, userOwnerId] } } });
    }
    if (app) await app.close();
  });

  const server = () => app.getHttpServer();
  const asAdmin = (r: request.Test) => r.set('Authorization', `Bearer ${adminToken}`);
  const asAdmin2 = (r: request.Test) => r.set('Authorization', `Bearer ${admin2Token}`);
  const asUser = (r: request.Test) => r.set('Authorization', `Bearer ${userToken}`);

  it('creates a free-form post: DRAFT default, slug derived from titleEs, speciesSlug null', async () => {
    // A UNIQUE title so the API-derived slug never collides with a pre-existing post (which would make
    // the service suffix it "...-2" and break a hard-coded expectation). We CAPTURE whatever slug the
    // API returns and reuse it everywhere; the marker body word ("Pothos") lets a later detail check
    // assert content without depending on the slug.
    const titleEs = `Test post ${randomUUID()}`;
    const res = await asAdmin(request(server()).post('/blogposts'))
      .send({ titleEs, excerptEs: 'Guía breve', bodyEs: '# Pothos\ncontenido del post' })
      .expect(201);
    // Register for cleanup IMMEDIATELY (before any assertion) so teardown removes it even if an
    // assertion below throws.
    freeSlug = res.body.slug as string;
    createdSlugs.add(freeSlug);

    expect(freeSlug).toMatch(/^test-post-/); // derived from the unique title, no collision suffix
    expect(res.body.status).toBe(0);
    expect(res.body.publishedAt).toBeNull();
    expect(res.body.speciesSlug).toBeNull();
    expect(res.body.createdByUserId).toBe(adminUserId);
  });

  it('a draft does NOT appear in the public feed', async () => {
    const feed = await request(server()).get('/blog').expect(200); // @Public — no token
    expect(feed.body.items.some((p: { slug: string }) => p.slug === freeSlug)).toBe(false);
    expect(feed.body).toMatchObject({ page: 1, pageSize: 10 });
  });

  it('publishing sets publishedAt and the post appears in the public feed with readingMinutes', async () => {
    const patched = await asAdmin(request(server()).patch(`/blogposts/${freeSlug}`))
      .send({ status: 1 }).expect(200);
    expect(patched.body.status).toBe(1);
    expect(patched.body.publishedAt).not.toBeNull();

    const feed = await request(server()).get('/blog').expect(200);
    const card = feed.body.items.find((p: { slug: string }) => p.slug === freeSlug);
    expect(card).toBeTruthy();
    expect(card.readingMinutes).toBeGreaterThanOrEqual(1);

    const detail = await request(server()).get(`/blog/${freeSlug}`).expect(200);
    expect(detail.body.bodyEs).toContain('Pothos');
  });

  it('unpublishing removes it from the public feed (and public detail 404s)', async () => {
    await asAdmin(request(server()).patch(`/blogposts/${freeSlug}`)).send({ status: 0 }).expect(200);
    const feed = await request(server()).get('/blog').expect(200);
    expect(feed.body.items.some((p: { slug: string }) => p.slug === freeSlug)).toBe(false);
    await request(server()).get(`/blog/${freeSlug}`).expect(404);
    // Re-publish so later steps have a live post.
    await asAdmin(request(server()).patch(`/blogposts/${freeSlug}`)).send({ status: 1 }).expect(200);
  });

  it('uploads a cover (faked uploader) and sets coverImageUrl', async () => {
    const res = await asAdmin(request(server()).post(`/blogposts/${freeSlug}/cover`))
      .attach('cover', Buffer.from('fake-cover'), 'cover.jpg')
      .expect(201);
    expect(res.body.coverImageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(uploadCalls.some((u) => u.keyPrefix === 'blog/covers')).toBe(true);
  });

  it('a second admin sees the first admin\'s post (Admin Scoped — no owner filter)', async () => {
    const list = await asAdmin2(request(server()).get('/blogposts')).expect(200);
    expect(list.body.items.some((p: { slug: string }) => p.slug === freeSlug)).toBe(true);
  });

  it('a USER is 403 on every admin write', async () => {
    await asUser(request(server()).post('/blogposts')).send({ titleEs: 'x', excerptEs: 'x', bodyEs: 'x' }).expect(403);
    await asUser(request(server()).patch(`/blogposts/${freeSlug}`)).send({ status: 0 }).expect(403);
    await asUser(request(server()).delete(`/blogposts/${freeSlug}`)).expect(403);
    await asUser(request(server()).post('/media')).attach('image', Buffer.from('x'), 'x.jpg').expect(403);
  });

  it('rejects deleting a species-linked post with 409, but deletes a free-form post', async () => {
    // Fixture: a species-linked post (created via the data layer — the admin route can't set speciesSlug).
    await prisma.blogpost.create({
      data: {
        slug: testSpeciesSlug,
        speciesSlug: testSpeciesSlug,
        status: 1,
        titleEs: 'Guía de especie',
        excerptEs: 'resumen',
        bodyEs: 'cuerpo',
        publishedAt: new Date(),
      },
    });
    const linked = await asAdmin(request(server()).delete(`/blogposts/${testSpeciesSlug}`)).expect(409);
    expect(linked.body.message?.code ?? linked.body.code).toBe('blogpost_species_linked_undeletable');

    // Free-form deletes freely.
    await asAdmin(request(server()).delete(`/blogposts/${freeSlug}`)).expect(200);
    createdSlugs.delete(freeSlug);
    await request(server()).get(`/blog/${freeSlug}`).expect(404);
  });

  it('media: upload → list → delete (with R2 object cleanup)', async () => {
    const up = await asAdmin(request(server()).post('/media'))
      .attach('image', Buffer.from('fake-media'), 'photo.jpg')
      .expect(201);
    expect(up.body).toMatchObject({ filename: 'photo.jpg', sizeBytes: 1234, width: 800, height: 600 });
    expect(up.body.imageUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(up.body.imageObjectKey).toBeUndefined(); // internal key is not exposed
    const id = up.body.id as string;
    createdMediaIds.add(id);

    const list = await asAdmin(request(server()).get('/media')).expect(200);
    expect(list.body.items.some((m: { id: string }) => m.id === id)).toBe(true);

    const before = deleteCalls.length;
    await asAdmin(request(server()).delete(`/media/${id}`)).expect(200);
    createdMediaIds.delete(id);
    expect(deleteCalls.length).toBe(before + 1); // the R2 object was deleted
  });
});
