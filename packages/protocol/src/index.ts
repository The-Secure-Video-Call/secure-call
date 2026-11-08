import { z } from 'zod';

/** Placeholder schema; real signaling messages arrive in M1/M2. */
export const protocolVersionSchema = z.literal(1);
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
