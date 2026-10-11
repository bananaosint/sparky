// Sparky in 3D: the pixel sprite extruded into voxels, thicker toward the middle so he reads as
// rounded, then turned, lit and projected into quads a 2D canvas can fill. No 3D library: a few
// hundred quads a frame is easy work for canvas, and the sprite stays the single source of his look.

const DIRS = [
  ['front', [0, 0, -1]],
  ['back', [0, 0, 1]],
  ['left', [-1, 0, 0]],
  ['right', [1, 0, 0]],
  ['top', [0, -1, 0]],
  ['bottom', [0, 1, 0]],
];

// How many steps each body pixel is from the nearest empty one (outside the sprite counts as empty).
function depthMap(sprite) {
  const h = sprite.length;
  const w = sprite[0].length;
  const dist = sprite.map((row) => row.map(() => 0));
  const queue = [];
  const empty = (x, y) => x < 0 || y < 0 || x >= w || y >= h || !sprite[y][x];
  const near = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!empty(x, y) && near.some(([dx, dy]) => empty(x + dx, y + dy))) {
        dist[y][x] = 1;
        queue.push([x, y]);
      }
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i];
    for (const [dx, dy] of near) {
      const nx = x + dx;
      const ny = y + dy;
      if (!empty(nx, ny) && !dist[ny][nx]) {
        dist[ny][nx] = dist[y][x] + 1;
        queue.push([nx, ny]);
      }
    }
  }
  return dist;
}

// `sprite`: rows of [r, g, b] or null. Returns the voxel count and every face no other voxel hides.
export function voxelize(sprite) {
  const h = sprite.length;
  const w = sprite[0].length;
  const dist = depthMap(sprite);
  const cells = new Map();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!sprite[y][x]) continue;
      const half = Math.min(2, dist[y][x] - 1);
      for (let z = -half; z <= half; z++) cells.set(`${x},${y},${z}`, { x, y, z, color: sprite[y][x] });
    }
  const faces = [];
  for (const { x, y, z, color } of cells.values()) {
    const centre = [x - w / 2 + 0.5, y - h / 2 + 0.5, z];
    for (const [name, n] of DIRS) {
      if (cells.has(`${x + n[0]},${y + n[1]},${z + n[2]}`)) continue;
      // The face's two in-plane axes, walked round its four corners.
      const [a, b] = [0, 1, 2].filter((i) => n[i] === 0);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([s, t]) => {
        const p = centre.map((c, i) => c + n[i] * 0.5);
        p[a] += s * 0.5;
        p[b] += t * 0.5;
        return p;
      });
      faces.push({ name, n, corners, color });
    }
  }
  return { voxels: cells.size, faces };
}

const EYE = [248, 250, 252];
const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

// Sparky blinking: in the rows that hold the white of an eye, every eye pixel (the white and the
// darkest pixel, the pupil) takes the body colour at the middle of the row. The mouth row has no white.
export function closeEyes(sprite) {
  return sprite.map((row) => {
    if (!row.some((c) => same(c, EYE))) return row;
    const body = row[Math.floor(row.length / 2)];
    const dark = row.filter(Boolean).reduce((d, c) => (c[0] + c[1] + c[2] < d[0] + d[1] + d[2] ? c : d));
    return row.map((c) => (same(c, EYE) || same(c, dark) ? body : c));
  });
}

// Light from the viewer's upper left and front, fixed to the screen rather than to Sparky.
const LIGHT = (() => {
  const v = [-0.4, -0.75, -0.55];
  const len = Math.hypot(...v);
  return v.map((c) => c / len);
})();
const AMBIENT = 0.4;
// The camera sits this many voxels in front; larger is flatter.
const DISTANCE = 40;

// Turn by `yaw` (around the vertical) then `pitch` (around the horizontal), perspective-project,
// drop faces turned away, and return quads far to near with their lit colour.
export function project(faces, { yaw, pitch, scale, cx, cy }) {
  const [cy1, sy1, cp, sp] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch)];
  const turn = ([x, y, z]) => {
    const x1 = x * cy1 + z * sy1;
    const z1 = -x * sy1 + z * cy1;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  };
  const out = [];
  for (const face of faces) {
    const n = turn(face.n);
    if (n[2] >= -1e-9) continue;
    const pts = face.corners.map(turn);
    const shade = AMBIENT + (1 - AMBIENT) * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
    out.push({
      normal: face.name,
      z: pts.reduce((sum, p) => sum + p[2], 0) / 4,
      points: pts.map(([x, y, z]) => {
        const f = DISTANCE / (DISTANCE + z);
        return [cx + x * scale * f, cy + y * scale * f];
      }),
      fill: `rgb(${face.color.map((c) => Math.round(c * shade)).join(',')})`,
    });
  }
  return out.sort((p, q) => q.z - p.z);
}
