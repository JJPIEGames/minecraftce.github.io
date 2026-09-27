import * as THREE from 'three';
import grassAtlasUrl from '../res/grass_atlas.png';
import oakTreeAtlasUrl from '../res/oak_tree_atlas.png';
import leavesAtlasUrl from '../res/leaves_atlas.png';
import waterTextureUrl from '../res/water_atlas.png';
import grassFoliageAtlasUrl from '../res/grass_folige_leaves_atlas.png';

export type Biome = 'woodland' | 'highlands' | 'desert' | 'tundra';

export interface TerrainOptions {
  seed: string;
  biome: Biome;
  chunkSize: number;
  radius: number;
  relief: number;
  removedColumns?: Record<string, number>;
  removedTreeParts?: string[];
}

export interface GeneratedTerrain {
  group: THREE.Group;
  blocks: number;
  chunks: number;
  dimensions: number;
  peak: number;
  trees: number;
  obstacles: Array<{ x: number; y: number; z: number; radius: number; bottom: number; top: number }>;
  spawn: { x: number; z: number; yaw: number };
  groundHeightAt: (worldX: number, worldZ: number) => number;
  cellAt: (worldX: number, worldZ: number) => { x: number; z: number };
}

const SEA_LEVEL = 8;
const palettes: Record<Biome, { top: THREE.Color; dirt: THREE.Color; stone: THREE.Color; snow: THREE.Color }> = {
  woodland: { top: new THREE.Color('#72a864'), dirt: new THREE.Color('#806347'), stone: new THREE.Color('#777d79'), snow: new THREE.Color('#e4e6da') },
  highlands: { top: new THREE.Color('#a1a979'), dirt: new THREE.Color('#776b59'), stone: new THREE.Color('#818a8a'), snow: new THREE.Color('#e8e9e3') },
  desert: { top: new THREE.Color('#d5b66f'), dirt: new THREE.Color('#b88b52'), stone: new THREE.Color('#8b7964'), snow: new THREE.Color('#e8d9ae') },
  tundra: { top: new THREE.Color('#9da98e'), dirt: new THREE.Color('#716f61'), stone: new THREE.Color('#7c878d'), snow: new THREE.Color('#e8eee8') },
};

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function lattice(seed: number, x: number, z: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const fadeX = tx * tx * (3 - 2 * tx);
  const fadeZ = tz * tz * (3 - 2 * tz);
  const a = lattice(seed, x0, z0);
  const b = lattice(seed, x0 + 1, z0);
  const c = lattice(seed, x0, z0 + 1);
  const d = lattice(seed, x0 + 1, z0 + 1);
  const north = THREE.MathUtils.lerp(a, b, fadeX);
  const south = THREE.MathUtils.lerp(c, d, fadeX);
  return THREE.MathUtils.lerp(north, south, fadeZ) * 2 - 1;
}

function heightAt(seed: number, x: number, z: number, relief: number, biome: Biome): number {
  const zoom = biome === 'highlands' ? 30 : biome === 'desert' ? 42 : 36;
  const broad = smoothNoise(seed, x / zoom, z / zoom) * 0.58;
  const detail = smoothNoise(seed + 91, x / 11, z / 11) * 0.24;
  const fine = smoothNoise(seed + 407, x / 4.8, z / 4.8) * 0.1;
  const ridgeNoise = 1 - Math.abs(smoothNoise(seed + 2201, x / 20, z / 20));
  const ridges = biome === 'highlands' ? (ridgeNoise - 0.5) * 0.64 : 0;
  const dunes = biome === 'desert' ? Math.sin((x + z * 0.45) / 15) * 0.12 : 0;
  return Math.max(3, Math.round(11 + (broad + detail + fine + ridges + dunes) * relief));
}

function faceColor(palette: typeof palettes[Biome], y: number, topY: number, seed: number, x: number, z: number): THREE.Color {
  let color: THREE.Color;
  if (topY >= 24 && y === topY) color = palette.snow;
  else if (y === topY) color = palette.top;
  else if (y < topY - 4) color = palette.stone;
  else color = palette.dirt;

  const variation = 0.94 + lattice(seed + y * 17, x, z) * 0.12;
  return color.clone().multiplyScalar(variation);
}

type UvRect = readonly [uMin: number, vMin: number, uMax: number, vMax: number];

const atlasRect = (firstRow: number, endRow: number): UvRect => [0, 1 - endRow / 64, 1, 1 - firstRow / 64];
const grassTopRect = atlasRect(0, 16);
const grassSideRect = atlasRect(16, 32);
const dirtSideRect = atlasRect(32, 48);
const grassBottomRect = atlasRect(48, 64);
const white = new THREE.Color('#ffffff');

function addQuad(
  positions: number[],
  colors: number[],
  uvs: number[] | undefined,
  corners: readonly [number, number, number][],
  color: THREE.Color,
  uvRect?: UvRect,
): void {
  const indices = [0, 1, 2, 0, 2, 3];
  const uvCorners: readonly [number, number][] | undefined = uvRect
    ? [[uvRect[0], uvRect[1]], [uvRect[0], uvRect[3]], [uvRect[2], uvRect[3]], [uvRect[2], uvRect[1]]]
    : undefined;
  for (const index of indices) {
    positions.push(...corners[index]);
    colors.push(color.r, color.g, color.b);
    if (uvs && uvCorners) uvs.push(...uvCorners[index]);
  }
}

export function generateTerrain(options: TerrainOptions): GeneratedTerrain {
  const { seed, biome, chunkSize, radius, relief } = options;
  const chunksPerSide = radius * 2 + 1;
  const dimensions = chunksPerSide * chunkSize;
  const seedValue = hashSeed(seed);
  const heights = new Int16Array(dimensions * dimensions);
  const palette = palettes[biome];
  const removedTreeParts = new Set(options.removedTreeParts ?? []);
  let peak = 0;

  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      const worldX = x - dimensions / 2;
      const worldZ = z - dimensions / 2;
      const originalHeight = heightAt(seedValue, worldX, worldZ, relief, biome);
      const height = Math.max(2, originalHeight - (options.removedColumns?.[`${x},${z}`] ?? 0));
      heights[z * dimensions + x] = height;
      peak = Math.max(peak, height);
    }
  }

  const group = new THREE.Group();
  const texturedPositions: number[] = [];
  const texturedColors: number[] = [];
  const texturedUvs: number[] = [];
  const origin = -dimensions / 2;
  let blocks = 0;

  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      const height = heights[z * dimensions + x];
      blocks += height;
      const x0 = origin + x;
      const x1 = x0 + 1;
      const z0 = origin + z;
      const z1 = z0 + 1;
      addQuad(texturedPositions, texturedColors, texturedUvs, [[x0, height, z0], [x0, height, z1], [x1, height, z1], [x1, height, z0]], white, grassTopRect);

      addQuad(texturedPositions, texturedColors, texturedUvs, [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], white, grassBottomRect);

      const neighbors = [
        { height: x > 0 ? heights[z * dimensions + x - 1] : 0, corners: (y0: number, y1: number): [number, number, number][] => [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]] },
        { height: x < dimensions - 1 ? heights[z * dimensions + x + 1] : 0, corners: (y0: number, y1: number): [number, number, number][] => [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
        { height: z > 0 ? heights[(z - 1) * dimensions + x] : 0, corners: (y0: number, y1: number): [number, number, number][] => [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
        { height: z < dimensions - 1 ? heights[(z + 1) * dimensions + x] : 0, corners: (y0: number, y1: number): [number, number, number][] => [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]] },
      ];

      for (const neighbor of neighbors) {
        for (let y = neighbor.height; y < height; y += 1) {
          if (y === height - 1) {
            addQuad(texturedPositions, texturedColors, texturedUvs, neighbor.corners(y, y + 1), white, grassSideRect);
          } else {
            addQuad(texturedPositions, texturedColors, texturedUvs, neighbor.corners(y, y + 1), white, dirtSideRect);
          }
        }
      }
    }
  }

  if (texturedPositions.length > 0) {
    const atlasTexture = new THREE.TextureLoader().load(grassAtlasUrl);
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    atlasTexture.magFilter = THREE.NearestFilter;
    atlasTexture.minFilter = THREE.NearestFilter;
    atlasTexture.generateMipmaps = false;
    const texturedGeometry = new THREE.BufferGeometry();
    texturedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(texturedPositions, 3));
    texturedGeometry.setAttribute('color', new THREE.Float32BufferAttribute(texturedColors, 3));
    texturedGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(texturedUvs, 2));
    texturedGeometry.computeVertexNormals();
    texturedGeometry.computeBoundingSphere();
    const texturedMaterial = new THREE.MeshStandardMaterial({ map: atlasTexture, vertexColors: true, roughness: 0.96, metalness: 0 });
    texturedMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.biomeTint = { value: palette.top.clone() };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform vec3 biomeTint;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float atlasMax = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);
        float atlasMin = min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);
        float atlasChroma = atlasMax - atlasMin;
        float grayMask = 1.0 - smoothstep(0.025, 0.12, atlasChroma);
        float grassAtlasRegion = step(0.5, vMapUv.y);
        float biomeMask = grayMask * grassAtlasRegion;
        diffuseColor.rgb *= mix(vec3(1.0), biomeTint, biomeMask);`,
      );
    };
    texturedMaterial.customProgramCacheKey = () => 'gray-atlas-biome-tint-v1';
    const texturedMesh = new THREE.Mesh(texturedGeometry, texturedMaterial);
    texturedMesh.name = 'terrain-block-mesh';
    texturedMesh.castShadow = true;
    texturedMesh.receiveShadow = true;
    group.add(texturedMesh);
  }

  const waterTexture = new THREE.TextureLoader().load(waterTextureUrl);
  waterTexture.colorSpace = THREE.SRGBColorSpace;
  waterTexture.wrapS = THREE.RepeatWrapping;
  waterTexture.wrapT = THREE.RepeatWrapping;
  waterTexture.repeat.set(dimensions, dimensions);
  waterTexture.magFilter = THREE.NearestFilter;
  waterTexture.minFilter = THREE.NearestFilter;
  waterTexture.generateMipmaps = false;
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(dimensions, dimensions),
    new THREE.MeshStandardMaterial({ map: waterTexture, color: '#ffffff', transparent: true, opacity: 0.82, roughness: 0.34, metalness: 0.02, side: THREE.DoubleSide }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, SEA_LEVEL + 0.03, 0);
  water.receiveShadow = true;
  group.add(water);

  const boundaryPositions: number[] = [];
  const min = -dimensions / 2;
  const boundarySteps = chunksPerSide;
  for (let boundary = 0; boundary <= boundarySteps; boundary += 1) {
    const grid = boundary * chunkSize;
    const lineX = min + grid;
    const lineZ = min + grid;
    for (let step = 0; step < dimensions; step += 1) {
      const leftX = Math.min(dimensions - 1, Math.max(0, grid - 1));
      const rightX = Math.min(dimensions - 1, grid);
      const topLeft = heights[step * dimensions + leftX] + 0.035;
      const topRight = heights[step * dimensions + rightX] + 0.035;
      boundaryPositions.push(lineX, topLeft, min + step + 0.5, lineX, topRight, min + step + 0.5);

      const topFront = heights[leftX * dimensions + step] + 0.035;
      const topBack = heights[rightX * dimensions + step] + 0.035;
      boundaryPositions.push(min + step + 0.5, topFront, lineZ, min + step + 0.5, topBack, lineZ);
    }
  }
  const boundaryGeometry = new THREE.BufferGeometry();
  boundaryGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boundaryPositions, 3));
  const boundaries = new THREE.LineSegments(boundaryGeometry, new THREE.LineBasicMaterial({ color: '#e2bf78', transparent: true, opacity: 0.46 }));
  boundaries.frustumCulled = false;
  group.add(boundaries);

  const trunkParts: Array<{ x: number; y: number; z: number; id: string }> = [];
  const leafParts: Array<{ x: number; y: number; z: number; color: THREE.Color; id: string }> = [];
  const obstacles: Array<{ x: number; y: number; z: number; radius: number; bottom: number; top: number }> = [];
  const treeCenters: Array<{ x: number; z: number }> = [];
  const treeSpacing = biome === 'desert' ? 13 : biome === 'highlands' ? 10 : 8;
  const treeChance = biome === 'woodland' ? 0.34 : biome === 'highlands' ? 0.2 : biome === 'tundra' ? 0.25 : 0.09;
  const treeCells = Math.ceil(dimensions / treeSpacing);
  let treeCount = 0;

  for (let cellZ = 0; cellZ < treeCells; cellZ += 1) {
    for (let cellX = 0; cellX < treeCells; cellX += 1) {
      if (lattice(seedValue + 761, cellX, cellZ) > treeChance) continue;
      const x = Math.floor(cellX * treeSpacing + lattice(seedValue + 83, cellX, cellZ) * treeSpacing);
      const z = Math.floor(cellZ * treeSpacing + lattice(seedValue + 197, cellX, cellZ) * treeSpacing);
      if (x < 2 || z < 2 || x >= dimensions - 2 || z >= dimensions - 2) continue;
      const ground = heights[z * dimensions + x];
      if (ground <= SEA_LEVEL + 1 || ground >= 23) continue;
      const worldX = origin + x + 0.5;
      const worldZ = origin + z + 0.5;
      const conifer = biome === 'highlands' || biome === 'tundra';
      const trunkHeight = (conifer ? 5 : 3) + Math.floor(lattice(seedValue + 313, x, z) * (conifer ? 4 : 3));
      const treeId = `${x},${z}`;
      treeCenters.push({ x: worldX, z: worldZ });
      treeCount += 1;

      for (let trunkY = 0; trunkY < trunkHeight; trunkY += 1) {
        const id = `trunk:${treeId}:${trunkY}`;
        if (removedTreeParts.has(id)) continue;
        const y = ground + trunkY + 0.5;
        trunkParts.push({ x: worldX, y, z: worldZ, id });
        obstacles.push({ x: worldX, y, z: worldZ, radius: 0.46, bottom: y - 0.5, top: y + 0.5 });
      }

      if (conifer) {
        for (let layer = 1; layer < trunkHeight; layer += 1) {
          const canopyRadius = Math.max(0, Math.floor((trunkHeight - layer) / 2.3));
          for (let dx = -canopyRadius; dx <= canopyRadius; dx += 1) {
            for (let dz = -canopyRadius; dz <= canopyRadius; dz += 1) {
              if (Math.abs(dx) + Math.abs(dz) > canopyRadius * 2 - 1) continue;
              const leafX = worldX + dx;
              const leafZ = worldZ + dz;
              const id = `leaf:${treeId}:${layer}:${dx}:${dz}`;
              if (removedTreeParts.has(id)) continue;
              const y = ground + trunkHeight - layer + 0.5;
              const color = palette.top.clone().multiplyScalar(0.82 + lattice(seedValue + 401, x + dx, z + dz + layer) * 0.24);
              leafParts.push({ x: leafX, y, z: leafZ, color, id });
              obstacles.push({ x: leafX, y, z: leafZ, radius: 0.46, bottom: y - 0.5, top: y + 0.5 });
            }
          }
        }
      } else {
        const canopyBase = ground + trunkHeight - (biome === 'desert' ? 1 : 2);
        for (let layer = 0; layer < 3; layer += 1) {
          const canopyRadius = layer === 1 ? 2 : 1;
          for (let dx = -canopyRadius; dx <= canopyRadius; dx += 1) {
            for (let dz = -canopyRadius; dz <= canopyRadius; dz += 1) {
              if (Math.abs(dx) + Math.abs(dz) > canopyRadius * 2 - 1) continue;
              if (dx === 0 && dz === 0 && layer === 0) continue;
              const id = `leaf:${treeId}:${layer}:${dx}:${dz}`;
              if (removedTreeParts.has(id)) continue;
              const y = canopyBase + layer + 0.5;
              const colorBase = biome === 'desert' ? new THREE.Color('#8c9160') : new THREE.Color('#638f59');
              const color = colorBase.multiplyScalar(0.86 + lattice(seedValue + layer * 41, x + dx, z + dz) * 0.2);
              const leafX = worldX + dx;
              const leafZ = worldZ + dz;
              leafParts.push({ x: leafX, y, z: leafZ, color, id });
              obstacles.push({ x: leafX, y, z: leafZ, radius: 0.46, bottom: y - 0.5, top: y + 0.5 });
            }
          }
        }
      }
    }
  }

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  if (trunkParts.length > 0) {
    const barkMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
    const endGrainMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
    new THREE.TextureLoader().load(oakTreeAtlasUrl, (oakAtlas) => {
      oakAtlas.colorSpace = THREE.SRGBColorSpace;
      oakAtlas.magFilter = THREE.NearestFilter;
      oakAtlas.minFilter = THREE.NearestFilter;
      oakAtlas.generateMipmaps = false;

      const barkTexture = oakAtlas.clone();
      barkTexture.repeat.set(1, 0.5);
      barkTexture.offset.set(0, 0);
      barkTexture.needsUpdate = true;
      barkMaterial.map = barkTexture;
      barkMaterial.needsUpdate = true;

      const endGrainTexture = oakAtlas.clone();
      endGrainTexture.repeat.set(1, 0.5);
      endGrainTexture.offset.set(0, 0.5);
      endGrainTexture.needsUpdate = true;
      endGrainMaterial.map = endGrainTexture;
      endGrainMaterial.needsUpdate = true;
      oakAtlas.dispose();
    });
    const trunks = new THREE.InstancedMesh(
      unitBox,
      [barkMaterial, barkMaterial, endGrainMaterial, endGrainMaterial, barkMaterial, barkMaterial],
      trunkParts.length,
    );
    trunks.name = 'tree-trunk-blocks';
    trunks.userData.breakPartIds = trunkParts.map((part) => part.id);
    const trunkMatrix = new THREE.Matrix4();
    trunkParts.forEach((part, index) => {
      trunkMatrix.makeTranslation(part.x, part.y, part.z);
      trunks.setMatrixAt(index, trunkMatrix);
    });
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    group.add(trunks);
  }
  if (leafParts.length > 0) {
    const leafMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 1,
      alphaTest: 0.36,
      side: THREE.DoubleSide,
    });
    new THREE.TextureLoader().load(leavesAtlasUrl, (leafAtlas) => {
      const image = leafAtlas.image as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
        pixels.data[pixel] = 255;
        pixels.data[pixel + 1] = 255;
        pixels.data[pixel + 2] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const colorizedMask = new THREE.CanvasTexture(canvas);
      colorizedMask.colorSpace = THREE.SRGBColorSpace;
      colorizedMask.magFilter = THREE.NearestFilter;
      colorizedMask.minFilter = THREE.NearestFilter;
      colorizedMask.generateMipmaps = false;
      leafMaterial.map = colorizedMask;
      leafMaterial.needsUpdate = true;
      leafAtlas.dispose();
    });
    const leaves = new THREE.InstancedMesh(unitBox, leafMaterial, leafParts.length);
    leaves.name = 'tree-leaf-blocks';
    leaves.userData.breakPartIds = leafParts.map((part) => part.id);
    const leafMatrix = new THREE.Matrix4();
    leafParts.forEach((part, index) => {
      leafMatrix.makeTranslation(part.x, part.y, part.z);
      leaves.setMatrixAt(index, leafMatrix);
      leaves.setColorAt(index, part.color);
    });
    leaves.instanceMatrix.needsUpdate = true;
    if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    leaves.castShadow = true;
    leaves.receiveShadow = true;
    group.add(leaves);
  }

  const grassParts: Array<{ x: number; y: number; z: number; color: THREE.Color }> = [];
  const grassDensity = biome === 'woodland' ? 0.13 : biome === 'highlands' ? 0.17 : biome === 'tundra' ? 0.1 : 0.035;
  for (let z = 1; z < dimensions - 1; z += 1) {
    for (let x = 1; x < dimensions - 1; x += 1) {
      if (lattice(seedValue + 1919, x, z) > grassDensity) continue;
      const ground = heights[z * dimensions + x];
      if (ground <= SEA_LEVEL + 1 || ground >= 23) continue;
      if (lattice(seedValue + 2477, x, z) < 0.18) continue;
      const tint = palette.top.clone().multiplyScalar(0.82 + lattice(seedValue + 3011, x, z) * 0.3);
      grassParts.push({ x: origin + x + 0.5, y: ground, z: origin + z + 0.5, color: tint });
    }
  }

  if (grassParts.length > 0) {
    const grassGeometry = new THREE.PlaneGeometry(0.72, 0.76);
    grassGeometry.translate(0, 0.38, 0);
    const grassMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      roughness: 1,
      alphaTest: 0.34,
      side: THREE.DoubleSide,
    });
    new THREE.TextureLoader().load(grassFoliageAtlasUrl, (grassAtlas) => {
      const image = grassAtlas.image as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
        pixels.data[pixel] = 255;
        pixels.data[pixel + 1] = 255;
        pixels.data[pixel + 2] = 255;
      }
      context.putImageData(pixels, 0, 0);
      const maskTexture = new THREE.CanvasTexture(canvas);
      maskTexture.magFilter = THREE.NearestFilter;
      maskTexture.minFilter = THREE.NearestFilter;
      maskTexture.generateMipmaps = false;
      grassMaterial.map = maskTexture;
      grassMaterial.needsUpdate = true;
      grassAtlas.dispose();
    });

    const grassTufts = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassParts.length * 2);
    const grassMatrix = new THREE.Matrix4();
    const grassRotation = new THREE.Quaternion();
    const grassPosition = new THREE.Vector3();
    const grassScale = new THREE.Vector3(1, 1, 1);
    grassParts.forEach((part, index) => {
      grassPosition.set(part.x, part.y, part.z);
      grassRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), lattice(seedValue + 3203, index, 0) * Math.PI);
      grassMatrix.compose(grassPosition, grassRotation, grassScale);
      grassTufts.setMatrixAt(index * 2, grassMatrix);
      grassTufts.setColorAt(index * 2, part.color);
      grassRotation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      grassMatrix.compose(grassPosition, grassRotation, grassScale);
      grassTufts.setMatrixAt(index * 2 + 1, grassMatrix);
      grassTufts.setColorAt(index * 2 + 1, part.color);
    });
    grassTufts.instanceMatrix.needsUpdate = true;
    if (grassTufts.instanceColor) grassTufts.instanceColor.needsUpdate = true;
    grassTufts.castShadow = true;
    grassTufts.receiveShadow = true;
    group.add(grassTufts);
  }

  const groundHeightAt = (worldX: number, worldZ: number): number => {
    const x = THREE.MathUtils.clamp(Math.floor(worldX - origin), 0, dimensions - 1);
    const z = THREE.MathUtils.clamp(Math.floor(worldZ - origin), 0, dimensions - 1);
    return heights[z * dimensions + x];
  };

  const cellAt = (worldX: number, worldZ: number): { x: number; z: number } => ({
    x: THREE.MathUtils.clamp(Math.floor(worldX - origin), 0, dimensions - 1),
    z: THREE.MathUtils.clamp(Math.floor(worldZ - origin), 0, dimensions - 1),
  });

  let spawn = { x: 0, z: 0, yaw: 0 };
  let bestSpawnScore = -Infinity;
  const spawnLimit = dimensions / 2 - 5;
  for (let x = -spawnLimit; x <= spawnLimit; x += 2) {
    for (let z = -spawnLimit; z <= spawnLimit; z += 2) {
      if (groundHeightAt(x, z) <= SEA_LEVEL + 1) continue;
      for (let direction = 0; direction < 8; direction += 1) {
        const yaw = direction * Math.PI / 4;
        let viewClearance = Infinity;
        for (let sample = 1; sample <= 7; sample += 1) {
          const viewX = x - Math.sin(yaw) * sample * 2.5;
          const viewZ = z - Math.cos(yaw) * sample * 2.5;
          for (const obstacle of treeCenters) {
            viewClearance = Math.min(viewClearance, Math.hypot(viewX - obstacle.x, viewZ - obstacle.z) - obstacle.radius - 2.5);
          }
        }
        const score = Math.min(viewClearance, 8) - Math.hypot(x, z) * 0.16;
        if (score > bestSpawnScore) {
          bestSpawnScore = score;
          spawn = { x, z, yaw };
        }
      }
    }
  }

  return { group, blocks, chunks: chunksPerSide * chunksPerSide, dimensions, peak, trees: treeCount, obstacles, spawn, groundHeightAt, cellAt };
}
