import { describe, expect, it } from 'vitest';
import { canSwitchCamera, pickNextCameraDeviceId } from '@/media/cameraSwitching';

describe('canSwitchCamera', () => {
  it('is false with no camera or one camera (the button stays hidden)', () => {
    expect(canSwitchCamera([])).toBe(false);
    expect(canSwitchCamera(['front'])).toBe(false);
  });
  it('is false when the same camera is listed twice', () => {
    expect(canSwitchCamera(['front', 'front'])).toBe(false);
  });
  it('is true with two different cameras', () => {
    expect(canSwitchCamera(['front', 'back'])).toBe(true);
  });
});

describe('pickNextCameraDeviceId', () => {
  it('goes to the next camera and wraps around', () => {
    expect(pickNextCameraDeviceId(['front', 'back', 'wide'], 'front')).toBe('back');
    expect(pickNextCameraDeviceId(['front', 'back', 'wide'], 'wide')).toBe('front');
  });
  it('returns null with only one camera', () => {
    expect(pickNextCameraDeviceId(['front'], 'front')).toBeNull();
    expect(pickNextCameraDeviceId([], null)).toBeNull();
  });
  it('starts at the first camera when the current one is unknown', () => {
    expect(pickNextCameraDeviceId(['front', 'back'], 'gone')).toBe('front');
    expect(pickNextCameraDeviceId(['front', 'back'], null)).toBe('front');
  });
});
