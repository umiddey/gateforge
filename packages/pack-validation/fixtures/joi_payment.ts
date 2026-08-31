/**
 * Fixture: joi schema for payment validation.
 */
import Joi from 'joi';

export const paymentSchema = Joi.object({
  amount_cents: Joi.number().integer().min(1).required(),
  currency: Joi.string().valid('USD', 'EUR', 'GBP').required(),
});
