import { describe, expect, it } from 'vitest';
import { toAdminDetail, toAdminRow, toCard, toDetail, type BlogpostRow } from './blog.read-models.js';

const row: BlogpostRow = {
  slug: 'monstera-deliciosa',
  status: 1,
  speciesSlug: 'monstera-deliciosa',
  titleEs: 'Costilla de Adán',
  titleEn: 'Swiss cheese plant',
  excerptEs: 'Hojas perforadas.',
  excerptEn: 'Fenestrated leaves.',
  bodyEs: '# Cuerpo\nContenido.',
  bodyEn: '# Body\nContent.',
  coverImageUrl: null,
  coverImageObjectKey: null,
  coverImagePrompt: 'Macro Monstera leaf, 16:9, soft morning light.',
  youtubeUrl: null,
  ctaLink: null,
  ctaLabelEs: null,
  ctaLabelEn: null,
  createdByUserId: null,
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  species: null,
};

describe('blog read-models — coverImagePrompt visibility', () => {
  it('toAdminDetail includes coverImagePrompt (the editor renders the readonly textarea)', () => {
    expect(toAdminDetail(row).coverImagePrompt).toBe('Macro Monstera leaf, 16:9, soft morning light.');
  });

  it('toCard (public) does NOT expose coverImagePrompt', () => {
    expect('coverImagePrompt' in toCard(row)).toBe(false);
  });

  it('toDetail (public article) does NOT expose coverImagePrompt', () => {
    expect('coverImagePrompt' in toDetail(row)).toBe(false);
  });

  it('toAdminRow (admin list) does NOT expose coverImagePrompt', () => {
    expect('coverImagePrompt' in toAdminRow(row)).toBe(false);
  });
});
