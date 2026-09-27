import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { generateTerrain, type Biome, type GeneratedTerrain } from './terrain';
import breakingAtlasUrl from '../res/breaking_ani_atlas.png';
import steveSkinUrl from '../res/steve_skin.png';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root was not found.');

app.innerHTML = `
  <main class="game-shell">
    <section id="scene-root" class="scene-root" aria-label="First-person Minecraft-style terrain world">
      <div class="world-bar">
        <div class="world-brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>FIELDCRAFT</strong><small id="biome-readout">TEMPERATE WOODLAND</small></span></div>
        <div class="world-actions"><span class="seed-readout">SEED <b id="seed-readout">PINE-VALLEY-07</b></span><button id="new-world-button" type="button">New world <kbd>R</kbd></button></div>
      </div>
      <div id="scene-error" class="scene-error" hidden>WebGL could not initialize. Try a browser with WebGL enabled.</div>
      <div class="crosshair" aria-hidden="true"><i></i><b></b></div>
      <div class="break-meter" id="break-meter" aria-hidden="true"><div id="break-meter-fill"></div></div>
      <div class="coordinates"><span class="coord-mark">⌖</span><span id="coordinate-readout">X 000 &nbsp; Y 000 &nbsp; Z 000</span></div>
      <div class="world-stats"><span><i class="status-dot"></i><b id="tree-count">0</b> trees</span><span><b id="chunk-count">25</b> chunks</span></div>
      <div class="bottom-help"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span><span><kbd>SPACE</kbd> jump</span><span><kbd>SHIFT</kbd> sprint</span><span><kbd>LMB</kbd> break</span><span><kbd>ESC</kbd> pause</span></div>
      <div class="mobile-controls" id="mobile-controls">
        <div class="touch-look-zone" id="touch-look-zone" aria-label="Drag to look"></div>
        <div class="move-pad" id="move-pad"><div class="move-pad-ring"></div><div class="move-pad-thumb" id="move-pad-thumb"></div></div>
        <div class="touch-actions">
          <button class="touch-button touch-pause" id="touch-pause" type="button" aria-label="Pause">Ⅱ</button>
          <button class="touch-button touch-break" id="touch-break" type="button" aria-label="Break block">⛏</button>
          <button class="touch-button touch-jump" id="touch-jump" type="button" aria-label="Jump">↑</button>
          <button class="touch-button touch-sprint" id="touch-sprint" type="button" aria-label="Sprint">»</button>
        </div>
      </div>
      <div class="game-menu" id="game-menu">
        <div class="menu-kicker"><span class="status-dot"></span><span id="menu-state">WORLD READY</span></div>
        <h1 id="menu-title">PINE VALLEY</h1>
        <p id="menu-description">A new block-world is waiting.</p>
        <label class="seed-entry" for="custom-seed-input"><span>WORLD SEED</span><span class="seed-input-wrap"><input id="custom-seed-input" value="pine-valley-07" maxlength="40" autocomplete="off" spellcheck="false" /><button id="randomize-seed" type="button" aria-label="Randomize seed" title="Randomize seed">⤨</button></span></label>
        <button class="enter-button" id="enter-world" type="button"><span id="enter-label">Enter world</span><span aria-hidden="true">→</span></button>
        <canvas class="steve-preview" id="steve-preview" width="56" height="108" aria-hidden="true"></canvas>
        <button class="menu-new-world" id="menu-new-world" type="button">Generate random world</button>
        <div class="menu-controls">W A S D <span>MOVE</span><b>·</b> MOUSE <span>LOOK</span><b>·</b> LMB <span>BREAK</span><b>·</b> SPACE <span>JUMP</span></div>
      </div>
      <div class="world-toast" id="world-toast" aria-live="polite"></div>
    </section>
  </main>
`;

const sceneRoot = document.querySelector<HTMLDivElement>('#scene-root')!;
const touchControlsAvailable = window.matchMedia('(pointer: coarse)').matches;
sceneRoot.classList.toggle('mobile-capable', touchControlsAvailable);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.domElement.className = 'scene-canvas';
renderer.domElement.setAttribute('aria-label', 'First-person game view. Click to play and use WASD to walk.');
sceneRoot.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#c6d2c9');
scene.fog = new THREE.Fog('#c6d2c9', 105, 245);
const camera = new THREE.PerspectiveCamera(72, 1, 0.08, 320);
camera.rotation.order = 'YXZ';
camera.position.set(0, 24, 0);
scene.add(camera);

const hemiLight = new THREE.HemisphereLight('#fff5dc', '#52614e', 2.15);
scene.add(hemiLight);
const sun = new THREE.DirectionalLight('#fff0d1', 3.1);
sun.position.set(-48, 82, 38);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -110;
sun.shadow.camera.right = 110;
sun.shadow.camera.top = 110;
sun.shadow.camera.bottom = -110;
sun.shadow.bias = -0.00018;
scene.add(sun);
scene.add(sun.target);

const viewArm = new THREE.Group();
const sleeve = new THREE.Mesh(
  new THREE.BoxGeometry(0.23, 0.43, 0.26),
  new THREE.MeshStandardMaterial({ color: '#73926d', roughness: 0.9 }),
);
sleeve.scale.set(0.78, 0.76, 0.78);
sleeve.position.set(0.43, -0.48, -1.05);
const hand = new THREE.Mesh(
  new THREE.BoxGeometry(0.2, 0.2, 0.23),
  new THREE.MeshStandardMaterial({ color: '#c98d69', roughness: 0.92 }),
);
hand.scale.set(0.78, 0.78, 0.78);
hand.position.set(0.43, -0.73, -1.07);
viewArm.add(sleeve, hand);
viewArm.renderOrder = 2;
viewArm.visible = false;
camera.add(viewArm);

function createSteveArmMaterials(image: HTMLImageElement, armStart: number, armEnd: number): THREE.MeshStandardMaterial[] {
  const crops = [
    [40, armStart, 4, armEnd - armStart],
    [48, armStart, 4, armEnd - armStart],
    [44, 16, 4, 4],
    [48, 16, 4, 4],
    [44, armStart, 4, armEnd - armStart],
    [52, armStart, 4, armEnd - armStart],
  ];
  return crops.map(([x, y, width, height]) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, x, y, width, height, 0, 0, width, height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    return new THREE.MeshStandardMaterial({ map: texture, roughness: 1 });
  });
}

new THREE.TextureLoader().load(steveSkinUrl, (skinTexture) => {
  const image = skinTexture.image as HTMLImageElement;
  sleeve.material = createSteveArmMaterials(image, 20, 26);
  hand.material = createSteveArmMaterials(image, 26, 32);

  const preview = document.querySelector<HTMLCanvasElement>('#steve-preview')!;
  const context = preview.getContext('2d')!;
  context.imageSmoothingEnabled = false;
  const drawPart = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void => {
    context.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
  };
  drawPart(8, 8, 8, 8, 12, 0, 32, 32);
  drawPart(20, 20, 8, 12, 16, 32, 24, 36);
  drawPart(44, 20, 4, 12, 0, 32, 16, 36);
  drawPart(36, 52, 4, 12, 40, 32, 16, 36);
  drawPart(4, 20, 4, 12, 16, 68, 12, 36);
  drawPart(20, 52, 4, 12, 28, 68, 12, 36);
  skinTexture.dispose();
});

const pointerLock = new PointerLockControls(camera, renderer.domElement);
let terrain: GeneratedTerrain | undefined;
let currentSeed = 'pine-valley-07';
let currentBiome: Biome = 'woodland';
let verticalVelocity = 0;
let jumpBufferTimer = 0;
let coyoteTimer = 0;
let walkPhase = 0;
let hasPlayed = false;
let mobilePlaying = false;
let lastReadout = 0;
let lookPointerId = -1;
let lastLookX = 0;
let lastLookY = 0;
let movePadPointerId = -1;
const eyeHeight = 1.62;
const pressed = new Set<string>();
const clock = new THREE.Clock();
const moveForward = new THREE.Vector3();
const moveRight = new THREE.Vector3();
const movement = new THREE.Vector3();
const horizontalVelocity = new THREE.Vector3();
const targetVelocity = new THREE.Vector3();
const velocityChange = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const removedColumns = new Map<string, number>();
const raycaster = new THREE.Raycaster();
raycaster.far = 5.5;
const rayCenter = new THREE.Vector2(0, 0);
const removedTreeParts = new Set<string>();
const breakMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  alphaTest: 0.16,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
});
const breakOverlay = new THREE.Mesh(new THREE.BoxGeometry(1.008, 1.008, 1.008), breakMaterial);
breakOverlay.visible = false;
breakOverlay.renderOrder = 3;
scene.add(breakOverlay);
const blockOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.025, 1.025, 1.025)),
  new THREE.LineBasicMaterial({ color: '#10140f', depthTest: true }),
);
blockOutline.visible = false;
blockOutline.renderOrder = 4;
scene.add(blockOutline);
let breakingTexture: THREE.Texture | undefined;
let currentBreakTarget = '';
let currentBreakKind: 'terrain' | 'tree' = 'terrain';
let breakProgress = 0;
let breakHeld = false;
let breakFrame = -1;

new THREE.TextureLoader().load(breakingAtlasUrl, (texture) => {
  const image = texture.image as HTMLImageElement;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let pixel = 0; pixel < pixels.data.length; pixel += 4) {
    const luminance = pixels.data[pixel] * 0.299 + pixels.data[pixel + 1] * 0.587 + pixels.data[pixel + 2] * 0.114;
    pixels.data[pixel] = 255;
    pixels.data[pixel + 1] = 255;
    pixels.data[pixel + 2] = 255;
    pixels.data[pixel + 3] = Math.max(0, 255 - luminance);
  }
  context.putImageData(pixels, 0, 0);
  const crackMask = new THREE.CanvasTexture(canvas);
  crackMask.magFilter = THREE.NearestFilter;
  crackMask.minFilter = THREE.NearestFilter;
  crackMask.generateMipmaps = false;
  crackMask.wrapS = THREE.ClampToEdgeWrapping;
  crackMask.repeat.set(0.1, 1);
  breakMaterial.map = crackMask;
  breakMaterial.needsUpdate = true;
  breakingTexture = crackMask;
  texture.dispose();
});

function cleanObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function formatCoordinate(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? '-' : ''}${Math.abs(rounded).toString().padStart(3, '0')}`;
}

function updateReadout(): void {
  document.querySelector('#coordinate-readout')!.innerHTML = `X ${formatCoordinate(camera.position.x)} &nbsp; Y ${formatCoordinate(camera.position.y - eyeHeight)} &nbsp; Z ${formatCoordinate(camera.position.z)}`;
}

function setMenu(open: boolean): void {
  const menu = document.querySelector<HTMLDivElement>('#game-menu')!;
  menu.hidden = !open;
  sceneRoot.classList.toggle('is-playing', !open);
  sceneRoot.classList.toggle('is-mobile-playing', !open && mobilePlaying);
  viewArm.visible = !open;
  document.querySelector('#menu-state')!.textContent = hasPlayed ? 'WORLD PAUSED' : 'WORLD READY';
  document.querySelector('#menu-title')!.textContent = currentSeed.replaceAll('-', ' ').toUpperCase();
  (document.querySelector('#custom-seed-input') as HTMLInputElement).value = currentSeed;
  document.querySelector('#menu-description')!.textContent = hasPlayed ? 'Pick up where you left off.' : 'A new block-world is waiting.';
  document.querySelector('#enter-label')!.textContent = hasPlayed ? 'Resume world' : 'Enter world';
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLDivElement>('#world-toast')!;
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 1700);
}

function seedHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomSeed(): string {
  const fragments = ['cedar', 'moss', 'copper', 'spruce', 'fern', 'granite', 'willow', 'thistle', 'basalt', 'river'];
  return `${fragments[Math.floor(Math.random() * fragments.length)]}-${Math.floor(10 + Math.random() * 90)}-${Math.floor(10 + Math.random() * 90)}`;
}

function biomeForSeed(seed: string): Biome {
  const biomes: Biome[] = ['woodland', 'highlands', 'desert', 'tundra'];
  return biomes[seedHash(seed) % biomes.length];
}

function generateWorld(seed = currentSeed): void {
  currentSeed = seed.trim().slice(0, 40) || randomSeed();
  removedColumns.clear();
  removedTreeParts.clear();
  currentBiome = seed === 'pine-valley-07' ? 'woodland' : biomeForSeed(seed);
  const biomeNames: Record<Biome, string> = {
    woodland: 'TEMPERATE WOODLAND',
    highlands: 'BROKEN HIGHLANDS',
    desert: 'WIND-CUT DESERT',
    tundra: 'ALPINE TUNDRA',
  };
  document.querySelector('#seed-readout')!.textContent = currentSeed.toUpperCase();
  (document.querySelector('#custom-seed-input') as HTMLInputElement).value = currentSeed;
  document.querySelector('#biome-readout')!.textContent = biomeNames[currentBiome];
  const toast = document.querySelector<HTMLDivElement>('#world-toast')!;
  toast.textContent = 'Building world';
  toast.classList.add('visible');

  window.setTimeout(() => {
    const nextTerrain = generateTerrain({ seed: currentSeed, biome: currentBiome, chunkSize: 16, radius: 2, relief: 18 });
    if (terrain) {
      scene.remove(terrain.group);
      cleanObject(terrain.group);
    }
    terrain = nextTerrain;
    scene.add(terrain.group);
    const ground = Math.max(8, terrain.groundHeightAt(terrain.spawn.x, terrain.spawn.z));
    camera.position.set(terrain.spawn.x, ground + eyeHeight, terrain.spawn.z);
    camera.rotation.set(0, terrain.spawn.yaw, 0);
    verticalVelocity = 0;
    horizontalVelocity.set(0, 0, 0);
    jumpBufferTimer = 0;
    coyoteTimer = 0;
    document.querySelector('#tree-count')!.textContent = String(terrain.trees);
    document.querySelector('#chunk-count')!.textContent = String(terrain.chunks);
    updateReadout();
    showToast('World ready');
    setMenu(!pointerLock.isLocked && !mobilePlaying);
  }, 25);
}

function groundAt(x: number, z: number): number {
  return Math.max(8, terrain?.groundHeightAt(x, z) ?? 8);
}

function updateBreakTarget(delta: number): void {
  const terrainMesh = terrain?.group.getObjectByName('terrain-block-mesh');
  if (!terrainMesh || !terrain || (!pointerLock.isLocked && !mobilePlaying)) {
    breakOverlay.visible = false;
    blockOutline.visible = false;
    currentBreakTarget = '';
    breakProgress = 0;
    document.querySelector('#break-meter')!.classList.remove('visible');
    return;
  }

  raycaster.setFromCamera(rayCenter, camera);
  const targetMeshes = [
    terrainMesh,
    terrain.group.getObjectByName('tree-trunk-blocks'),
    terrain.group.getObjectByName('tree-leaf-blocks'),
  ].filter((object): object is THREE.Object3D => object !== undefined);
  const hit = raycaster.intersectObjects(targetMeshes, false)[0];
  if (!hit || !hit.face) {
    breakOverlay.visible = false;
    blockOutline.visible = false;
    currentBreakTarget = '';
    breakProgress = 0;
    breakFrame = -1;
    document.querySelector('#break-meter')!.classList.remove('visible');
    return;
  }

  let targetId: string;
  let targetKind: 'terrain' | 'tree';
  let targetPosition: THREE.Vector3;
  if (hit.object.name === 'terrain-block-mesh') {
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const insidePoint = hit.point.clone().addScaledVector(normal, -0.015);
    const cell = terrain.cellAt(insidePoint.x, insidePoint.z);
    const columnHeight = terrain.groundHeightAt(insidePoint.x, insidePoint.z);
    if (columnHeight <= 2 || Math.hypot(camera.position.x - (cell.x - terrain.dimensions / 2 + 0.5), camera.position.z - (cell.z - terrain.dimensions / 2 + 0.5)) < 0.8) {
      breakOverlay.visible = false;
      blockOutline.visible = false;
      currentBreakTarget = '';
      breakProgress = 0;
      breakFrame = -1;
      document.querySelector('#break-meter')!.classList.remove('visible');
      return;
    }
    targetId = `terrain:${cell.x},${cell.z}`;
    targetKind = 'terrain';
    targetPosition = new THREE.Vector3(cell.x - terrain.dimensions / 2 + 0.5, columnHeight - 0.5, cell.z - terrain.dimensions / 2 + 0.5);
  } else {
    const instanceMesh = hit.object as THREE.InstancedMesh;
    if (hit.instanceId === undefined) return;
    const partIds = instanceMesh.userData.breakPartIds as string[] | undefined;
    const partId = partIds?.[hit.instanceId];
    if (!partId) return;
    const instanceMatrix = new THREE.Matrix4();
    instanceMesh.getMatrixAt(hit.instanceId, instanceMatrix);
    targetPosition = new THREE.Vector3().setFromMatrixPosition(instanceMatrix).applyMatrix4(instanceMesh.matrixWorld);
    targetId = `tree:${partId}`;
    targetKind = 'tree';
  }

  if (targetId !== currentBreakTarget || targetKind !== currentBreakKind) {
    currentBreakTarget = targetId;
    currentBreakKind = targetKind;
    breakProgress = 0;
    breakFrame = -1;
  }
  breakOverlay.position.copy(targetPosition);
  breakOverlay.visible = breakHeld;
  blockOutline.position.copy(breakOverlay.position);
  blockOutline.visible = true;

  if (breakHeld) {
    breakProgress = Math.min(1, breakProgress + delta / 0.82);
    const nextFrame = Math.min(9, Math.floor(breakProgress * 10));
    if (breakingTexture && nextFrame !== breakFrame) {
      breakingTexture.offset.x = nextFrame * 0.1;
      breakFrame = nextFrame;
    }
    document.querySelector('#break-meter')!.classList.add('visible');
    (document.querySelector('#break-meter-fill') as HTMLDivElement).style.width = `${breakProgress * 100}%`;
    viewArm.rotation.x = -0.14 - Math.sin(performance.now() * 0.022) * 0.09;
    if (breakProgress >= 1) {
      if (targetKind === 'terrain') {
        const cellId = targetId.slice('terrain:'.length);
        const removedCount = removedColumns.get(cellId) ?? 0;
        removedColumns.set(cellId, removedCount + 1);
      } else {
        removedTreeParts.add(targetId.slice('tree:'.length));
      }
      breakHeld = false;
      breakProgress = 0;
      breakFrame = -1;
      viewArm.rotation.x = 0;
      rebuildTerrain();
    }
  } else {
    breakProgress = 0;
    document.querySelector('#break-meter')!.classList.remove('visible');
    if (breakingTexture && breakFrame !== -1) {
      breakingTexture.offset.x = 0;
      breakFrame = -1;
    }
    viewArm.rotation.x = THREE.MathUtils.damp(viewArm.rotation.x, 0, delta, 10);
  }
}

function rebuildTerrain(): void {
  if (!terrain) return;
  const nextTerrain = generateTerrain({
    seed: currentSeed,
    biome: currentBiome,
    chunkSize: 16,
    radius: 2,
    relief: 18,
    removedColumns: Object.fromEntries(removedColumns),
    removedTreeParts: [...removedTreeParts],
  });
  scene.remove(terrain.group);
  cleanObject(terrain.group);
  terrain = nextTerrain;
  scene.add(terrain.group);
  const ground = groundAt(camera.position.x, camera.position.z);
  if (camera.position.y - eyeHeight < ground) camera.position.y = ground + eyeHeight;
  document.querySelector('#tree-count')!.textContent = String(terrain.trees);
  updateReadout();
}

function updatePlayer(delta: number): void {
  if (!terrain) return;
  const feet = camera.position.y - eyeHeight;
  const currentGround = groundAt(camera.position.x, camera.position.z);
  const grounded = feet <= currentGround + 0.05 && verticalVelocity <= 0;
  coyoteTimer = grounded ? 0.12 : Math.max(0, coyoteTimer - delta);
  jumpBufferTimer = Math.max(0, jumpBufferTimer - delta);
  if (coyoteTimer > 0 && jumpBufferTimer > 0) {
    verticalVelocity = 8.2;
    coyoteTimer = 0;
    jumpBufferTimer = 0;
  }

  const forwardInput = Number(pressed.has('w')) - Number(pressed.has('s'));
  const strafeInput = Number(pressed.has('d')) - Number(pressed.has('a'));
  const hasMovementInput = forwardInput !== 0 || strafeInput !== 0;
  movement.set(0, 0, 0);
  if (hasMovementInput) {
    pointerLock.getDirection(moveForward);
    moveForward.y = 0;
    moveForward.normalize();
    moveRight.crossVectors(moveForward, up).normalize();
    movement.copy(moveForward).multiplyScalar(forwardInput).addScaledVector(moveRight, strafeInput);
    if (movement.lengthSq() > 1) movement.normalize();
  }

  const sprinting = pressed.has('shift') && hasMovementInput;
  targetVelocity.copy(movement).multiplyScalar(sprinting ? 8.8 : 5.6);
  velocityChange.subVectors(targetVelocity, horizontalVelocity);
  const isGrounded = grounded && verticalVelocity <= 0;
  const maxVelocityChange = (hasMovementInput ? (isGrounded ? 48 : 10) : (isGrounded ? 58 : 2.2)) * delta;
  const velocityChangeLength = velocityChange.length();
  if (velocityChangeLength > maxVelocityChange && velocityChangeLength > 0) {
    velocityChange.multiplyScalar(maxVelocityChange / velocityChangeLength);
  }
  horizontalVelocity.add(velocityChange);

  const limit = terrain.dimensions / 2 - 1;
  const canOccupy = (x: number, z: number): boolean => {
    if (Math.abs(x) > limit || Math.abs(z) > limit) return false;
    const nextGround = groundAt(x, z);
    const highestWalkable = isGrounded ? currentGround + 0.05 : camera.position.y - eyeHeight + 0.12;
    if (nextGround > highestWalkable) return false;
    const playerFeet = camera.position.y - eyeHeight;
    const playerHead = playerFeet + 1.8;
    return terrain!.obstacles.every((obstacle) => {
      const overlapsHeight = playerHead > obstacle.bottom && playerFeet < obstacle.top;
      const overlapsRadius = Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.35;
      return !overlapsHeight || !overlapsRadius;
    });
  };

  const nextX = camera.position.x + horizontalVelocity.x * delta;
  if (canOccupy(nextX, camera.position.z)) camera.position.x = nextX;
  else horizontalVelocity.x = 0;
  const nextZ = camera.position.z + horizontalVelocity.z * delta;
  if (canOccupy(camera.position.x, nextZ)) camera.position.z = nextZ;
  else horizontalVelocity.z = 0;

  const ground = groundAt(camera.position.x, camera.position.z);
  if (verticalVelocity > 0 || camera.position.y - eyeHeight > ground) {
    verticalVelocity -= 23 * delta;
    camera.position.y += verticalVelocity * delta;
    if (camera.position.y - eyeHeight <= ground) {
      camera.position.y = ground + eyeHeight;
      verticalVelocity = 0;
      coyoteTimer = 0.12;
    }
  } else {
    camera.position.y = ground + eyeHeight;
  }

  const horizontalSpeed = Math.hypot(horizontalVelocity.x, horizontalVelocity.z);
  if (horizontalSpeed > 0.15) {
    walkPhase += delta * horizontalSpeed * 1.8;
    viewArm.position.y = Math.sin(walkPhase) * Math.min(0.045, horizontalSpeed * 0.004);
    viewArm.rotation.z = Math.sin(walkPhase) * 0.045;
  } else {
    viewArm.position.y = THREE.MathUtils.damp(viewArm.position.y, 0, delta, 10);
    viewArm.rotation.z = THREE.MathUtils.damp(viewArm.rotation.z, 0, delta, 10);
  }

  lastReadout += delta;
  if (lastReadout > 0.08) {
    updateReadout();
    lastReadout = 0;
  }
  updateBreakTarget(delta);
}

function resizeScene(): void {
  const width = sceneRoot.clientWidth;
  const height = sceneRoot.clientHeight;
  if (!width || !height) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

function animate(): void {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (pointerLock.isLocked || mobilePlaying) updatePlayer(delta);
  renderer.render(scene, camera);
}

function enterWorld(): void {
  const requestedSeed = (document.querySelector('#custom-seed-input') as HTMLInputElement).value.trim().slice(0, 40);
  if (requestedSeed && requestedSeed !== currentSeed) generateWorld(requestedSeed);
  if (touchControlsAvailable) {
    mobilePlaying = true;
    hasPlayed = true;
    pressed.clear();
    setMenu(false);
    return;
  }
  pointerLock.lock();
}

function setTouchKey(key: string, pressedState: boolean): void {
  if (pressedState) pressed.add(key);
  else pressed.delete(key);
}

function releaseMovePad(): void {
  movePadPointerId = -1;
  for (const key of ['w', 'a', 's', 'd']) pressed.delete(key);
  document.querySelector('#move-pad')!.classList.remove('active');
  (document.querySelector('#move-pad-thumb') as HTMLDivElement).style.transform = 'translate(0, 0)';
}

function updateMovePad(event: PointerEvent): void {
  const pad = document.querySelector<HTMLDivElement>('#move-pad')!;
  const bounds = pad.getBoundingClientRect();
  const radius = bounds.width * 0.31;
  let dx = event.clientX - (bounds.left + bounds.width / 2);
  let dy = event.clientY - (bounds.top + bounds.height / 2);
  const distance = Math.hypot(dx, dy);
  if (distance > radius) {
    dx *= radius / distance;
    dy *= radius / distance;
  }
  (document.querySelector('#move-pad-thumb') as HTMLDivElement).style.transform = `translate(${dx}px, ${dy}px)`;
  for (const key of ['w', 'a', 's', 'd']) pressed.delete(key);
  if (dy < -radius * 0.24) pressed.add('w');
  if (dy > radius * 0.24) pressed.add('s');
  if (dx < -radius * 0.24) pressed.add('a');
  if (dx > radius * 0.24) pressed.add('d');
}

function bindTouchHold(selector: string, key: string, onPress?: () => void, onRelease?: () => void): void {
  const button = document.querySelector<HTMLButtonElement>(selector)!;
  button.addEventListener('pointerdown', (event) => {
    if (!mobilePlaying) return;
    event.preventDefault();
    event.stopPropagation();
    button.setPointerCapture(event.pointerId);
    setTouchKey(key, true);
    if (key === ' ') jumpBufferTimer = 0.16;
    onPress?.();
  });
  const release = (event: PointerEvent): void => {
    event.preventDefault();
    setTouchKey(key, false);
    onRelease?.();
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

document.querySelector('#enter-world')!.addEventListener('click', enterWorld);
document.querySelector('#new-world-button')!.addEventListener('click', () => generateWorld(randomSeed()));
document.querySelector('#menu-new-world')!.addEventListener('click', () => {
  const seed = randomSeed();
  (document.querySelector('#custom-seed-input') as HTMLInputElement).value = seed;
  generateWorld(seed);
});
document.querySelector('#randomize-seed')!.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  (document.querySelector('#custom-seed-input') as HTMLInputElement).value = randomSeed();
});
document.querySelector<HTMLInputElement>('#custom-seed-input')!.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') enterWorld();
});
const movePad = document.querySelector<HTMLDivElement>('#move-pad')!;
movePad.addEventListener('pointerdown', (event) => {
  if (!mobilePlaying) return;
  event.preventDefault();
  movePadPointerId = event.pointerId;
  movePad.setPointerCapture(event.pointerId);
  movePad.classList.add('active');
  updateMovePad(event);
});
movePad.addEventListener('pointermove', (event) => {
  if (event.pointerId === movePadPointerId) updateMovePad(event);
});
movePad.addEventListener('pointerup', releaseMovePad);
movePad.addEventListener('pointercancel', releaseMovePad);
movePad.addEventListener('lostpointercapture', releaseMovePad);

const lookZone = document.querySelector<HTMLDivElement>('#touch-look-zone')!;
lookZone.addEventListener('pointerdown', (event) => {
  if (!mobilePlaying) return;
  event.preventDefault();
  lookPointerId = event.pointerId;
  lastLookX = event.clientX;
  lastLookY = event.clientY;
  lookZone.setPointerCapture(event.pointerId);
});
lookZone.addEventListener('pointermove', (event) => {
  if (event.pointerId !== lookPointerId) return;
  const deltaX = event.clientX - lastLookX;
  const deltaY = event.clientY - lastLookY;
  lastLookX = event.clientX;
  lastLookY = event.clientY;
  camera.rotation.y -= deltaX * 0.004;
  camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - deltaY * 0.004, -Math.PI / 2 + 0.04, Math.PI / 2 - 0.04);
});
const releaseLook = (): void => { lookPointerId = -1; };
lookZone.addEventListener('pointerup', releaseLook);
lookZone.addEventListener('pointercancel', releaseLook);
lookZone.addEventListener('lostpointercapture', releaseLook);

bindTouchHold('#touch-jump', ' ', () => { jumpBufferTimer = 0.16; });
bindTouchHold('#touch-break', 'break', () => { breakHeld = true; }, () => { breakHeld = false; });
bindTouchHold('#touch-sprint', 'shift');
document.querySelector('#touch-pause')!.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!mobilePlaying) return;
  mobilePlaying = false;
  pressed.clear();
  breakHeld = false;
  setMenu(true);
});
sceneRoot.addEventListener('click', (event) => {
  if (pointerLock.isLocked || mobilePlaying || (event.target as HTMLElement).closest('button,input')) return;
  enterWorld();
});
document.addEventListener('pointerlockchange', () => {
  const locked = pointerLock.isLocked;
  if (locked) {
    mobilePlaying = false;
    hasPlayed = true;
  }
  const playing = locked || mobilePlaying;
  breakHeld = false;
  breakProgress = 0;
  setMenu(!playing);
  if (playing) showToast('Explore the world');
  pressed.clear();
});
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.target instanceof HTMLInputElement) return;
  if (key === 'escape' && pointerLock.isLocked) {
    pointerLock.unlock();
    return;
  }
  if (key === 'r' && !event.repeat) {
    generateWorld(randomSeed());
    return;
  }
  if (!pointerLock.isLocked) return;
  if (['w', 'a', 's', 'd', ' ', 'shift'].includes(key)) {
    pressed.add(key);
    if (key === ' ' && !event.repeat) jumpBufferTimer = 0.16;
    event.preventDefault();
  }
});
document.addEventListener('keyup', (event) => pressed.delete(event.key.toLowerCase()));
document.addEventListener('mousedown', (event) => {
  if (event.button === 0 && (pointerLock.isLocked || mobilePlaying)) {
    breakHeld = true;
    event.preventDefault();
  }
});
document.addEventListener('mouseup', (event) => {
  if (event.button === 0) breakHeld = false;
});
document.addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('blur', () => {
  pressed.clear();
  breakHeld = false;
  movePadPointerId = -1;
  lookPointerId = -1;
});
new ResizeObserver(resizeScene).observe(sceneRoot);

try {
  resizeScene();
  generateWorld();
  animate();
} catch (error) {
  console.error(error);
  document.querySelector('#scene-error')!.removeAttribute('hidden');
}