/** Encode bytes as standard padded base64 (RFC 4648 §4), the form the signaling contract uses. */
export function toBase64(bytesToEncode: Uint8Array): string {
  let binaryString = '';
  for (const byteValue of bytesToEncode) binaryString += String.fromCharCode(byteValue);
  return btoa(binaryString);
}

/**
 * Decode standard padded base64. Returns null for anything that is not canonical base64 (wrong
 * characters, wrong padding, or leftover bits), so one value has exactly one valid encoding.
 */
export function fromBase64(base64Text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text) || base64Text.length % 4 !== 0) return null;
  const binaryString = atob(base64Text);
  const decodedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) decodedBytes[i] = binaryString.charCodeAt(i);
  return toBase64(decodedBytes) === base64Text ? decodedBytes : null;
}
