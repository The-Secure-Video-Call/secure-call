/** HKDF-SHA256 (RFC 5869) via Web Crypto. Returns `outputLengthBytes` bytes of derived key material. */
export async function hkdfSha256(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  contextInfo: Uint8Array,
  outputLengthBytes: number,
): Promise<Uint8Array> {
  const hkdfBaseKey = await crypto.subtle.importKey(
    'raw',
    inputKeyMaterial as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      info: contextInfo as BufferSource,
    },
    hkdfBaseKey,
    outputLengthBytes * 8,
  );
  return new Uint8Array(derivedBits);
}
