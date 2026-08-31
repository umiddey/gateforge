// Synthetic dynamic-role file: roles read from a variable, NOT a literal.
// The detector MUST treat this as "no role requirement detected" because
// literal extraction cannot know the value at compile time — fail-closed.
import { Controller, Post } from '@nestjs/common';

@Controller('billing')
export class BillingController {
  @Post('refund')
  refund(): string {
    return 'ok';
  }
}