import { describe, expect, it, vi } from 'vitest';
import { computeFingerprintCommitment } from '@/crypto/fingerprintCommitment';
import {
  prepareLocalCertificate,
  readCertificateFingerprint,
  type FingerprintProbe,
} from '@/rtc/localCertificate';

const FINGERPRINT = `sha-256 ${Array.from({ length: 32 }, () => 'AB').join(':')}`;

function createProbe(offerSdp: string | undefined) {
  return {
    createDataChannel: vi.fn(),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: offerSdp }) as RTCSessionDescriptionInit),
    close: vi.fn(),
  };
}

describe('local certificate', () => {
  it('makes a new ECDSA P-256 certificate each time and commits to the fingerprint its SDP shows', async () => {
    const certificates = [{ id: 1 }, { id: 2 }] as unknown as RTCCertificate[];
    const generateCertificate = vi.fn(
      async () => certificates[generateCertificate.mock.calls.length - 1]!,
    );
    const probesByCertificate = new Map<RTCCertificate, ReturnType<typeof createProbe>>();
    const createProbeFor = (certificate: RTCCertificate) => {
      const probe = createProbe(`v=0\r\na=fingerprint:${FINGERPRINT.toLowerCase()}\r\n`);
      probesByCertificate.set(certificate, probe);
      return probe as unknown as FingerprintProbe;
    };
    const first = await prepareLocalCertificate({
      generateCertificate,
      createProbe: createProbeFor,
    });
    const second = await prepareLocalCertificate({
      generateCertificate,
      createProbe: createProbeFor,
    });
    expect(generateCertificate).toHaveBeenCalledTimes(2);
    expect(first.certificate).toBe(certificates[0]);
    expect(second.certificate).toBe(certificates[1]);
    expect(first.fingerprintCommitment).toBe(await computeFingerprintCommitment(FINGERPRINT));
    for (const probe of probesByCertificate.values()) {
      expect(probe.createDataChannel).toHaveBeenCalled();
      expect(probe.close).toHaveBeenCalled();
    }
  });

  it('uses ECDSA P-256 by default', async () => {
    const generateCertificate = vi.fn(async () => ({}) as RTCCertificate);
    vi.stubGlobal('RTCPeerConnection', Object.assign(vi.fn(), { generateCertificate }));
    try {
      await prepareLocalCertificate({
        createProbe: () =>
          createProbe(`a=fingerprint:${FINGERPRINT}\r\n`) as unknown as FingerprintProbe,
      });
      expect(generateCertificate).toHaveBeenCalledWith({ name: 'ECDSA', namedCurve: 'P-256' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('negative: a probe offer without a single valid fingerprint fails, and the probe is closed', async () => {
    for (const offerSdp of [undefined, 'v=0\r\n', `a=fingerprint:sha-256 AB\r\n`]) {
      const probe = createProbe(offerSdp);
      await expect(
        readCertificateFingerprint(
          {} as RTCCertificate,
          () => probe as unknown as FingerprintProbe,
        ),
      ).rejects.toThrow(/Safety code unavailable/);
      expect(probe.close).toHaveBeenCalled();
    }
  });

  it('negative: a certificate that cannot be made is not hidden', async () => {
    await expect(
      prepareLocalCertificate({
        generateCertificate: async () => {
          throw new Error('not supported');
        },
      }),
    ).rejects.toThrow('not supported');
  });
});
