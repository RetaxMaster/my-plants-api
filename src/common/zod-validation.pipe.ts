import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

// A route-scoped pipe that validates a raw request body with a Zod schema and maps any Zod error to a
// 400. Used for the plant-profile PATCH body, whose vocabulary is single-sourced in
// @retaxmaster/my-plants-species-schema — a class-validator DTO would fork that vocabulary, and the
// app's global whitelist ValidationPipe would strip a decorator-less class before it could validate.
// The handler types its body as the erased Zod-inferred type (runtime metatype Object), so the global
// pipe skips it and this pipe performs the real validation.
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(
        result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    return result.data;
  }
}
