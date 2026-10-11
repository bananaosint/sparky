import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voxelize, project, closeEyes } from '../lib/voxel.js';

test('a blink paints the eye rows\' whites and pupils in the body colour, and leaves the mouth', () => {
  const W = [248, 250, 252];
  const P = [11, 10, 31];
  const B = [100, 50, 200];
  const sprite = [
    [null, W, B, P, null],
    [null, B, P, P, null],
  ];
  assert.deepEqual(closeEyes(sprite), [
    [null, B, B, B, null],
    [null, B, P, P, null],
  ]);
});

const R = [255, 0, 0];
const block = (n) => Array.from({ length: n }, () => Array(n).fill(R));
const view = { yaw: 0, pitch: 0, scale: 10, cx: 100, cy: 100 };

test('one pixel is one voxel with six faces', () => {
  const { voxels, faces } = voxelize([[R]]);
  assert.equal(voxels, 1);
  assert.equal(faces.length, 6);
});

test('the middle is thicker than the edges, so Sparky reads as rounded', () => {
  // 5×5: the outer ring is 1 voxel deep, the next ring 3, the centre 5.
  assert.equal(voxelize(block(5)).voxels, 16 * 1 + 8 * 3 + 1 * 5);
});

test('faces between touching voxels are dropped', () => {
  assert.equal(voxelize([[R, R]]).faces.length, 10);
  assert.equal(voxelize([[R, null, R]]).faces.length, 12);
});

test('seen head-on only the front face shows; turned, the side shows too', () => {
  const { faces } = voxelize([[R]]);
  assert.equal(project(faces, view).length, 1);
  assert.equal(project(faces, { ...view, yaw: Math.PI / 4 }).length, 2);
});

test('faces come back far to near, so nearer ones paint over', () => {
  const polys = project(voxelize(block(5)).faces, { ...view, yaw: 0.6, pitch: 0.3 });
  for (let i = 1; i < polys.length; i++) assert.ok(polys[i - 1].z >= polys[i].z);
});

test('light comes from the upper left: the top is brighter than the underside', () => {
  const { faces } = voxelize([[R]]);
  const fill = (pitch) => project(faces, { ...view, pitch }).find((p) => p.normal === (pitch > 0 ? 'top' : 'bottom')).fill;
  const red = (f) => Number(/rgb\((\d+)/.exec(f)[1]);
  assert.ok(red(fill(0.6)) > red(fill(-0.6)));
  assert.ok(red(fill(0.6)) <= 255);
});

test('the projected front face of a pixel at the centre is centred on screen', () => {
  const [front] = project(voxelize([[R]]).faces, view);
  const xs = front.points.map((p) => p[0]);
  const ys = front.points.map((p) => p[1]);
  assert.equal((Math.min(...xs) + Math.max(...xs)) / 2, 100);
  assert.equal((Math.min(...ys) + Math.max(...ys)) / 2, 100);
});
