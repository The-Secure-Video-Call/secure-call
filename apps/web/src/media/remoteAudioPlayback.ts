export type RemoteAudioPlaybackState = 'playing' | 'needs-tap';

/**
 * Starts a media element and says whether the person must tap to start audio. Browsers (iOS
 * Safari above all) reject `play()` with NotAllowedError until a user gesture. An AbortError means
 * a newer stream replaced this one, so a newer attempt decides; it is not a block.
 * Any other failure also shows the tap button, so playback never fails silently.
 */
export async function tryPlayMediaElement(
  mediaElement: Pick<HTMLMediaElement, 'play'>,
): Promise<RemoteAudioPlaybackState | 'superseded'> {
  try {
    await mediaElement.play();
    return 'playing';
  } catch (playError) {
    if (playError instanceof DOMException && playError.name === 'AbortError') return 'superseded';
    return 'needs-tap';
  }
}
