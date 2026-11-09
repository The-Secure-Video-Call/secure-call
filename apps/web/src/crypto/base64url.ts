/** Encode bytes as unpadded base64url (RFC 4648 §5). */
export function toBase64Url(bytesToEncode: Uint8Array): string {
  let binaryString = '';
  for (const byteValue of bytesToEncode) binaryString += String.fromCharCode(byteValue);
  return btoa(binaryString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded base64url. Returns null for anything that is not strictly valid base64url. */
export function fromBase64Url(base64UrlText: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(base64UrlText) || base64UrlText.length % 4 === 1) return null;
  const paddedBase64Text =
    base64UrlText.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (base64UrlText.length % 4)) % 4);
  const binaryString = atob(paddedBase64Text);
  const decodedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) decodedBytes[i] = binaryString.charCodeAt(i);
  return decodedBytes;
}
