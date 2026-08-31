// Synthetic NestJS controller used by the detector unit tests.
import { Controller, Post, UseGuards } from '@nestjs/common';
import { Roles } from './roles.decorator';
import { RolesGuard } from './roles.guard';

@Controller('billing')
@UseGuards(RolesGuard)
export class BillingController {
  @Post('refund')
  @Roles('admin')
  refund(): string {
    return 'ok';
  }
}