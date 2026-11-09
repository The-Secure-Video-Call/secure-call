/** Turn a getUserMedia failure into a message a person can act on. */
export function describeMediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera or microphone access was denied. Allow access in your browser settings and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera or microphone was found. Connect one and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Your camera or microphone is in use by another app or could not be started.';
    default:
      return 'Could not start your camera and microphone.';
  }
}

/** Build the shareable link. The secret goes only in the fragment, which browsers never send. */
export function buildCallLink(origin: string, encodedSecret: string): string {
  return `${origin}/#${encodedSecret}`;
}

/** Extract the fragment value (without "#") from a location hash. */
export function fragmentOf(hash: string): string {
  return hash.startsWith('#') ? hash.slice(1) : hash;
}
