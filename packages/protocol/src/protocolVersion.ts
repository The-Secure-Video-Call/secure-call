import { z } from 'zod';

export const protocolVersionSchema = z.literal(1);
export type ProtocolVersion = z.infer<typeof protocolVersionSchema>;
