/**
 * PluginRegistration schema: the pinned identity of a plugin as it
 * appears in run manifests (pin #4) and the GPP/2 handshake (pin #5).
 * Mismatch between the registered and the answering plugin identity is
 * a fail-closed protocol error (GF-12/18, enforced by plugin-protocol).
 */
import { z } from 'zod';
import { TransportSchema } from './common.js';
/** Pinned plugin identity. */
export const PluginRegistrationSchema = z
    .object({
    /** Plugin id, e.g. `gateforge.pack-sqlalchemy`. */
    id: z.string().min(1),
    /** Plugin version string (semver recommended, not required). */
    version: z.string().min(1),
    /** How the engine talks to this plugin (ADR 0002). */
    transport: TransportSchema,
})
    .strict();
//# sourceMappingURL=plugin.js.map