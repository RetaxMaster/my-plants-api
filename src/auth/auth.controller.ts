import { Body, Controller, Get, Post, Req, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  login(@Body() body: { username: string; password: string }) {
    return this.auth.login(body.username, body.password);
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
    return { username: p.username, role: p.role }; // username now travels in the JWT/actor
  }
}
