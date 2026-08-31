// NestJS-style decorator fixture for pack-webhook detector.
// Uses @webhook('provider.endpoint') and @on('webhook.provider.endpoint').

import { Controller, Post, All } from '@nestjs/common';

@Controller('webhooks')
export class DecoratedWebhookController {
  @Post('/stripe/payments')
  @webhook('stripe.payments')
  stripeHandler() {
    return { ok: true };
  }

  @Post('/github/push')
  @on('webhook.github.push')
  githubHandler() {
    return { ok: true };
  }

  @All('/generic')
  @webhook('generic.endpoint')
  genericHandler() {
    return { ok: true };
  }
}