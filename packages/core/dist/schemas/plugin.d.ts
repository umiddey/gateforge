/**
 * PluginRegistration schema: the pinned identity of a plugin as it
 * appears in run manifests (pin #4) and the GPP/2 handshake (pin #5).
 * Mismatch between the registered and the answering plugin identity is
 * a fail-closed protocol error (GF-12/18, enforced by plugin-protocol).
 */
import { z } from 'zod';
/** Pinned plugin identity. */
export declare const PluginRegistrationSchema: z.ZodObject<{
    id: z.ZodString;
    version: z.ZodString;
    transport: z.ZodEnum<{
        subprocess: "subprocess";
        "in-process": "in-process";
    }>;
}, z.core.$strict>;
/** Inferred plugin-registration shape. */
export type PluginRegistration = z.infer<typeof PluginRegistrationSchema>;
//# sourceMappingURL=plugin.d.ts.map