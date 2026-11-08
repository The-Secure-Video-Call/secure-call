import { expect, it } from 'vitest';
import { SERVICE_NAME } from './index';

it('has a service name', () => {
  expect(SERVICE_NAME).toBe('secure-call-signaling');
});
