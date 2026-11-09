/** Turn a getUserMedia failure into a message a person can act on. */
export function describeMediaError(mediaError: unknown): string {
  const errorName = mediaError instanceof DOMException ? mediaError.name : '';
  switch (errorName) {
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
