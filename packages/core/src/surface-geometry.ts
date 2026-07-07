// Logical (post-buffer_scale / buffer_transform / wp_viewport-dst) size of
// surface content. Single definition so the render path (gpu/compositor.ts)
// and the input path (surface-hit-test.ts) compute the same answer over
// their different surface record types -- a divergence puts clicks in
// different places than pixels.
export function logicalContentSize(
  bufferWidth: number, bufferHeight: number,
  bufferScale: number, bufferTransform: number,
  viewportDst: { width: number; height: number } | null | undefined,
): { w: number; h: number } {
  if (viewportDst && viewportDst.width > 0 && viewportDst.height > 0) {
    return { w: viewportDst.width, h: viewportDst.height };
  }
  const scale = bufferScale || 1;
  // buffer_transform values 1, 3, 5, 7 are 90/270 rotations and swap axes.
  const t = bufferTransform;
  const rotated = t === 1 || t === 3 || t === 5 || t === 7;
  const w = rotated ? bufferHeight : bufferWidth;
  const h = rotated ? bufferWidth : bufferHeight;
  return { w: w / scale, h: h / scale };
}
