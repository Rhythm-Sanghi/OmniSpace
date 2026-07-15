export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CapturingDeviceRef {
  x: number;
  y: number;
  dpiScale: number;
}

/**
 * Translates a coordinate within the rendering <video> element
 * back to a physical pixel coordinate on the capturing device's display.
 * Returns null if the coordinate falls within the video letterbox/pillarbox margins.
 */
export function translateToRealCoordinates(
  videoSpaceClick: Point,
  videoElementRect: { width: number; height: number },
  sourceWindowRect: Rect,
  capturingDevice: CapturingDeviceRef
): Point | null {
  if (videoElementRect.width <= 0 || videoElementRect.height <= 0) return null;
  if (sourceWindowRect.width <= 0 || sourceWindowRect.height <= 0) return null;

  // Calculate aspect ratios
  const streamAspectRatio = sourceWindowRect.width / sourceWindowRect.height;
  const elementAspectRatio = videoElementRect.width / videoElementRect.height;

  let activeWidth = videoElementRect.width;
  let activeHeight = videoElementRect.height;
  let offsetX = 0;
  let offsetY = 0;

  if (elementAspectRatio > streamAspectRatio) {
    // Pillarboxed (vertical bars on left/right)
    activeWidth = videoElementRect.height * streamAspectRatio;
    offsetX = (videoElementRect.width - activeWidth) / 2;
  } else {
    // Letterboxed (horizontal bars on top/bottom)
    activeHeight = videoElementRect.width / streamAspectRatio;
    offsetY = (videoElementRect.height - activeHeight) / 2;
  }

  // Calculate position relative to active video feed area
  const clickX = videoSpaceClick.x - offsetX;
  const clickY = videoSpaceClick.y - offsetY;

  // If click lands in the letterbox/pillarbox padding, discard it
  if (clickX < 0 || clickX > activeWidth || clickY < 0 || clickY > activeHeight) {
    return null;
  }

  // Map to normalized 0-1 fraction
  const fracX = clickX / activeWidth;
  const fracY = clickY / activeHeight;

  // Map fraction to source window logical CSS space
  const winLocalCssX = fracX * sourceWindowRect.width;
  const winLocalCssY = fracY * sourceWindowRect.height;

  // Compute global shared plane coordinates
  const globalCssX = sourceWindowRect.x + winLocalCssX;
  const globalCssY = sourceWindowRect.y + winLocalCssY;

  // Project global plane coordinates back to capturing device screen space
  const lx = globalCssX - capturingDevice.x;
  const ly = globalCssY - capturingDevice.y;

  // Scale CSS pixels to host physical pixels
  const realX = Math.round(lx * capturingDevice.dpiScale);
  const realY = Math.round(ly * capturingDevice.dpiScale);

  return { x: realX, y: realY };
}
