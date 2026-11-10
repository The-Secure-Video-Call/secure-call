// Computes the value of an `integrity` attribute with the Web Crypto API (no libraries).

export type IntegrityAlgorithm = 'sha256' | 'sha384' | 'sha512';

const WEB_CRYPTO_NAME_BY_ALGORITHM: Record<IntegrityAlgorithm, string> = {
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

/** For example `sha384-WeF0h3dE...`. */
export async function computeIntegrityAttributeValue(
  fileBytes: Uint8Array,
  algorithm: IntegrityAlgorithm = 'sha384',
): Promise<string> {
  const digestBuffer = await crypto.subtle.digest(
    WEB_CRYPTO_NAME_BY_ALGORITHM[algorithm],
    new Uint8Array(fileBytes),
  );
  let digestBinaryString = '';
  for (const digestByte of new Uint8Array(digestBuffer)) {
    digestBinaryString += String.fromCharCode(digestByte);
  }
  return `${algorithm}-${btoa(digestBinaryString)}`;
}
