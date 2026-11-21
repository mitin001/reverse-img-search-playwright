/**
 * Same trick as expandLensCrop in ../reverse-search.js: `vsint` is a base64url
 * protobuf whose crop box is four floats (centre x, centre y, width, height)
 * tagged 0x0d/0x15/0x1d/0x25. Its first field 2 means "initial load" (Lens
 * auto-crops), 4 means "user crop" (left alone). Mark it a user crop of
 * 0.5/0.5/1/1. Returns the new URL, or null if there is nothing to rewrite.
 */
export function fullCropUrl(href) {
  const url = new URL(href);
  const vsint = url.searchParams.get('vsint');
  if (!vsint) return null;
  const b = Uint8Array.from(atob(vsint.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const box = b.findIndex((_, k) => b[k] === 0x0d && b[k + 5] === 0x15 && b[k + 10] === 0x1d && b[k + 15] === 0x25);
  if (b[0] !== 0x08 || box === -1) return null;
  b[1] = 4;
  const view = new DataView(b.buffer);
  [0.5, 0.5, 1, 1].forEach((v, n) => view.setFloat32(box + 1 + n * 5, v, true));
  url.searchParams.set('vsint', btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  return url.href;
}
