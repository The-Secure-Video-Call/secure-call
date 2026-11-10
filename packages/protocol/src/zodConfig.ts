import { z } from 'zod';

// The web app's CSP has no 'unsafe-eval' and enforces Trusted Types, so zod's optional
// `new Function` speed-up is blocked anyway. Without `jitless`, zod still probes for it, and
// the blocked probe is reported as a CSP violation on every page load. With it, zod never tries.
z.config({ jitless: true });
