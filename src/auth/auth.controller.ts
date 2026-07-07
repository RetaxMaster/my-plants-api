import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';
import { LoginDto } from './login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.username, body.password);
  }

  @Post('refresh')
  async refresh(@Req() req: any) {
    const a = req.user; // the current Actor, set by the guard
    if (!a) throw new UnauthorizedException();
    return this.auth.refresh({
      userId: a.userId, username: a.username, ownerId: a.ownerId,
      role: a.role, jti: a.jti, sst: a.sst, exp: a.exp,
    });
  }

  @Post('logout')
  async logout(@Req() req: any) {
    const p = req.user; // set by the guard in Phase 3
    if (!p) throw new UnauthorizedException();
    await this.auth.logout(p.jti, p.exp);
    return { ok: true };
  }

  @Get('me')
  me(@Req() req: any) {
    const p = req.user;
    if (!p) throw new UnauthorizedException();
    // Authoritative impersonation state the API actually resolved (id-only). The frontend banner is
    // driven by the BFF session me (which also carries a human label); these stay consistent.
    return {
      username: p.username,
      role: p.role,
      actingAs: p.actingAsOwnerId ? { ownerId: p.actingAsOwnerId } : null,
    };
  }
}
