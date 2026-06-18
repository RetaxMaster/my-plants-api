import { Global, Module } from '@nestjs/common';
import { OwnerService } from './owner.service.js';

@Global()
@Module({ providers: [OwnerService], exports: [OwnerService] })
export class OwnerModule {}
