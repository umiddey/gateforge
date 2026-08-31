/**
 * Fixture: zod schema for account creation with boundary constraints.
 *
 *   first_name: 1..50 chars
 *   last_name:  1..50 chars
 *   email:      basic email regex
 */
import { z } from 'zod';

export const accountCreateSchema = z.object({
  first_name: z.string().min(1).max(50),
  last_name: z.string().min(1).max(50),
  email: z.string().email(),
});
