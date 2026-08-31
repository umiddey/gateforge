/**
 * Fixture: yup schema for user settings.
 */
import * as yup from 'yup';

export const settingsSchema = yup.object({
  theme: yup.string().oneOf(['light', 'dark', 'auto']).required(),
  notify: yup.boolean().required(),
});
