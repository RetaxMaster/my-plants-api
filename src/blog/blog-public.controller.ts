import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../auth/public.decorator.js';
import { BlogService } from './blog.service.js';

// Public magazine feed — no session required (@Public lets it past the global JwtAuthGuard).
@Controller('blog')
export class BlogPublicController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get()
  feed(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.blog.feed(
      page !== undefined ? Number.parseInt(page, 10) : undefined,
      pageSize !== undefined ? Number.parseInt(pageSize, 10) : undefined,
    );
  }

  @Public()
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.blog.bySlug(slug);
  }
}
