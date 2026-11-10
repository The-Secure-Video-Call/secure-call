/**
 * A fresh DTLS certificate for one peer connection, and the commitment to its fingerprint that
 * goes into our `hello` (crypto/fingerprintCommitment.ts, issue #94).
 *
 * Every RTCPeerConnection gets its own certificate, made in memory, used once and never stored.
 * With a reused certificate, someone in the middle could force a reconnect, learn both
 * fingerprints in a throwaway attempt and search for a matching pair before the real one.
 */
import { computeFingerprintCommitment } from '@/crypto/fingerprintCommitment';
import { readFingerprintFromSdp } from '@/crypto/safetyCode';

export type LocalCertificate = {
  certificate: RTCCertificate;
  /** The fingerprint the browser puts in our SDP for this certificate, normalised. */
  fingerprint: string;
  /** Of that fingerprint, sent in our hello. */
  fingerprintCommitment: string;
};

/** ECDSA P-256: at least 128-bit security, and fast to generate (ASVS V11.2.3). */
const CERTIFICATE_KEY_PARAMETERS: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };

/** The part of RTCPeerConnection that reading our own fingerprint needs; tests pass a mock. */
export type FingerprintProbe = Pick<
  RTCPeerConnection,
  'createDataChannel' | 'createOffer' | 'close'
>;

/**
 * The normalised fingerprint the browser will put in our SDP for `certificate`. It is read from an
 * offer of a throwaway local peer connection: `RTCCertificate.getFingerprints()` is not in every
 * browser, and the SDP is exactly what the other side checks. The probe has no ICE servers and
 * never sets a description, so it sends nothing over the network, and it is closed at once.
 */
export async function readCertificateFingerprint(
  certificate: RTCCertificate,
  createProbe: (certificate: RTCCertificate) => FingerprintProbe = (probeCertificate) =>
    new RTCPeerConnection({ certificates: [probeCertificate] }),
): Promise<string> {
  const probe = createProbe(certificate);
  try {
    probe.createDataChannel('fingerprint');
    const probeOffer = await probe.createOffer();
    return readFingerprintFromSdp(probeOffer.sdp ?? '');
  } finally {
    probe.close();
  }
}

/** Makes a new certificate and commits to its fingerprint. Called once per peer connection. */
export async function prepareLocalCertificate(
  options: {
    generateCertificate?: () => Promise<RTCCertificate>;
    createProbe?: (certificate: RTCCertificate) => FingerprintProbe;
  } = {},
): Promise<LocalCertificate> {
  const generateCertificate =
    options.generateCertificate ??
    (() => RTCPeerConnection.generateCertificate(CERTIFICATE_KEY_PARAMETERS));
  const certificate = await generateCertificate();
  const fingerprint = await readCertificateFingerprint(certificate, options.createProbe);
  return {
    certificate,
    fingerprint,
    fingerprintCommitment: await computeFingerprintCommitment(fingerprint),
  };
}
