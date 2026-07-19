import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { classifyFailure, MAX_FAILURE_REASON_CHARS } from './proposal-failure.js';

describe('classifyFailure', () => {
  it('maps Nest exceptions to closed codes with author-written reasons', () => {
    expect(classifyFailure(new BadRequestException('x'), { warn: vi.fn() }).code).toBe('VALIDATION');
    expect(classifyFailure(new NotFoundException('x'), { warn: vi.fn() }).code).toBe('NOT_FOUND');
    expect(classifyFailure(new ConflictException('x'), { warn: vi.fn() }).code).toBe('CONFLICT');
    expect(classifyFailure(new ForbiddenException('x'), { warn: vi.fn() }).code).toBe('OWNERSHIP');
  });

  it('never leaks raw driver text into the reason, and logs it instead', () => {
    const warn = vi.fn();
    const err = Object.assign(new Error('Unknown column `plants`.`secret_col` in field list'), { code: 'P2022' });
    const out = classifyFailure(err, { warn });
    expect(out.code).toBe('INTERNAL');
    expect(out.reason).not.toContain('secret_col');
    expect(out.reason.length).toBeLessThanOrEqual(MAX_FAILURE_REASON_CHARS);
    expect(warn.mock.calls.flat().join(' ')).toContain('secret_col');
  });

  it('never leaks the message of a CLASSIFIED exception either', () => {
    // The classified branches are the easy place to "helpfully" pass err.message through. A
    // BadRequestException raised deep in a write core can carry a plant id, a place id, or a column
    // name, and it would reach the owner's banner AND the agent verbatim. Every reason is author-written.
    const warn = vi.fn();
    const out = classifyFailure(new BadRequestException('placeId 7f3a-secret does not belong to this owner'), { warn });
    expect(out.code).toBe('VALIDATION');
    expect(out.reason).not.toContain('7f3a-secret');
    expect(warn.mock.calls.flat().join(' ')).toContain('7f3a-secret');
  });

  it('classifies a non-Error throw as INTERNAL without throwing itself', () => {
    const warn = vi.fn();
    expect(classifyFailure('just a string', { warn }).code).toBe('INTERNAL');
    expect(classifyFailure(undefined, { warn }).code).toBe('INTERNAL');
  });
});
