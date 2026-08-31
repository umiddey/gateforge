import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Roles } from './roles.decorator';

@Controller('billing')
@UseGuards(JwtGuard)
export class BillingController {
  @Post('refund')
  @Roles('admin', 'finance')
  @UseGuards(TenantGuard)
  refund(): unknown {
    return null;
  }

  @Get('refund/:id')
  @Roles('admin', 'finance', 'support')
  getRefund(): unknown {
    return null;
  }
}