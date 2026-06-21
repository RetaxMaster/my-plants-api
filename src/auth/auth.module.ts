import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { expiresIn: env.JWT_EXPIRES_IN as StringValue },
      }),
    }),
  ],
  controllers: [AuthController],
  // The global default-deny guard. Registered here so AuthService is in scope; Reflector and
  // ClsService resolve from @nestjs/core and the global ClsModule respectively. AuthModule is
  // imported by AppModule, so this APP_GUARD applies to the entire application.
  providers: [AuthService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
