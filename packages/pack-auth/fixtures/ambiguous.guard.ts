import { Controller, Post, UseGuards } from '@nestjs/common';
import { Roles } from './roles.decorator';

const ALLOWED = ['admin', 'finance'];

@Controller('reports')
export class ReportsController {
  @Post('run')
  @Roles(...ALLOWED)
  @UseGuards(JwtGuard)
  run(): unknown {
    return null;
  }
}