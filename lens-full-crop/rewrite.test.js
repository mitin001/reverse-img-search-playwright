// node lens-full-crop/rewrite.test.js
import assert from 'node:assert/strict';
import { fullCropUrl } from './rewrite.js';

// Synthetic vsint: field 1 = 2, then the four-float crop box at 0.3/0.4/0.2/0.25.
const b = Buffer.from([0x08, 0x02, 0x12, 0x00, 0x0d, 0, 0, 0, 0, 0x15, 0, 0, 0, 0, 0x1d, 0, 0, 0, 0, 0x25, 0, 0, 0, 0, 0x30, 0x01]);
[0.3, 0.4, 0.2, 0.25].forEach((v, n) => b.writeFloatLE(v, 5 + n * 5));
const href = `https://www.google.com/search?q=x&vsint=${b.toString('base64url')}&udm=26`;

const want = Buffer.from(b);
want[1] = 4;
[0.5, 0.5, 1, 1].forEach((v, n) => want.writeFloatLE(v, 5 + n * 5));
const out = new URL(fullCropUrl(href));
assert.equal(out.searchParams.get('vsint'), want.toString('base64url'));
assert.equal(out.searchParams.get('q'), 'x');
assert.equal(out.searchParams.get('udm'), '26');

assert.equal(fullCropUrl('https://www.google.com/search?q=x'), null);
assert.equal(fullCropUrl('https://www.google.com/search?vsint=CAIQAQ'), null); // no crop box
console.log('ok');
