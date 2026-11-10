/** The switch button is only useful (and only shown) when there is another camera to switch to. */
export function canSwitchCamera(cameraDeviceIds: readonly string[]): boolean {
  return new Set(cameraDeviceIds).size > 1;
}

/**
 * Picks the camera after the current one, going round in a circle. Returns null when there is no
 * other camera. If the current camera is not in the list (unplugged, unknown), the first is used.
 */
export function pickNextCameraDeviceId(
  cameraDeviceIds: readonly string[],
  currentCameraDeviceId: string | null,
): string | null {
  const uniqueCameraDeviceIds = [...new Set(cameraDeviceIds)];
  if (!canSwitchCamera(uniqueCameraDeviceIds)) return null;
  const currentIndex =
    currentCameraDeviceId === null ? -1 : uniqueCameraDeviceIds.indexOf(currentCameraDeviceId);
  return uniqueCameraDeviceIds[(currentIndex + 1) % uniqueCameraDeviceIds.length] ?? null;
}
