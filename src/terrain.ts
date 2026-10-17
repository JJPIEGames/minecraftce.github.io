import * as THREE from 'three';
import grassAtlasUrl from '../res/grass_atlas.png';
import sandAtlasUrl from '../res/sand_atlas.png';
import oakTreeAtlasUrl from '../res/oak_tree_atlas.png';
import leavesAtlasUrl from '../res/leaves_atlas.png';
import waterTextureUrl from '../res/water_atlas.png';
import grassFoliageAtlasUrl from '../res/grass_folige_leaves_atlas.png';

export type Biome = 'plains' | 'woodland' | 'highlands' | 'desert' | 'tundra';

export interface TerrainOptions {
  seed: string;
  chunkSize: number;
  radius: number;
  relief: number;
  centerX?: number;
  centerZ?: number;
  removedColumns?: Record<string, number>;
  removedTreeParts?: string[];
  removedGrassFoliage?: string[];
}

export interface GeneratedTerrain {
  group: THREE.Group;
  blocks: number;
  chunks: number;
  dimensions: number;
  peak: number;
  trees: number;
  obstacles: Array<{ x: number; y: number; z: number; radius: number; bottom: number; top: number; fullBlock?: boolean }>;
  spawn: { x: number; z: number; yaw: number };
  groundHeightAt: (worldX: number, worldZ: number) => number;
  caveFloorAt: (worldX: number, worldZ: number, feetY: number) => number | undefined;
  caveCeilingAt: (worldX: number, worldZ: number, feetY: number) => number | undefined;
  cellAt: (worldX: number, worldZ: number) => { x: number; z: number };
}

const SEA_LEVEL = 8;
const palettes: Record<Biome, { top: THREE.Color; dirt: THREE.Color; stone: THREE.Color; snow: THREE.Color }> = {
  plains: { top: new THREE.Color('#8cab62'), dirt: new THREE.Color('#806347'), stone: new THREE.Color('#777d79'), snow: new THREE.Color('#e4e6da') },
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

function lattice3(seed: number, x: number, y: number, z: number): number {
  let value = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + seed;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const ty = y - y0;
  const tz = z - z0;
  const fade = (amount: number): number => amount * amount * (3 - 2 * amount);
  const fx = fade(tx);
  const fy = fade(ty);
  const fz = fade(tz);
  const lowerA = THREE.MathUtils.lerp(lattice3(seed, x0, y0, z0), lattice3(seed, x0 + 1, y0, z0), fx);
  const lowerB = THREE.MathUtils.lerp(lattice3(seed, x0, y0, z0 + 1), lattice3(seed, x0 + 1, y0, z0 + 1), fx);
  const upperA = THREE.MathUtils.lerp(lattice3(seed, x0, y0 + 1, z0), lattice3(seed, x0 + 1, y0 + 1, z0), fx);
  const upperB = THREE.MathUtils.lerp(lattice3(seed, x0, y0 + 1, z0 + 1), lattice3(seed, x0 + 1, y0 + 1, z0 + 1), fx);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(lowerA, lowerB, fz), THREE.MathUtils.lerp(upperA, upperB, fz), fy) * 2 - 1;
}

interface CaveEntrance {
  x: number;
  z: number;
  surfaceY: number;
  surfaceOpening: boolean;
  angle: number;
  branchAngle: number;
  length: number;
  descent: number;
  phase: number;
}

const biomeTypes: readonly Biome[] = ['plains', 'woodland', 'highlands', 'desert', 'tundra'];
const biomeCellSize = 2048;
const caveCellSize = 160;
const maxCaveLength = 220;
const fallenLogCellSize = 40;

function biomeAtSeed(seed: number, worldX: number, worldZ: number): Biome {
  const cellX = Math.floor(worldX / biomeCellSize);
  const cellZ = Math.floor(worldZ / biomeCellSize);
  let nearestDistance = Infinity;
  let selectedBiome: Biome = 'plains';

  for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
    for (let x = cellX - 1; x <= cellX + 1; x += 1) {
      const centerX = (x + 0.25 + lattice(seed + 9001, x, z) * 0.5) * biomeCellSize;
      const centerZ = (z + 0.25 + lattice(seed + 9002, x, z) * 0.5) * biomeCellSize;
      const distance = (worldX - centerX) ** 2 + (worldZ - centerZ) ** 2;
      if (distance < nearestDistance) {
        nearestDistance = distance;
        selectedBiome = biomeTypes[Math.floor(lattice(seed + 9003, x, z) * biomeTypes.length)];
      }
    }
  }

  return selectedBiome;
}

export function getBiomeAt(seed: string, worldX: number, worldZ: number): Biome {
  return biomeAtSeed(hashSeed(seed), worldX, worldZ);
}

function heightAt(seed: number, x: number, z: number, relief: number, biome: Biome): number {
  const broad = smoothNoise(seed, x / 105, z / 105);
  const detail = smoothNoise(seed + 91, x / 28, z / 28);
  const fine = smoothNoise(seed + 407, x / 8, z / 8);
  const ridgeNoise = 1 - Math.abs(smoothNoise(seed + 2201, x / 31, z / 31));
  const mountainRidges = biome === 'highlands' ? Math.pow(ridgeNoise, 2.2) * 4 : 0;
  const escarpmentNoise = smoothNoise(seed + 4301, x / 68, z / 68);
  const cliffSteps = Math.floor((escarpmentNoise + 1) * 1.5) - 1;
  const escarpments = cliffSteps * (biome === 'highlands' ? 1.5 : 0.45);
  const dunes = biome === 'desert' ? Math.sin((x + z * 0.45) / 19) * 0.35 : 0;
  const riverIndex = Math.round(x / 560);
  const riverCenterX = riverIndex * 560
    + smoothNoise(seed + 3001 + riverIndex * 19, 0, z / 110) * 28
    + smoothNoise(seed + 3002 + riverIndex * 19, 0, z / 38) * 7;
  const riverDistance = Math.abs(x - riverCenterX);
  const riverSegments = THREE.MathUtils.smoothstep(
    smoothNoise(seed + 3101 + riverIndex * 31, riverIndex, z / 260),
    0.12,
    0.55,
  );
  const riverInfluence = (1 - THREE.MathUtils.smoothstep(riverDistance, 2, 8)) * riverSegments;
  const landHeight = 14 + (broad * 2.4 + detail * 0.75 + fine * 0.35 + escarpments + dunes) * (relief / 18) + mountainRidges;
  const riverbed = 3.2 + THREE.MathUtils.smoothstep(riverDistance, 0, 5) * 2.2;
  const carvedHeight = THREE.MathUtils.lerp(landHeight, Math.min(landHeight, riverbed), riverInfluence);
  return Math.max(3, Math.min(64, Math.round(carvedHeight)));
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
const sandRect: UvRect = [0, 0, 1, 1];
const white = new THREE.Color('#ffffff');

function addQuad(
  positions: number[],
  colors: number[],
  uvs: number[] | undefined,
  corners: readonly (readonly [number, number, number])[],
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
  const { seed, chunkSize, radius, relief } = options;
  const centerX = options.centerX ?? 0;
  const centerZ = options.centerZ ?? 0;
  const chunksPerSide = radius * 2 + 1;
  const dimensions = chunksPerSide * chunkSize;
  const seedValue = hashSeed(seed);
  const heights = new Int16Array(dimensions * dimensions);
  const removedTreeParts = new Set(options.removedTreeParts ?? []);
  const removedGrassFoliage = new Set(options.removedGrassFoliage ?? []);
  const removedColumns = options.removedColumns ?? {};
  const worldHeightAt = (worldX: number, worldZ: number): number => {
    const gridX = Math.floor(worldX);
    const gridZ = Math.floor(worldZ);
    const originalHeight = heightAt(seedValue, gridX, gridZ, relief, biomeAtSeed(seedValue, gridX, gridZ));
    return Math.max(2, originalHeight - (removedColumns[`${gridX},${gridZ}`] ?? 0));
  };
  const caveMargin = maxCaveLength + 8;
  const firstCaveCellX = Math.floor((centerX - dimensions / 2 - caveMargin) / caveCellSize);
  const lastCaveCellX = Math.floor((centerX + dimensions / 2 + caveMargin) / caveCellSize);
  const firstCaveCellZ = Math.floor((centerZ - dimensions / 2 - caveMargin) / caveCellSize);
  const lastCaveCellZ = Math.floor((centerZ + dimensions / 2 + caveMargin) / caveCellSize);
  const caveEntrances: CaveEntrance[] = [];
  for (let cellZ = firstCaveCellZ; cellZ <= lastCaveCellZ; cellZ += 1) {
    for (let cellX = firstCaveCellX; cellX <= lastCaveCellX; cellX += 1) {
      const angle = lattice(seedValue + 5004, cellX, cellZ) * Math.PI * 2;
      const branchSign = lattice(seedValue + 5005, cellX, cellZ) < 0.5 ? -1 : 1;
      const x = cellX * caveCellSize + Math.floor(lattice(seedValue + 5006, cellX, cellZ) * caveCellSize);
      const z = cellZ * caveCellSize + Math.floor(lattice(seedValue + 5007, cellX, cellZ) * caveCellSize);
      caveEntrances.push({
        x,
        z,
        surfaceY: worldHeightAt(x, z),
        surfaceOpening: lattice(seedValue + 5003, cellX, cellZ) <= 0.45,
        angle,
        branchAngle: angle + branchSign * 0.92,
        length: 150 + Math.floor(lattice(seedValue + 5008, cellX, cellZ) * (maxCaveLength - 150)),
        descent: 0.075 + lattice(seedValue + 5009, cellX, cellZ) * 0.045,
        phase: lattice(seedValue + 5010, cellX, cellZ) * Math.PI * 2,
      });
    }
  }
  const caveOpeningAt = (worldX: number, worldZ: number): boolean =>
    caveEntrances.some((entrance) => entrance.surfaceOpening && Math.hypot(worldX - entrance.x, worldZ - entrance.z) <= 2.3);
  const caveAirAt = (worldX: number, y: number, worldZ: number): boolean => {
    const surface = worldHeightAt(worldX, worldZ);
    if (y < 3 || y >= surface) return false;
    for (const entrance of caveEntrances) {
      const dx = worldX - entrance.x;
      const dz = worldZ - entrance.z;
      const distanceToEntrance = Math.hypot(dx, dz);
      if (entrance.surfaceOpening && distanceToEntrance <= 2.3 && y >= 5) return true;

      const along = dx * Math.cos(entrance.angle) + dz * Math.sin(entrance.angle);
      const across = -dx * Math.sin(entrance.angle) + dz * Math.cos(entrance.angle);
      if (along >= 0 && along <= entrance.length) {
        const wander = Math.sin(along * 0.018 + entrance.phase) * 3.2;
        const startDepth = entrance.surfaceOpening ? 1.4 : 7;
        const centerY = Math.max(4.8, entrance.surfaceY - startDepth - along * entrance.descent + Math.sin(along * 0.035 + entrance.phase) * 0.7);
        const wallNoise = smoothNoise3(seedValue + 5100, worldX / 9, y / 6, worldZ / 9);
        const radius = 2.4 + wallNoise * 0.35;
        const height = 2.8 + wallNoise * 0.25;
        if (((across - wander) / radius) ** 2 + ((y - centerY) / height) ** 2 <= 1) return true;
      }

      const branchWanderAtStart = Math.sin(58 * 0.018 + entrance.phase) * 3.2;
      const branchX = dx - Math.cos(entrance.angle) * 58 + Math.sin(entrance.angle) * branchWanderAtStart;
      const branchZ = dz - Math.sin(entrance.angle) * 58 - Math.cos(entrance.angle) * branchWanderAtStart;
      const branchAlong = branchX * Math.cos(entrance.branchAngle) + branchZ * Math.sin(entrance.branchAngle);
      const branchAcross = -branchX * Math.sin(entrance.branchAngle) + branchZ * Math.cos(entrance.branchAngle);
      if (branchAlong >= 0 && branchAlong <= 118) {
        const branchWander = Math.sin(branchAlong * 0.024 + entrance.phase) * 2;
        const startDepth = entrance.surfaceOpening ? 1.4 : 7;
        const centerY = Math.max(4.8, entrance.surfaceY - startDepth - 58 * entrance.descent - branchAlong * entrance.descent * 0.65
          + Math.sin(branchAlong * 0.04 + entrance.phase) * 0.5);
        const wallNoise = smoothNoise3(seedValue + 5101, worldX / 8, y / 5, worldZ / 8);
        const radius = 1.9 + wallNoise * 0.25;
        const height = 2.3 + wallNoise * 0.2;
        if (((branchAcross - branchWander) / radius) ** 2 + ((y - centerY) / height) ** 2 <= 1) return true;
      }
    }
    return false;
  };
  let peak = 0;

  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      const worldX = centerX + x - dimensions / 2;
      const worldZ = centerZ + z - dimensions / 2;
      const height = worldHeightAt(worldX, worldZ);
      heights[z * dimensions + x] = height;
      peak = Math.max(peak, height);
    }
  }

  const group = new THREE.Group();
  const texturedPositions: number[] = [];
  const texturedColors: number[] = [];
  const texturedUvs: number[] = [];
  const sandPositions: number[] = [];
  const sandColors: number[] = [];
  const sandUvs: number[] = [];
  const origin = -dimensions / 2;
  let blocks = 0;

  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      const height = heights[z * dimensions + x];
      blocks += height;
      const x0 = origin + x + centerX;
      const x1 = x0 + 1;
      const z0 = origin + z + centerZ;
      const z1 = z0 + 1;
      const worldBlockX = Math.floor(x0);
      const worldBlockZ = Math.floor(z0);
      const cellBiome = biomeAtSeed(seedValue, worldBlockX, worldBlockZ);
      const cellPalette = palettes[cellBiome];
      if (!caveAirAt(Math.floor(x0), height - 1, Math.floor(z0))) {
        const topPositions = height <= SEA_LEVEL ? sandPositions : texturedPositions;
        const topColors = height <= SEA_LEVEL ? sandColors : texturedColors;
        const topUvs = height <= SEA_LEVEL ? sandUvs : texturedUvs;
        const topColor = height <= SEA_LEVEL ? white : faceColor(cellPalette, height, height, seedValue, worldBlockX, worldBlockZ);
        addQuad(topPositions, topColors, topUvs, [[x0, height, z0], [x0, height, z1], [x1, height, z1], [x1, height, z0]], topColor, height <= SEA_LEVEL ? sandRect : grassTopRect);
      }

      addQuad(texturedPositions, texturedColors, texturedUvs, [[x0, 0, z1], [x0, 0, z0], [x1, 0, z0], [x1, 0, z1]], white, grassBottomRect);

      const neighbors = [
        { height: x > 0 ? heights[z * dimensions + x - 1] : worldHeightAt(x0 - 1, centerZ + z - dimensions / 2), corners: (y0: number, y1: number): [number, number, number][] => [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]] },
        { height: x < dimensions - 1 ? heights[z * dimensions + x + 1] : worldHeightAt(x1, centerZ + z - dimensions / 2), corners: (y0: number, y1: number): [number, number, number][] => [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]] },
        { height: z > 0 ? heights[(z - 1) * dimensions + x] : worldHeightAt(centerX + x - dimensions / 2, z0 - 1), corners: (y0: number, y1: number): [number, number, number][] => [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]] },
        { height: z < dimensions - 1 ? heights[(z + 1) * dimensions + x] : worldHeightAt(centerX + x - dimensions / 2, z1), corners: (y0: number, y1: number): [number, number, number][] => [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]] },
      ];

      for (const neighbor of neighbors) {
        for (let y = neighbor.height; y < height; y += 1) {
          if (y === height - 1) {
            const underWater = height <= SEA_LEVEL;
            const sidePositions = underWater ? sandPositions : texturedPositions;
            const sideColors = underWater ? sandColors : texturedColors;
            const sideUvs = underWater ? sandUvs : texturedUvs;
            const sideColor = underWater ? white : faceColor(cellPalette, height, height, seedValue, worldBlockX, worldBlockZ);
            addQuad(sidePositions, sideColors, sideUvs, neighbor.corners(y, y + 1), sideColor, underWater ? sandRect : grassSideRect);
          } else {
            addQuad(texturedPositions, texturedColors, texturedUvs, neighbor.corners(y, y + 1), white, dirtSideRect);
          }
        }
      }
    }
  }

  const solidCellAt = (worldX: number, y: number, worldZ: number): boolean =>
    y >= 0 && y < worldHeightAt(worldX, worldZ) && !caveAirAt(worldX, y, worldZ);
  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      const worldX = Math.floor(origin + x + centerX);
      const worldZ = Math.floor(origin + z + centerZ);
      const height = heights[z * dimensions + x];
      for (let y = 3; y < height; y += 1) {
        if (!caveAirAt(worldX, y, worldZ)) continue;
        const x0 = worldX;
        const x1 = worldX + 1;
        const z0 = worldZ;
        const z1 = worldZ + 1;
        const sides = [
          { solid: solidCellAt(worldX - 1, y, worldZ), corners: [[x0, y, z1], [x0, y + 1, z1], [x0, y + 1, z0], [x0, y, z0]] as const },
          { solid: solidCellAt(worldX + 1, y, worldZ), corners: [[x1, y, z0], [x1, y + 1, z0], [x1, y + 1, z1], [x1, y, z1]] as const },
          { solid: solidCellAt(worldX, y, worldZ - 1), corners: [[x0, y, z0], [x0, y + 1, z0], [x1, y + 1, z0], [x1, y, z0]] as const },
          { solid: solidCellAt(worldX, y, worldZ + 1), corners: [[x1, y, z1], [x1, y + 1, z1], [x0, y + 1, z1], [x0, y, z1]] as const },
          { solid: solidCellAt(worldX, y + 1, worldZ), corners: [[x0, y + 1, z0], [x0, y + 1, z1], [x1, y + 1, z1], [x1, y + 1, z0]] as const },
          { solid: solidCellAt(worldX, y - 1, worldZ), corners: [[x0, y, z1], [x0, y, z0], [x1, y, z0], [x1, y, z1]] as const },
        ];
        for (const side of sides) {
          if (side.solid) {
            const sidePalette = palettes[biomeAtSeed(seedValue, worldX, worldZ)];
            addQuad(texturedPositions, texturedColors, texturedUvs, side.corners, sidePalette.stone, dirtSideRect);
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
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        vec3 atlasColor = texture2D(map, vMapUv).rgb;
        float atlasMax = max(max(atlasColor.r, atlasColor.g), atlasColor.b);
        float atlasMin = min(min(atlasColor.r, atlasColor.g), atlasColor.b);
        float grayMask = 1.0 - smoothstep(0.025, 0.12, atlasMax - atlasMin);
        float grassAtlasRegion = step(0.5, vMapUv.y);
        vec3 terrainTint = max(vColor, vec3(0.001));
        diffuseColor.rgb /= terrainTint;
        diffuseColor.rgb *= mix(vec3(1.0), terrainTint, grayMask * grassAtlasRegion);`,
      );
    };
    texturedMaterial.customProgramCacheKey = () => 'biome-tinted-terrain-atlas-v1';
    const texturedMesh = new THREE.Mesh(texturedGeometry, texturedMaterial);
    texturedMesh.name = 'terrain-block-mesh';
    texturedMesh.castShadow = true;
    texturedMesh.receiveShadow = true;
    group.add(texturedMesh);
  }

  if (sandPositions.length > 0) {
    const sandTexture = new THREE.TextureLoader().load(sandAtlasUrl);
    sandTexture.colorSpace = THREE.SRGBColorSpace;
    sandTexture.magFilter = THREE.NearestFilter;
    sandTexture.minFilter = THREE.NearestFilter;
    sandTexture.generateMipmaps = false;
    const sandGeometry = new THREE.BufferGeometry();
    sandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sandPositions, 3));
    sandGeometry.setAttribute('color', new THREE.Float32BufferAttribute(sandColors, 3));
    sandGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(sandUvs, 2));
    sandGeometry.computeVertexNormals();
    sandGeometry.computeBoundingSphere();
    const sandMesh = new THREE.Mesh(
      sandGeometry,
      new THREE.MeshStandardMaterial({ map: sandTexture, vertexColors: true, roughness: 0.96, metalness: 0 }),
    );
    sandMesh.name = 'underwater-sand-mesh';
    sandMesh.castShadow = true;
    sandMesh.receiveShadow = true;
    group.add(sandMesh);
  }

  const waterPositions: number[] = [];
  const waterColors: number[] = [];
  const waterUvs: number[] = [];
  for (let z = 0; z < dimensions; z += 1) {
    for (let x = 0; x < dimensions; x += 1) {
      if (heights[z * dimensions + x] >= SEA_LEVEL) continue;
      const x0 = origin + x + centerX;
      const z0 = origin + z + centerZ;
      addQuad(
        waterPositions, waterColors, waterUvs,
        [[x0, SEA_LEVEL + 0.03, z0], [x0, SEA_LEVEL + 0.03, z0 + 1], [x0 + 1, SEA_LEVEL + 0.03, z0 + 1], [x0 + 1, SEA_LEVEL + 0.03, z0]],
        white, sandRect,
      );
    }
  }
  if (waterPositions.length > 0) {
    const waterTexture = new THREE.TextureLoader().load(waterTextureUrl);
    waterTexture.colorSpace = THREE.SRGBColorSpace;
    waterTexture.magFilter = THREE.NearestFilter;
    waterTexture.minFilter = THREE.NearestFilter;
    waterTexture.generateMipmaps = false;
    const waterGeometry = new THREE.BufferGeometry();
    waterGeometry.setAttribute('position', new THREE.Float32BufferAttribute(waterPositions, 3));
    waterGeometry.setAttribute('color', new THREE.Float32BufferAttribute(waterColors, 3));
    waterGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(waterUvs, 2));
    waterGeometry.computeVertexNormals();
    waterGeometry.computeBoundingSphere();
    const water = new THREE.Mesh(
      waterGeometry,
      new THREE.MeshStandardMaterial({ map: waterTexture, color: '#ffffff', vertexColors: true, transparent: true, opacity: 0.82, roughness: 0.34, metalness: 0.02, side: THREE.DoubleSide }),
    );
    water.name = 'water-surface-mesh';
    water.receiveShadow = true;
    group.add(water);
  }

  const trunkParts: Array<{ x: number; y: number; z: number; id: string }> = [];
  const fallenLogParts: Array<{ x: number; y: number; z: number; id: string; yaw: number }> = [];
  const leafParts: Array<{ x: number; y: number; z: number; color: THREE.Color; id: string }> = [];
  const obstacles: GeneratedTerrain['obstacles'] = [];
  const treeCenters: Array<{ x: number; z: number; radius: number }> = [];
  const treeSpacing = 7;
  const treeCells = Math.ceil(dimensions / treeSpacing);
  const firstTreeCellX = Math.floor((centerX + origin) / treeSpacing);
  const firstTreeCellZ = Math.floor((centerZ + origin) / treeSpacing);
  let treeCount = 0;

  for (let cellZ = 0; cellZ < treeCells; cellZ += 1) {
    for (let cellX = 0; cellX < treeCells; cellX += 1) {
      const worldCellX = firstTreeCellX + cellX;
      const worldCellZ = firstTreeCellZ + cellZ;
      const worldBlockX = Math.floor(worldCellX * treeSpacing + lattice(seedValue + 83, worldCellX, worldCellZ) * treeSpacing);
      const worldBlockZ = Math.floor(worldCellZ * treeSpacing + lattice(seedValue + 197, worldCellX, worldCellZ) * treeSpacing);
      const x = worldBlockX - (centerX + origin);
      const z = worldBlockZ - (centerZ + origin);
      if (x < 2 || z < 2 || x >= dimensions - 2 || z >= dimensions - 2) continue;
      const treeBiome = biomeAtSeed(seedValue, worldBlockX, worldBlockZ);
      const treeChance = treeBiome === 'woodland' ? 0.62 : treeBiome === 'plains' ? 0.06 : treeBiome === 'highlands' ? 0.17 : treeBiome === 'tundra' ? 0.15 : 0.0125;
      if (lattice(seedValue + 761, worldCellX, worldCellZ) > treeChance) continue;
      const ground = heights[z * dimensions + x];
      if (ground <= SEA_LEVEL + 1 || ground >= 23) continue;
      const worldX = worldBlockX + 0.5;
      const worldZ = worldBlockZ + 0.5;
      const treePalette = palettes[treeBiome];
      const conifer = treeBiome === 'highlands' || treeBiome === 'tundra';
      const trunkHeight = (conifer ? 5 : 3) + Math.floor(lattice(seedValue + 313, worldBlockX, worldBlockZ) * (conifer ? 4 : 3));
      const treeId = `${worldBlockX},${worldBlockZ}`;
      treeCenters.push({ x: worldX, z: worldZ, radius: 0.72 });
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
              const color = treePalette.top.clone().multiplyScalar(0.82 + lattice(seedValue + 401, worldBlockX + dx, worldBlockZ + dz + layer) * 0.24);
              leafParts.push({ x: leafX, y, z: leafZ, color, id });
              obstacles.push({ x: leafX, y, z: leafZ, radius: 0.5, bottom: y - 0.5, top: y + 0.5, fullBlock: true });
            }
          }
        }
      } else {
        const canopyBase = ground + trunkHeight - (treeBiome === 'desert' ? 1 : 2);
        for (let layer = 0; layer < 3; layer += 1) {
          const canopyRadius = layer === 1 ? 2 : 1;
          for (let dx = -canopyRadius; dx <= canopyRadius; dx += 1) {
            for (let dz = -canopyRadius; dz <= canopyRadius; dz += 1) {
              if (Math.abs(dx) + Math.abs(dz) > canopyRadius * 2 - 1) continue;
              if (dx === 0 && dz === 0 && layer === 0) continue;
              const id = `leaf:${treeId}:${layer}:${dx}:${dz}`;
              if (removedTreeParts.has(id)) continue;
              const y = canopyBase + layer + 0.5;
              const colorBase = treeBiome === 'desert' ? new THREE.Color('#8c9160') : new THREE.Color('#638f59');
              const color = colorBase.multiplyScalar(0.86 + lattice(seedValue + layer * 41, worldBlockX + dx, worldBlockZ + dz) * 0.2);
              const leafX = worldX + dx;
              const leafZ = worldZ + dz;
              leafParts.push({ x: leafX, y, z: leafZ, color, id });
              obstacles.push({ x: leafX, y, z: leafZ, radius: 0.5, bottom: y - 0.5, top: y + 0.5, fullBlock: true });
            }
          }
        }
      }
    }
  }

  const firstLogCellX = Math.floor((centerX + origin) / fallenLogCellSize);
  const firstLogCellZ = Math.floor((centerZ + origin) / fallenLogCellSize);
  const logCells = Math.ceil(dimensions / fallenLogCellSize) + 1;
  for (let cellZ = 0; cellZ < logCells; cellZ += 1) {
    for (let cellX = 0; cellX < logCells; cellX += 1) {
      const worldCellX = firstLogCellX + cellX;
      const worldCellZ = firstLogCellZ + cellZ;
      if (lattice(seedValue + 8101, worldCellX, worldCellZ) >= 0.78) continue;
      const worldBlockX = worldCellX * fallenLogCellSize + 3 + Math.floor(lattice(seedValue + 8102, worldCellX, worldCellZ) * (fallenLogCellSize - 6));
      const worldBlockZ = worldCellZ * fallenLogCellSize + 3 + Math.floor(lattice(seedValue + 8103, worldCellX, worldCellZ) * (fallenLogCellSize - 6));
      const x = worldBlockX - (centerX + origin);
      const z = worldBlockZ - (centerZ + origin);
      const yaw = lattice(seedValue + 8104, worldCellX, worldCellZ) < 0.5 ? 0 : Math.PI / 2;
      const offsetX = yaw === 0 ? 1 : 0;
      const offsetZ = yaw === 0 ? 0 : 1;
      if (x < 2 || z < 2 || x + offsetX * 2 >= dimensions - 2 || z + offsetZ * 2 >= dimensions - 2) continue;
      const logCenterX = worldBlockX + offsetX + 0.5;
      const logCenterZ = worldBlockZ + offsetZ + 0.5;
      const minWorldX = centerX - dimensions / 2;
      const minWorldZ = centerZ - dimensions / 2;
      if (logCenterX < minWorldX || logCenterX >= minWorldX + dimensions
        || logCenterZ < minWorldZ || logCenterZ >= minWorldZ + dimensions) continue;
      if (biomeAtSeed(seedValue, worldBlockX, worldBlockZ) !== 'woodland') continue;
      const grounds = [0, 1, 2].map((segment) =>
        heights[(z + offsetZ * segment) * dimensions + x + offsetX * segment]);
      if (Math.max(...grounds) - Math.min(...grounds) > 1 || grounds[0] <= SEA_LEVEL + 1) continue;
      const logY = Math.min(...grounds) + 0.5;
      const logId = `fallen-log:${worldBlockX},${worldBlockZ}`;
      if (removedTreeParts.has(logId)) continue;
      for (let segment = 0; segment < 3; segment += 1) {
        const partX = worldBlockX + offsetX * segment + 0.5;
        const partZ = worldBlockZ + offsetZ * segment + 0.5;
        obstacles.push({
          x: partX, y: logY, z: partZ, radius: 0.5,
          bottom: logY - 0.5, top: logY + 0.5, fullBlock: true,
        });
      }
      fallenLogParts.push({ x: logCenterX, y: logY, z: logCenterZ, id: logId, yaw });
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
  if (fallenLogParts.length > 0) {
    const barkMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
    const endGrainMaterial = new THREE.MeshStandardMaterial({ roughness: 1 });
    new THREE.TextureLoader().load(oakTreeAtlasUrl, (oakAtlas) => {
      oakAtlas.colorSpace = THREE.SRGBColorSpace;
      oakAtlas.magFilter = THREE.NearestFilter;
      oakAtlas.minFilter = THREE.NearestFilter;
      oakAtlas.generateMipmaps = false;
      const barkTexture = oakAtlas.clone();
      barkTexture.wrapS = THREE.RepeatWrapping;
      barkTexture.wrapT = THREE.RepeatWrapping;
      barkTexture.repeat.set(3, 0.5);
      barkTexture.offset.set(0, 0);
      barkTexture.needsUpdate = true;
      barkMaterial.map = barkTexture;
      barkMaterial.needsUpdate = true;
      const endTexture = oakAtlas.clone();
      endTexture.wrapS = THREE.RepeatWrapping;
      endTexture.wrapT = THREE.RepeatWrapping;
      endTexture.repeat.set(1, 0.5);
      endTexture.offset.set(0, 0.5);
      endTexture.needsUpdate = true;
      endGrainMaterial.map = endTexture;
      endGrainMaterial.needsUpdate = true;
      oakAtlas.dispose();
    });
    const logGeometry = new THREE.BoxGeometry(3, 1, 1);
    const fallenLogs = new THREE.InstancedMesh(
      logGeometry,
      [endGrainMaterial, endGrainMaterial, barkMaterial, barkMaterial, barkMaterial, barkMaterial],
      fallenLogParts.length,
    );
    fallenLogs.name = 'fallen-log-blocks';
    fallenLogs.userData.breakPartIds = fallenLogParts.map((part) => part.id);
    const logMatrix = new THREE.Matrix4();
    const logRotation = new THREE.Quaternion();
    fallenLogParts.forEach((part, index) => {
      logRotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), part.yaw);
      logMatrix.compose(new THREE.Vector3(part.x, part.y, part.z), logRotation, new THREE.Vector3(1, 1, 1));
      fallenLogs.setMatrixAt(index, logMatrix);
    });
    fallenLogs.instanceMatrix.needsUpdate = true;
    fallenLogs.castShadow = true;
    fallenLogs.receiveShadow = true;
    group.add(fallenLogs);
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

  const grassParts: Array<{ x: number; y: number; z: number; color: THREE.Color; id: string }> = [];
  for (let z = 1; z < dimensions - 1; z += 1) {
    for (let x = 1; x < dimensions - 1; x += 1) {
      const worldGridX = Math.floor(centerX + origin + x);
      const worldGridZ = Math.floor(centerZ + origin + z);
      const grassBiome = biomeAtSeed(seedValue, worldGridX, worldGridZ);
      const ground = heights[z * dimensions + x];
      if (ground <= SEA_LEVEL + 1 || ground >= 23) continue;
      const density = grassBiome === 'plains' ? 0.12 : grassBiome === 'woodland' ? 0.1 : grassBiome === 'highlands' ? 0.08 : grassBiome === 'tundra' ? 0.05 : 0.015;
      const id = `${worldGridX},${worldGridZ}`;
      if (lattice(seedValue + 2477, worldGridX, worldGridZ) >= density || removedGrassFoliage.has(id)) continue;
      const tint = palettes[grassBiome].top.clone().multiplyScalar(0.88 + lattice(seedValue + 3011, worldGridX, worldGridZ) * 0.24);
      grassParts.push({ x: centerX + origin + x + 0.5, y: ground, z: centerZ + origin + z + 0.5, color: tint, id });
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
      vertexColors: true,
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
      maskTexture.colorSpace = THREE.SRGBColorSpace;
      maskTexture.magFilter = THREE.NearestFilter;
      maskTexture.minFilter = THREE.NearestFilter;
      maskTexture.generateMipmaps = false;
      grassMaterial.map = maskTexture;
      grassMaterial.needsUpdate = true;
      grassAtlas.dispose();
    });

    const grassTufts = new THREE.InstancedMesh(grassGeometry, grassMaterial, grassParts.length * 2);
    grassTufts.name = 'grass-foliage-blocks';
    grassTufts.userData.breakPartIds = grassParts.flatMap((part) => [part.id, part.id]);
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
    const x = THREE.MathUtils.clamp(Math.floor(worldX - centerX - origin), 0, dimensions - 1);
    const z = THREE.MathUtils.clamp(Math.floor(worldZ - centerZ - origin), 0, dimensions - 1);
    return heights[z * dimensions + x];
  };
  const caveFloorAt = (worldX: number, worldZ: number, feetY: number): number | undefined => {
    if (caveOpeningAt(worldX, worldZ)) return 5;
    const cellX = Math.floor(worldX);
    const cellZ = Math.floor(worldZ);
    if (feetY >= groundHeightAt(worldX, worldZ) - 0.5 || feetY < 3 || !caveAirAt(cellX, Math.floor(feetY), cellZ)) return undefined;
    let floorY = Math.floor(feetY);
    while (floorY > 3 && caveAirAt(cellX, floorY - 1, cellZ)) floorY -= 1;
    return floorY;
  };
  const caveCeilingAt = (worldX: number, worldZ: number, feetY: number): number | undefined => {
    if (caveOpeningAt(worldX, worldZ)) return undefined;
    const cellX = Math.floor(worldX);
    const cellZ = Math.floor(worldZ);
    if (!caveAirAt(cellX, Math.floor(feetY), cellZ)) return undefined;
    let ceilingY = Math.floor(feetY);
    while (ceilingY < feetY + 2.5 && caveAirAt(cellX, ceilingY + 1, cellZ)) ceilingY += 1;
    return ceilingY + 1;
  };

  const cellAt = (worldX: number, worldZ: number): { x: number; z: number } => ({
    x: THREE.MathUtils.clamp(Math.floor(worldX - centerX - origin), 0, dimensions - 1),
    z: THREE.MathUtils.clamp(Math.floor(worldZ - centerZ - origin), 0, dimensions - 1),
  });

  let spawn = { x: 0, z: 0, yaw: 0 };
  let bestSpawnScore = -Infinity;
  const spawnLimit = dimensions / 2 - 5;
  for (let x = -spawnLimit; x <= spawnLimit; x += 2) {
    for (let z = -spawnLimit; z <= spawnLimit; z += 2) {
      if (groundHeightAt(x, z) <= SEA_LEVEL + 1 || caveOpeningAt(x, z)) continue;
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

  return {
    group, blocks, chunks: chunksPerSide * chunksPerSide, dimensions, peak, trees: treeCount, obstacles,
    spawn: { x: spawn.x + centerX, z: spawn.z + centerZ, yaw: spawn.yaw },
    groundHeightAt, caveFloorAt, caveCeilingAt, cellAt,
  };
}
