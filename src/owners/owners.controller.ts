import { Controller, Get } from '@nestjs/common';
import { OwnersService } from './owners.service.js';

@Controller('owners')
export class OwnersController {
  constructor(private readonly owners: OwnersService) {}

  @Get() list() { return this.owners.list(); }
}
