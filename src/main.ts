import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { generateTerrain, getBiomeAt, type Biome, type GeneratedTerrain } from './terrain';
import breakingAtlasUrl from '../res/breaking_ani_atlas.png';
import pigModelUrl from '../res/mob_models/minecraft_pig.obj?url';
import steveModelUrl from '../res/mob_models/steve.obj?url';
import steveModelTextureUrl from '../res/mob_models/minecraft-steve/textures/steve.png';
import titleLogoUrl from '../res/minecraft_title_ce.png';
import sandAtlasUrl from '../res/sand_atlas.png';
import grassAtlasUrl from '../res/grass_atlas.png';
import oakTreeAtlasUrl from '../res/oak_tree_atlas.png';
import leavesAtlasUrl from '../res/leaves_atlas.png';
import stoneAtlasUrl from '../res/stone_atlas.png';
import panorama0Url from '../res/1.14_panorama_0.png';
import panorama1Url from '../res/1.14_panorama_1.png';
import panorama2Url from '../res/1.14_panorama_2.png';
import panorama3Url from '../res/1.14_panorama_3.png';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root was not found.');

type InventoryItem = 'grass' | 'dirt' | 'stone' | 'sand' | 'wood' | 'leaves' | 'water' | 'empty';
interface InventorySlot { item: InventoryItem; count: number }
const inventory: InventorySlot[] = [
  { item: 'grass', count: 64 }, { item: 'dirt', count: 48 }, { item: 'stone', count: 32 },
  { item: 'sand', count: 24 }, { item: 'wood', count: 16 }, { item: 'leaves', count: 32 },
  { item: 'water', count: 1 }, { item: 'empty', count: 0 }, { item: 'empty', count: 0 },
  ...Array.from({ length: 27 }, () => ({ item: 'empty' as InventoryItem, count: 0 })),
];
let selectedHotbarSlot = 0;
let heldInventorySlot: number | undefined;

type MenuScreen = 'title' | 'worlds' | 'create-world' | 'multiplayer' | 'options' | 'pause';
interface LanSession {
  code: string;
  playerId: string;
  role: 'host' | 'guest';
  seed: string;
  name: string;
}
interface LanPlayerState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouching?: boolean;
}
interface LocalWorldEdit {
  id: string;
  kind: 'terrain' | 'tree' | 'foliage' | 'sand' | 'place' | 'break-placed';
  key?: string;
  count?: number;
  block?: PlacedBlock;
  chunkX: number;
  chunkZ: number;
}
interface RemoteWorldEdit extends LocalWorldEdit {
  sequence: number;
  playerId: string;
}
interface RemotePlayer {
  group: THREE.Group;
  target: LanPlayerState;
  model?: THREE.Group;
  fallback?: THREE.Group;
  animationJoints: { leftArm?: THREE.Group; rightArm?: THREE.Group; leftLeg?: THREE.Group; rightLeg?: THREE.Group };
  previousPosition: THREE.Vector3;
  walkPhase: number;
  moveSpeed: number;
}
interface LanSyncResponse {
  players: Array<{ id: string; name: string; state?: LanPlayerState }>;
  edits: RemoteWorldEdit[];
}
interface SavedWorld {
  id: string;
  name: string;
  seed: string;
  savedAt: number;
  position: [number, number, number];
  rotation: [number, number];
  removedColumns: Array<[string, number]>;
  removedTreeParts: string[];
  removedGrassFoliage: string[];
  placedBlocks: PlacedBlock[];
  removedSandBlocks: string[];
  inventory: InventorySlot[];
  selectedHotbarSlot: number;
}
const SAVED_WORLDS_KEY = 'fieldcraft.saved-worlds.v1';
const GAME_SETTINGS_KEY = 'fieldcraft.settings.v1';
let activeMenuScreen: MenuScreen = 'title';
let optionsReturnScreen: MenuScreen = 'title';
let requestedMenuScreen: MenuScreen | undefined;
let activeWorldId: string | undefined;
let activeWorldName = 'New World';
let savedWorlds: SavedWorld[] = [];
let autosaveElapsed = 0;
let lanSession: LanSession | undefined;
let lanSyncElapsed = 0;
let lanSyncInProgress = false;
let lanJoinInProgress = false;
let lastLanEditSequence = 0;
const pendingLanEdits: LocalWorldEdit[] = [];
const remotePlayers = new Map<string, RemotePlayer>();
interface GameSettings {
  renderDistance: number;
  resolutionQuality: number;
  shadows: boolean;
  maxFrameRate: number;
  brightness: number;
  mouseSensitivity: number;
  mobileSensitivity: number;
  joystickSize: number;
  touchOpacity: number;
}
const gameSettings: GameSettings = {
  renderDistance: 6,
  resolutionQuality: 1,
  shadows: true,
  maxFrameRate: 0,
  brightness: 1,
  mouseSensitivity: 1,
  mobileSensitivity: 1,
  joystickSize: 126,
  touchOpacity: 0.85,
};

function inventorySlotMarkup(index: number, selected = false, held = false): string {
  const slot = inventory[index];
  return `<button class="inventory-slot${selected ? ' selected' : ''}${held ? ' held' : ''}" type="button" draggable="true" data-inventory-slot="${index}" aria-label="${slot.item} ${slot.count}"><span class="item-icon icon-${slot.item}"></span><small>${slot.count || ''}</small></button>`;
}

app.innerHTML = `
  <main class="game-shell">
    <section id="scene-root" class="scene-root" aria-label="First-person Minecraft-style terrain world">
      <div class="world-bar">
        <div class="world-brand"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span><span><strong>FIELDCRAFT</strong><small id="biome-readout">TEMPERATE WOODLAND</small></span></div>
        <div class="world-actions"><button id="music-toggle" type="button" aria-pressed="false">Music off</button><button id="pause-game-button" type="button">Pause <kbd>ESC</kbd></button></div>
      </div>
      <div id="scene-error" class="scene-error" hidden>WebGL could not initialize. Try a browser with WebGL enabled.</div>
      <div class="crosshair" aria-hidden="true"><i></i><b></b></div>
      <div class="break-meter" id="break-meter" aria-hidden="true"><div id="break-meter-fill"></div></div>
      <div class="coordinates"><span class="coord-mark">⌖</span><span id="coordinate-readout">X 000 &nbsp; Y 000 &nbsp; Z 000</span></div>
      <div class="world-stats"><span><i class="status-dot"></i><b id="tree-count">0</b> trees</span><span><b id="chunk-count">25</b> chunks</span></div>
      <div class="lan-room-badge" id="lan-room-badge" hidden></div>
        <div class="game-bottom-hud">
          <div class="hearts" id="hearts" aria-label="Health">${Array.from({ length: 10 }, () => '<span class="heart">♥</span>').join('')}</div>
          <div class="hotbar" id="hotbar" aria-label="Hotbar">${Array.from({ length: 9 }, (_, index) => inventorySlotMarkup(index, index === selectedHotbarSlot)).join('')}</div>
          <div class="selected-item-name" id="selected-item-name">Grass block</div>
        </div>
      <div class="inventory-panel" id="inventory-panel" hidden>
        <div class="inventory-grid" id="inventory-grid">${Array.from({ length: 27 }, (_, index) => inventorySlotMarkup(index + 9)).join('')}</div>
        <div class="inventory-hotbar" id="inventory-hotbar">${Array.from({ length: 9 }, (_, index) => inventorySlotMarkup(index, index === selectedHotbarSlot)).join('')}</div>
      </div>
      <div class="bottom-help"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</span><span><kbd>SPACE</kbd> jump</span><span><kbd>SHIFT</kbd> sprint</span><span><kbd>CTRL</kbd> crouch / sink</span><span><kbd>LMB</kbd> hit / break</span><span><kbd>RMB</kbd> place</span><span><kbd>E</kbd> inventory</span><span><kbd>ESC</kbd> pause</span><button id="pov-toggle" class="pov-toggle" type="button" aria-label="Change point of view">POV <kbd>F5</kbd></button></div>
      <div class="mobile-controls" id="mobile-controls">
        <div class="touch-look-zone" id="touch-look-zone" aria-label="Drag to look"></div>
        <div class="move-pad" id="move-pad"><div class="move-pad-ring"></div><div class="move-pad-thumb" id="move-pad-thumb"></div></div>
        <div class="touch-actions">
          <button class="touch-button touch-pause" id="touch-pause" type="button" aria-label="Pause">Ⅱ</button>
          <button class="touch-button touch-break" id="touch-break" type="button" aria-label="Hit pig or break block">⛏</button>
          <button class="touch-button touch-place" id="touch-place" type="button" aria-label="Place block">▣</button>
          <button class="touch-button touch-jump" id="touch-jump" type="button" aria-label="Jump">↑</button>
          <button class="touch-button touch-sprint" id="touch-sprint" type="button" aria-label="Sprint">»</button>
          <button class="touch-button touch-inventory" id="touch-inventory" type="button" aria-label="Inventory">▦</button>
        </div>
      </div>
      <div class="game-menu menu-panorama-active" id="game-menu">
        <div class="title-panorama" aria-hidden="true">
          <img class="panorama-shot" src="${panorama0Url}" alt="" />
          <img class="panorama-shot" src="${panorama1Url}" alt="" />
          <img class="panorama-shot" src="${panorama2Url}" alt="" />
          <img class="panorama-shot" src="${panorama3Url}" alt="" />
        </div>
        <div class="menu-screen menu-title-screen" id="screen-title">
          <div class="menu-title-art"><img class="title-logo" src="${titleLogoUrl}" alt="Minecraft CE logo" /></div>
          <button class="menu-button" id="open-worlds" type="button">Singleplayer</button>
          <button class="menu-button" id="multiplayer-notice" type="button">Multiplayer</button>
          <div class="title-bottom-actions">
            <button class="menu-button compact" id="title-options" type="button">Options...</button>
            <button class="menu-button compact" id="quit-game" type="button">Quit Game</button>
          </div>
          <div class="menu-footer"><span>FIELDCRAFT CE · BUILD 1.0</span><span>EXPLORE THE OVERWORLD</span></div>
        </div>
        <div class="menu-screen" id="screen-worlds" hidden>
          <h1 class="menu-heading">Select World</h1>
          <div class="saved-world-list" id="saved-world-list" aria-live="polite"></div>
          <button class="menu-button" id="make-world-open" type="button">Create New World</button>
          <button class="menu-button secondary" data-menu-back="title" type="button">Back</button>
        </div>
        <div class="menu-screen" id="screen-create-world" hidden>
          <h1 class="menu-heading">Create New World</h1>
          <label class="menu-field" for="world-name-input">World name
            <input id="world-name-input" type="text" maxlength="32" value="New World" autocomplete="off" />
          </label>
          <label class="menu-field" for="custom-seed-input">Seed
            <span class="seed-input-wrap"><input id="custom-seed-input" type="text" inputmode="numeric" pattern="[0-9]{1,16}" value="109297457103" maxlength="16" autocomplete="off" spellcheck="false" /><button id="randomize-seed" type="button" aria-label="Randomize seed" title="Randomize seed">⤨</button></span>
          </label>
          <button class="menu-button" id="create-world-button" type="button">Create New World</button>
          <button class="menu-button secondary" data-menu-back="worlds" type="button">Cancel</button>
        </div>
        <div class="menu-screen" id="screen-multiplayer" hidden>
          <h1 class="menu-heading">LAN Multiplayer</h1>
          <p class="lan-help">Host: open a world, pause, choose Start as LAN, then share its code. Joiners must open this game from the host computer's network address.</p>
          <label class="menu-field" for="lan-code-input">Four-digit join code
            <input id="lan-code-input" type="text" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="one-time-code" />
          </label>
          <button class="menu-button" id="join-lan-world" type="button">Join World</button>
          <p class="lan-status" id="lan-status" role="status" aria-live="polite"></p>
          <button class="menu-button secondary" data-menu-back="title" type="button">Back</button>
        </div>
        <div class="menu-screen options-screen" id="screen-options" hidden>
          <h1 class="menu-heading" id="options-heading">Video Settings</h1>
          <div class="options-tabs" role="tablist" aria-label="Options categories">
            <button class="options-tab selected" id="video-tab" type="button" role="tab" aria-selected="true">Video</button>
            <button class="options-tab" id="controls-tab" type="button" role="tab" aria-selected="false">Controls</button>
          </div>
          <div class="options-panel" id="video-options" role="tabpanel">
            <h2 class="setting-section-title">Display</h2>
            <div class="video-setting-grid">
              <button class="setting-tile wide" id="fullscreen-toggle" type="button">Fullscreen: Off</button>
              <button class="setting-tile" id="max-framerate-toggle" type="button">Max Framerate: Unlimited</button>
              <label class="setting-tile slider-tile">
                <span class="slider-caption"><span class="slider-name">Resolution Quality</span><span class="slider-value" id="quality-label">100%</span></span>
                <input id="quality-slider" type="range" min="50" max="100" step="10" value="100" />
              </label>
              <label class="setting-tile slider-tile">
                <span class="slider-caption"><span class="slider-name">Brightness</span><span class="slider-value" id="brightness-label">100%</span></span>
                <input id="brightness-slider" type="range" min="70" max="130" step="5" value="100" />
              </label>
            </div>
            <h2 class="setting-section-title">Quality &amp; Performance</h2>
            <div class="video-setting-grid">
              <label class="setting-tile slider-tile wide">
                <span class="slider-caption"><span class="slider-name">Render Distance</span><span class="slider-value" id="render-distance-label">6 Chunks</span></span>
                <input id="render-distance-slider" type="range" min="6" max="32" step="1" value="6" />
              </label>
              <button class="setting-tile wide" id="shadows-toggle" type="button" aria-pressed="true">Shadows: On</button>
            </div>
          </div>
          <div class="options-panel" id="controls-options" role="tabpanel" hidden>
            <label class="slider-tile slider-row">
              <span class="slider-caption"><span class="slider-name">Mouse sensitivity</span><span class="slider-value" id="mouse-sensitivity-label">100%</span></span>
              <input id="mouse-sensitivity" type="range" min="25" max="200" step="5" value="100" />
            </label>
            <div class="mobile-settings">
              <p>Touch controls</p>
              <label class="slider-tile slider-row">
                <span class="slider-caption"><span class="slider-name">Look sensitivity</span><span class="slider-value" id="mobile-sensitivity-label">100%</span></span>
                <input id="mobile-sensitivity" type="range" min="50" max="200" step="10" value="100" />
              </label>
              <label class="slider-tile slider-row">
                <span class="slider-caption"><span class="slider-name">Joystick size</span><span class="slider-value" id="joystick-size-label">126 px</span></span>
                <input id="joystick-size" type="range" min="96" max="176" step="8" value="126" />
              </label>
              <label class="slider-tile slider-row">
                <span class="slider-caption"><span class="slider-name">Touch button opacity</span><span class="slider-value" id="touch-opacity-label">85%</span></span>
                <input id="touch-opacity" type="range" min="30" max="100" step="5" value="85" />
              </label>
            </div>
          </div>
          <button class="menu-button secondary" id="options-done" type="button">Done</button>
        </div>
        <div class="menu-screen pause-screen" id="screen-pause" hidden>
          <h1 class="menu-heading">Game Paused</h1>
          <p class="paused-world-name" id="paused-world-name">World</p>
          <button class="menu-button" id="resume-world" type="button">Back to Game</button>
          <button class="menu-button" id="pause-start-lan" type="button">Start as LAN</button>
          <p class="lan-status" id="pause-lan-status" role="status" aria-live="polite"></p>
          <button class="menu-button" id="pause-options" type="button">Options...</button>
          <button class="menu-button" id="save-quit-world" type="button">Save and Quit to Title</button>
        </div>
      </div>
      <div class="world-loading" id="world-loading" hidden><span class="loading-spinner"></span><strong id="world-loading-label">Building world...</strong></div>
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
scene.background = new THREE.Color('#78c8f5');
scene.fog = new THREE.Fog('#a8ddf7', 130, 360);
const camera = new THREE.PerspectiveCamera(72, 1, 0.08, 320);
camera.rotation.order = 'YXZ';
camera.position.set(0, 24, 0);
scene.add(camera);
const playerPosition = camera.position.clone();
const playerModel = new THREE.Group();
playerModel.visible = false;
scene.add(playerModel);
let steveAvatarTemplate: THREE.Group | undefined;
let playerWalkBob = 0;
const playerAnimationJoints: { leftArm?: THREE.Group; rightArm?: THREE.Group; leftLeg?: THREE.Group; rightLeg?: THREE.Group } = {};
let povMode: 'first-person' | 'third-person-back' | 'third-person-front' = 'first-person';

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
const sleeveMaterials: THREE.MeshStandardMaterial[] = [];
const sleeve = new THREE.Mesh(
  new THREE.BoxGeometry(0.23, 0.43, 0.26),
  sleeveMaterials,
);
sleeve.scale.set(0.78, 0.76, 0.78);
sleeve.position.set(0.43, -0.48, -1.05);
const handMaterials: THREE.MeshStandardMaterial[] = [];
const hand = new THREE.Mesh(
  new THREE.BoxGeometry(0.2, 0.2, 0.23),
  handMaterials,
);
hand.scale.set(0.78, 0.78, 0.78);
hand.position.set(0.43, -0.73, -1.07);
const heldBlock = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), new THREE.MeshStandardMaterial({ roughness: 1 }));
heldBlock.position.set(0.27, -0.48, -0.87);
heldBlock.rotation.set(0.42, 0.58, 0.22);
heldBlock.renderOrder = 3;
heldBlock.visible = false;
viewArm.add(sleeve, hand, heldBlock);
viewArm.renderOrder = 2;
viewArm.visible = false;
camera.add(viewArm);

type SkinRegion = readonly [x: number, y: number, width: number, height: number];

function createSteveFaceMaterials(image: HTMLImageElement, regions: readonly SkinRegion[]): THREE.MeshStandardMaterial[] {
  return regions.map(([sourceX, sourceY, width, height]) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    context.imageSmoothingEnabled = false;
    context.drawImage(image, sourceX, sourceY, width, height, 0, 0, width, height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;

    return new THREE.MeshStandardMaterial({ map: texture, roughness: 1 });
  });
}
new THREE.TextureLoader().load(steveModelTextureUrl, (skinTexture) => {
  const image = skinTexture.image as HTMLImageElement;

  sleeve.material = createSteveFaceMaterials(image, [
    [48, 20, 4, 12], [40, 20, 4, 12], [44, 16, 4, 4],
    [48, 16, 4, 4], [44, 20, 4, 12], [52, 20, 4, 12],
  ]);
  hand.material = createSteveFaceMaterials(image, [
    [48, 28, 4, 4], [40, 28, 4, 4], [44, 16, 4, 4],
    [48, 16, 4, 4], [44, 28, 4, 4], [52, 28, 4, 4],
  ]);

  skinTexture.dispose();
});

const steveModelTexture = new THREE.TextureLoader().load(
  steveModelTextureUrl,
  undefined,
  undefined,
  (error) => {
    console.error('Could not load the Steve model texture.', error);
    showToast('Steve texture failed to load');
  },
);
steveModelTexture.flipY = false;
steveModelTexture.colorSpace = THREE.SRGBColorSpace;
steveModelTexture.magFilter = THREE.NearestFilter;
steveModelTexture.minFilter = THREE.NearestFilter;
steveModelTexture.generateMipmaps = false;

new OBJLoader().load(
  steveModelUrl,
  (model) => {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    if (size.y <= 0 || !Number.isFinite(size.y)) {
      console.error('Steve OBJ has invalid dimensions.');
      showToast('Steve model has invalid dimensions');
      return;
    }
    model.scale.setScalar(1.8 / size.y);
    const scaledBounds = new THREE.Box3().setFromObject(model);
    model.position.set(
      -(scaledBounds.min.x + scaledBounds.max.x) / 2,
      -scaledBounds.min.y,
      -(scaledBounds.min.z + scaledBounds.max.z) / 2,
    );
    const skinMaterial = new THREE.MeshStandardMaterial({
      map: steveModelTexture,
      roughness: 1,
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
    });
    const originalMeshes: THREE.Mesh[] = [];
    model.traverse((part) => {
      if (part instanceof THREE.Mesh) originalMeshes.push(part);
    });
    for (const sourceMesh of originalMeshes) {
      const sourceGeometry = sourceMesh.geometry.index
        ? sourceMesh.geometry.toNonIndexed()
        : sourceMesh.geometry;
      const attributes = sourceGeometry.attributes;
      const position = attributes.position;
      if (!position || position.count % 3 !== 0) {
        sourceMesh.material = skinMaterial;
        continue;
      }
      const buckets = new Map<string, Record<string, number[]>>();
      const partForVertex = new Map<number, string>();
      for (const name of ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']) {
        buckets.set(name, Object.fromEntries(Object.keys(attributes).map((key) => [key, []])));
      }
      const verticesPerCuboid = 36;
      for (let cuboidStart = 0; cuboidStart < position.count; cuboidStart += verticesPerCuboid) {
        const cuboidEnd = Math.min(cuboidStart + verticesPerCuboid, position.count);
        let centerX = 0;
        let centerY = 0;
        for (let vertex = cuboidStart; vertex < cuboidEnd; vertex += 1) {
          centerX += position.getX(vertex);
          centerY += position.getY(vertex);
        }
        centerX /= cuboidEnd - cuboidStart;
        centerY /= cuboidEnd - cuboidStart;
        const partName = centerY < -4
          ? centerX < 0 ? 'leftLeg' : 'rightLeg'
          : centerY < 8 && Math.abs(centerX) > 4
            ? centerX < 0 ? 'leftArm' : 'rightArm'
            : centerY >= 8 ? 'head' : 'body';
        for (let vertex = cuboidStart; vertex < cuboidEnd; vertex += 1) partForVertex.set(vertex, partName);
      }
      for (let vertex = 0; vertex < position.count; vertex += 3) {
        const bucket = buckets.get(partForVertex.get(vertex) ?? 'body')!;
        for (const [name, attribute] of Object.entries(attributes)) {
          const values = bucket[name];
          for (let index = vertex; index < vertex + 3; index += 1) {
            for (let offset = 0; offset < attribute.itemSize; offset += 1) {
              values.push(attribute.array[index * attribute.itemSize + offset] as number);
            }
          }
        }
      }
      sourceMesh.removeFromParent();
      for (const [partName, bucketAttributes] of buckets) {
        const geometry = new THREE.BufferGeometry();
        for (const [name, values] of Object.entries(bucketAttributes)) {
          const attribute = attributes[name];
          if (values.length) geometry.setAttribute(name, new THREE.Float32BufferAttribute(values, attribute.itemSize, attribute.normalized));
        }
        if (!geometry.getAttribute('position')) continue;
        let parent: THREE.Group = model;
        if (partName === 'leftArm' || partName === 'rightArm' || partName === 'leftLeg' || partName === 'rightLeg') {
          const isLeft = partName.startsWith('left');
          const isLeg = partName.endsWith('Leg');
          const joint = new THREE.Group();
          joint.name = partName;
          const pivot = new THREE.Vector3(
            isLeg ? (isLeft ? -2 : 2) : (isLeft ? -6 : 6),
            isLeg ? -4 : 8,
            0,
          );
          joint.position.copy(pivot);
          const jointPositions = geometry.getAttribute('position');
          for (let vertex = 0; vertex < jointPositions.count; vertex += 1) {
            jointPositions.setXYZ(
              vertex,
              jointPositions.getX(vertex) - pivot.x,
              jointPositions.getY(vertex) - pivot.y,
              jointPositions.getZ(vertex) - pivot.z,
            );
          }
          jointPositions.needsUpdate = true;
          model.add(joint);
          parent = joint;
          playerAnimationJoints[partName as keyof typeof playerAnimationJoints] = joint;
        }
        const mesh = new THREE.Mesh(geometry, skinMaterial);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      sourceMesh.geometry.dispose();
      if (sourceGeometry !== sourceMesh.geometry) sourceGeometry.dispose();
    }
    playerModel.add(model);
    steveAvatarTemplate = model;
    for (const remote of remotePlayers.values()) attachRemoteSteve(remote);
  },
  undefined,
  (error) => {
    console.error('Could not load the Steve OBJ model.', error);
    showToast('Steve model failed to load');
  },
);

const pointerLock = new PointerLockControls(camera, renderer.domElement);
const WATER_LEVEL = 8.03;
const CHUNK_SIZE = 16;
interface LoadedChunk {
  chunkX: number;
  chunkZ: number;
  terrain: GeneratedTerrain;
  sandMeshes: THREE.Mesh[];
  placedMeshes: THREE.Mesh[];
  pigs: PigEntity[];
}

interface PigEntity {
  model: THREE.Group;
  legPivots: {
    frontLeft?: THREE.Group;
    frontRight?: THREE.Group;
    backLeft?: THREE.Group;
    backRight?: THREE.Group;
  };
  materials: THREE.MeshStandardMaterial[];
  knockbackVelocity: THREE.Vector3;
  x: number;
  z: number;
  heading: number;
  walkTime: number;
  walkPhase: number;
  health: number;
  fleeTime: number;
  hurtTime: number;
}

interface PlacedBlock {
  x: number;
  y: number;
  z: number;
  item: Exclude<InventoryItem, 'water' | 'empty'>;
}

const sandGroup = new THREE.Group();
scene.add(sandGroup);
const fallingSandBlocks: Array<{ mesh: THREE.Mesh; obstacle: GeneratedTerrain['obstacles'][number]; x: number; y: number; z: number; chunkKey: string }> = [];
const sandTexture = new THREE.TextureLoader().load(sandAtlasUrl);
sandTexture.colorSpace = THREE.SRGBColorSpace;
sandTexture.magFilter = THREE.NearestFilter;
sandTexture.minFilter = THREE.NearestFilter;
sandTexture.generateMipmaps = false;
const sandMaterial = new THREE.MeshStandardMaterial({ map: sandTexture, roughness: 1, metalness: 0 });
function loadBlockTexture(url: string): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}
const blockTextures: Record<PlacedBlock['item'], THREE.Texture> = {
  grass: loadBlockTexture(grassAtlasUrl),
  dirt: loadBlockTexture(grassAtlasUrl),
  stone: loadBlockTexture(stoneAtlasUrl),
  sand: sandTexture,
  wood: loadBlockTexture(oakTreeAtlasUrl),
  leaves: loadBlockTexture(leavesAtlasUrl),
};
const leavesMaterialOptions = { roughness: 1, alphaTest: 0.36 };
const sandGeometry = new THREE.BoxGeometry(1, 1, 1);
let renderDistance = 6;
const loadedChunks = new Map<string, LoadedChunk>();
const remotePlayerColor = (id: string): string => {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 65% 58%)`;
};
let pigTemplate: THREE.Group | undefined;
const placedBlocks = new Map<string, PlacedBlock>();
const removedSandBlocks = new Set<string>();
const removedGrassFoliage = new Set<string>();
let streamRing = 0;
let streamRingCursor = 0;
let streamAnchorX = Number.NaN;
let streamAnchorZ = Number.NaN;
let streamRadius = 0;
let worldInitialized = false;
let currentSeed = '109297457103';
let currentBiome: Biome = 'plains';
const biomeNames: Record<Biome, string> = {
  plains: 'OPEN PLAINS',
  woodland: 'OAK FOREST',
  highlands: 'BROKEN HIGHLANDS',
  desert: 'WIND-CUT DESERT',
  tundra: 'ALPINE TUNDRA',
};
const biomeGrassTints: Record<Biome, string> = {
  plains: '#8cab62',
  woodland: '#72a864',
  highlands: '#a1a979',
  desert: '#d5b66f',
  tundra: '#9da98e',
};
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
const standingEyeHeight = 1.62;
const crouchingEyeHeight = 1.27;
let eyeHeight = standingEyeHeight;
let playerHeight = 1.8;
let crouching = false;
const pressed = new Set<string>();
const clock = new THREE.Clock();
let frameAccumulator = 0;
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
let currentBreakKind: 'terrain' | 'tree' | 'placed' | 'sand' | 'foliage' = 'terrain';
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
  document.querySelector('#coordinate-readout')!.innerHTML = `X ${formatCoordinate(playerPosition.x)} &nbsp; Y ${formatCoordinate(playerPosition.y - eyeHeight)} &nbsp; Z ${formatCoordinate(playerPosition.z)}`;
  const biome = getBiomeAt(currentSeed, playerPosition.x, playerPosition.z);
  if (biome !== currentBiome) {
    currentBiome = biome;
    document.querySelector('#biome-readout')!.textContent = biomeNames[biome];
    if (inventory[selectedHotbarSlot].item === 'grass') updateHeldBlock();
  }
}

function showMenuScreen(screen: MenuScreen): void {
  activeMenuScreen = screen;
  const menu = document.querySelector<HTMLDivElement>('#game-menu')!;
  const showPanorama = screen !== 'pause' && !(screen === 'options' && optionsReturnScreen === 'pause');
  menu.classList.toggle('menu-panorama-active', showPanorama);
  document.querySelectorAll<HTMLDivElement>('.menu-screen').forEach((element) => {
    element.hidden = element.id !== `screen-${screen}`;
  });
  if (screen === 'multiplayer' && !lanSession) setLanStatus('');
  if (screen === 'pause') {
    document.querySelector('#paused-world-name')!.textContent = activeWorldName;
  }
  document.querySelector<HTMLDivElement>('#game-menu')!.hidden = false;
}

function setMenu(open: boolean): void {
  const menu = document.querySelector<HTMLDivElement>('#game-menu')!;
  if (open) {
    toggleInventory(false);
    showMenuScreen(requestedMenuScreen ?? (hasPlayed ? 'pause' : 'title'));
    requestedMenuScreen = undefined;
  } else {
    menu.hidden = true;
  }
  sceneRoot.classList.toggle('is-playing', !open);
  sceneRoot.classList.toggle('is-mobile-playing', !open && mobilePlaying);
  viewArm.visible = !open && povMode === 'first-person';
}

function showOptions(): void {
  optionsReturnScreen = activeMenuScreen;
  showMenuScreen('options');
}

function setOptionsTab(tab: 'video' | 'controls'): void {
  const videoSelected = tab === 'video';
  document.querySelector('#options-heading')!.textContent = videoSelected ? 'Video Settings' : 'Controls';
  document.querySelector<HTMLButtonElement>('#video-tab')!.classList.toggle('selected', videoSelected);
  document.querySelector<HTMLButtonElement>('#controls-tab')!.classList.toggle('selected', !videoSelected);
  document.querySelector<HTMLButtonElement>('#video-tab')!.setAttribute('aria-selected', String(videoSelected));
  document.querySelector<HTMLButtonElement>('#controls-tab')!.setAttribute('aria-selected', String(!videoSelected));
  document.querySelector<HTMLDivElement>('#video-options')!.hidden = !videoSelected;
  document.querySelector<HTMLDivElement>('#controls-options')!.hidden = videoSelected;
}

function applyGameSettings(): void {
  renderDistance = gameSettings.renderDistance;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * gameSettings.resolutionQuality);
  renderer.shadowMap.enabled = gameSettings.shadows;
  renderer.shadowMap.needsUpdate = true;
  renderer.toneMappingExposure = 1.08 * gameSettings.brightness;
  pointerLock.pointerSpeed = gameSettings.mouseSensitivity;
  sceneRoot.style.setProperty('--touch-pad-size', `${gameSettings.joystickSize}px`);
  sceneRoot.style.setProperty('--touch-opacity', String(gameSettings.touchOpacity));
  syncRenderDistance();
  resizeScene();
}

function syncFullscreenButton(): void {
  const button = document.querySelector<HTMLButtonElement>('#fullscreen-toggle');
  if (button) button.textContent = `Fullscreen: ${document.fullscreenElement ? 'On' : 'Off'}`;
}

function syncSettingsInputs(): void {
  (document.querySelector<HTMLInputElement>('#render-distance-slider')!).value = String(gameSettings.renderDistance);
  (document.querySelector<HTMLInputElement>('#quality-slider')!).value = String(gameSettings.resolutionQuality * 100);
  (document.querySelector<HTMLInputElement>('#brightness-slider')!).value = String(gameSettings.brightness * 100);
  (document.querySelector<HTMLInputElement>('#mouse-sensitivity')!).value = String(gameSettings.mouseSensitivity * 100);
  (document.querySelector<HTMLInputElement>('#mobile-sensitivity')!).value = String(gameSettings.mobileSensitivity * 100);
  (document.querySelector<HTMLInputElement>('#joystick-size')!).value = String(gameSettings.joystickSize);
  (document.querySelector<HTMLInputElement>('#touch-opacity')!).value = String(gameSettings.touchOpacity * 100);
  document.querySelector('#quality-label')!.textContent = `${Math.round(gameSettings.resolutionQuality * 100)}%`;
  document.querySelector('#brightness-label')!.textContent = `${Math.round(gameSettings.brightness * 100)}%`;
  document.querySelector('#render-distance-label')!.textContent = `${gameSettings.renderDistance} Chunks`;
  document.querySelector('#mouse-sensitivity-label')!.textContent = `${Math.round(gameSettings.mouseSensitivity * 100)}%`;
  document.querySelector('#mobile-sensitivity-label')!.textContent = `${Math.round(gameSettings.mobileSensitivity * 100)}%`;
  document.querySelector('#joystick-size-label')!.textContent = `${gameSettings.joystickSize} px`;
  document.querySelector('#touch-opacity-label')!.textContent = `${Math.round(gameSettings.touchOpacity * 100)}%`;
  const shadowsButton = document.querySelector<HTMLButtonElement>('#shadows-toggle')!;
  shadowsButton.setAttribute('aria-pressed', String(gameSettings.shadows));
  shadowsButton.textContent = `Shadows: ${gameSettings.shadows ? 'On' : 'Off'}`;
  const frameButton = document.querySelector<HTMLButtonElement>('#max-framerate-toggle')!;
  frameButton.textContent = `Max Framerate: ${gameSettings.maxFrameRate === 0 ? 'Unlimited' : `${gameSettings.maxFrameRate} FPS`}`;
  syncFullscreenButton();
  syncRenderDistance();
}

function loadGameSettings(): void {
  try {
    const stored = localStorage.getItem(GAME_SETTINGS_KEY);
    if (stored) {
      const values = JSON.parse(stored) as Partial<GameSettings>;
      if (Number.isFinite(values.renderDistance)) gameSettings.renderDistance = THREE.MathUtils.clamp(Math.round(values.renderDistance!), 6, 32);
      if (Number.isFinite(values.resolutionQuality)) gameSettings.resolutionQuality = THREE.MathUtils.clamp(values.resolutionQuality!, 0.5, 1);
      if (typeof values.shadows === 'boolean') gameSettings.shadows = values.shadows;
      if ([0, 30, 60].includes(values.maxFrameRate ?? -1)) gameSettings.maxFrameRate = values.maxFrameRate!;
      if (Number.isFinite(values.brightness)) gameSettings.brightness = THREE.MathUtils.clamp(values.brightness!, 0.7, 1.3);
      if (Number.isFinite(values.mouseSensitivity)) gameSettings.mouseSensitivity = THREE.MathUtils.clamp(values.mouseSensitivity!, 0.25, 2);
      if (Number.isFinite(values.mobileSensitivity)) gameSettings.mobileSensitivity = THREE.MathUtils.clamp(values.mobileSensitivity!, 0.5, 2);
      if (Number.isFinite(values.joystickSize)) gameSettings.joystickSize = THREE.MathUtils.clamp(Math.round(values.joystickSize!), 96, 176);
      if (Number.isFinite(values.touchOpacity)) gameSettings.touchOpacity = THREE.MathUtils.clamp(values.touchOpacity!, 0.3, 1);
    }
  } catch (error) {
    console.error('Could not load saved game settings.', error);
    showToast('Saved options could not be loaded');
  }
  syncSettingsInputs();
  applyGameSettings();
}

function saveGameSettings(): void {
  try {
    localStorage.setItem(GAME_SETTINGS_KEY, JSON.stringify(gameSettings));
  } catch (error) {
    console.error('Could not save game settings.', error);
    showToast('Options could not be saved');
  }
}

function isSavedWorld(value: unknown): value is SavedWorld {
  if (!value || typeof value !== 'object') return false;
  const world = value as Partial<SavedWorld>;
  const validItems: InventoryItem[] = ['grass', 'dirt', 'stone', 'sand', 'wood', 'leaves', 'water', 'empty'];
  return typeof world.id === 'string'
    && typeof world.name === 'string'
    && typeof world.seed === 'string'
    && normalizeSeed(world.seed) !== undefined
    && typeof world.savedAt === 'number'
    && Array.isArray(world.position) && world.position.length === 3 && world.position.every(Number.isFinite)
    && Array.isArray(world.rotation) && world.rotation.length === 2 && world.rotation.every(Number.isFinite)
    && Array.isArray(world.removedColumns) && world.removedColumns.every((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1]))
    && Array.isArray(world.removedTreeParts) && world.removedTreeParts.every((part) => typeof part === 'string')
    && Array.isArray(world.removedGrassFoliage) && world.removedGrassFoliage.every((part) => typeof part === 'string')
    && Array.isArray(world.placedBlocks) && world.placedBlocks.every((block) =>
      Boolean(block) && Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.z)
        && ['grass', 'dirt', 'stone', 'sand', 'wood', 'leaves'].includes(block.item))
    && Array.isArray(world.removedSandBlocks) && world.removedSandBlocks.every((part) => typeof part === 'string')
    && Array.isArray(world.inventory) && world.inventory.length === inventory.length
      && world.inventory.every((slot) => Boolean(slot) && validItems.includes(slot.item) && Number.isFinite(slot.count) && slot.count >= 0)
    && Number.isInteger(world.selectedHotbarSlot) && world.selectedHotbarSlot! >= 0 && world.selectedHotbarSlot! < 9;
}

function loadSavedWorlds(): void {
  try {
    const stored = localStorage.getItem(SAVED_WORLDS_KEY);
    if (!stored) {
      savedWorlds = [];
      return;
    }
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) throw new Error('Saved world list is not an array.');
    savedWorlds = parsed.filter(isSavedWorld).sort((a, b) => b.savedAt - a.savedAt);
  } catch (error) {
    console.error('Could not load saved worlds.', error);
    savedWorlds = [];
    showToast('Saved worlds could not be loaded');
  }
}

function renderSavedWorlds(): void {
  const list = document.querySelector<HTMLDivElement>('#saved-world-list')!;
  list.replaceChildren();
  if (savedWorlds.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-world-list';
    empty.textContent = 'No saved worlds yet. Create a world to get started.';
    list.append(empty);
    return;
  }
  for (const world of savedWorlds) {
    const row = document.createElement('div');
    row.className = 'saved-world-row';
    const details = document.createElement('div');
    details.className = 'saved-world-details';
    const name = document.createElement('strong');
    name.textContent = world.name;
    const metadata = document.createElement('small');
    metadata.textContent = `Seed ${world.seed} · Saved ${new Date(world.savedAt).toLocaleString()}`;
    details.append(name, metadata);
    const actions = document.createElement('div');
    actions.className = 'saved-world-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'menu-button compact';
    play.dataset.worldAction = 'play';
    play.dataset.worldId = world.id;
    play.textContent = 'Play';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'menu-button compact secondary';
    remove.dataset.worldAction = 'delete';
    remove.dataset.worldId = world.id;
    remove.textContent = 'Delete';
    actions.append(play, remove);
    row.append(details, actions);
    list.append(row);
  }
}

function saveCurrentWorld(): boolean {
  if (!worldInitialized) {
    showToast('Create or load a world before saving');
    return false;
  }
  if (!activeWorldId) activeWorldId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const world: SavedWorld = {
    id: activeWorldId,
    name: activeWorldName,
    seed: currentSeed,
    savedAt: Date.now(),
    position: [playerPosition.x, playerPosition.y, playerPosition.z],
    rotation: [camera.rotation.x, camera.rotation.y],
    removedColumns: [...removedColumns],
    removedTreeParts: [...removedTreeParts],
    removedGrassFoliage: [...removedGrassFoliage],
    placedBlocks: [...placedBlocks.values()],
    removedSandBlocks: [...removedSandBlocks],
    inventory: inventory.map((slot) => ({ ...slot })),
    selectedHotbarSlot,
  };
  savedWorlds = [world, ...savedWorlds.filter((entry) => entry.id !== world.id)];
  try {
    localStorage.setItem(SAVED_WORLDS_KEY, JSON.stringify(savedWorlds));
    return true;
  } catch (error) {
    console.error('Could not save the world.', error);
    showToast('World save failed; browser storage may be full');
    return false;
  }
}

function restoreSavedWorld(world: SavedWorld): void {
  for (const key of [...loadedChunks.keys()]) disposeChunk(key);
  removedColumns.clear();
  world.removedColumns.forEach(([key, count]) => removedColumns.set(key, count));
  removedTreeParts.clear();
  world.removedTreeParts.forEach((part) => removedTreeParts.add(part));
  removedGrassFoliage.clear();
  world.removedGrassFoliage.forEach((part) => removedGrassFoliage.add(part));
  placedBlocks.clear();
  world.placedBlocks.forEach((block) => placedBlocks.set(placedBlockKey(block.x, block.y, block.z), { ...block }));
  removedSandBlocks.clear();
  world.removedSandBlocks.forEach((part) => removedSandBlocks.add(part));
  inventory.forEach((slot, index) => Object.assign(slot, world.inventory[index]));
  selectedHotbarSlot = world.selectedHotbarSlot;
  activeWorldId = world.id;
  activeWorldName = world.name;
  currentSeed = world.seed;
  worldInitialized = false;
  streamAnchorX = Number.NaN;
  streamAnchorZ = Number.NaN;
  hasPlayed = true;
  renderInventory();
  generateWorld(world.seed, false, { position: world.position, rotation: world.rotation });
}

function startPlaying(): void {
  hasPlayed = true;
  if (touchControlsAvailable) {
    mobilePlaying = true;
    pressed.clear();
    setMenu(false);
    return;
  }
  pointerLock.lock();
}

function pauseWorld(): void {
  if (!worldInitialized || (!pointerLock.isLocked && !mobilePlaying)) return;
  if (mobilePlaying) {
    mobilePlaying = false;
    pressed.clear();
    breakHeld = false;
    setMenu(true);
  } else if (pointerLock.isLocked) {
    pointerLock.unlock();
  }
}

function quitToTitle(): void {
  if (!saveCurrentWorld()) return;
  if (lanSession) {
    const session = lanSession;
    lanSession = undefined;
    void requestLan('/api/lan/leave', { code: session.code, playerId: session.playerId }).catch((error: unknown) => {
      console.error('Could not leave the LAN world cleanly.', error);
    });
  }
  mobilePlaying = false;
  pressed.clear();
  breakHeld = false;
  requestedMenuScreen = 'title';
  if (pointerLock.isLocked) pointerLock.unlock();
  else setMenu(true);
}

const itemNames: Record<InventoryItem, string> = {
  grass: 'Grass block', dirt: 'Dirt', stone: 'Stone', sand: 'Sand', wood: 'Oak log',
  leaves: 'Oak leaves', water: 'Water bucket', empty: 'Empty slot',
};

function renderInventory(): void {
  const hotbar = document.querySelector<HTMLDivElement>('#hotbar')!;
  const inventoryGrid = document.querySelector<HTMLDivElement>('#inventory-grid')!;
  const inventoryHotbar = document.querySelector<HTMLDivElement>('#inventory-hotbar')!;
  hotbar.innerHTML = Array.from({ length: 9 }, (_, index) => inventorySlotMarkup(index, index === selectedHotbarSlot, index === heldInventorySlot)).join('');
  inventoryGrid.innerHTML = Array.from({ length: 27 }, (_, index) => inventorySlotMarkup(index + 9, false, index + 9 === heldInventorySlot)).join('');
  inventoryHotbar.innerHTML = Array.from({ length: 9 }, (_, index) => inventorySlotMarkup(index, index === selectedHotbarSlot, index === heldInventorySlot)).join('');
  document.querySelector('#selected-item-name')!.textContent = itemNames[inventory[selectedHotbarSlot].item];
  updateHeldBlock();
}

function updateHeldBlock(): void {
  const item = inventory[selectedHotbarSlot].item;
  heldBlock.visible = item !== 'empty' && item !== 'water';
  if (item === 'empty' || item === 'water') return;
  heldBlock.geometry.dispose();
  const previousMaterials = Array.isArray(heldBlock.material) ? heldBlock.material : [heldBlock.material];
  previousMaterials.forEach((material) => material.dispose());
  heldBlock.geometry = createBlockGeometry(item, 0.28);
  heldBlock.material = createBlockMaterial(item, getBiomeAt(currentSeed, playerPosition.x, playerPosition.z));
}

function toggleInventory(force?: boolean): void {
  const panel = document.querySelector<HTMLDivElement>('#inventory-panel');
  if (!panel) return;
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (!open) heldInventorySlot = undefined;
  renderInventory();
}

function syncPovCamera(): void {
  if (povMode === 'first-person') {
    camera.position.copy(playerPosition);
    playerModel.visible = false;
    return;
  }
  const direction = pointerLock.getDirection(new THREE.Vector3());
  const target = new THREE.Vector3(playerPosition.x, playerPosition.y - eyeHeight + 1.15, playerPosition.z);
  playerModel.position.set(playerPosition.x, playerPosition.y - eyeHeight + playerWalkBob, playerPosition.z);
  playerModel.rotation.set(0, camera.rotation.y + (povMode === 'third-person-back' ? Math.PI : 0), 0);
  playerModel.visible = true;
  camera.position.copy(target).addScaledVector(direction, -4.2);
}

function cyclePov(): void {
  povMode = povMode === 'first-person' ? 'third-person-back'
    : povMode === 'third-person-back' ? 'third-person-front'
      : 'first-person';
  const button = document.querySelector<HTMLButtonElement>('#pov-toggle')!;
  const label = povMode === 'first-person' ? 'First person' : povMode === 'third-person-back' ? 'Third person rear view' : 'Third person front view';
  button.setAttribute('aria-label', `Change point of view. Current view: ${label}`);
  button.dataset.mode = povMode;
  viewArm.visible = povMode === 'first-person' && (pointerLock.isLocked || mobilePlaying);
  syncPovCamera();
}

let ambientAudio: AudioContext | undefined;
let ambientGain: GainNode | undefined;
let ambientTimer = 0;
let ambientStep = 0;

function playAmbientNote(): void {
  if (!ambientAudio || !ambientGain || ambientAudio.state !== 'running') return;
  const melody = [196, 247, 294, 370, 330, 247, 220, 294, 392, 330, 247, 220];
  const now = ambientAudio.currentTime;
  const oscillator = ambientAudio.createOscillator();
  const envelope = ambientAudio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = melody[ambientStep % melody.length];
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(0.025, now + 0.12);
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.35);
  oscillator.connect(envelope).connect(ambientGain);
  oscillator.addEventListener('ended', () => {
    oscillator.disconnect();
    envelope.disconnect();
  }, { once: true });
  oscillator.start(now);
  oscillator.stop(now + 1.4);
  if (ambientStep % 4 === 0) {
    const bass = ambientAudio.createOscillator();
    const bassEnvelope = ambientAudio.createGain();
    bass.type = 'triangle';
    bass.frequency.value = melody[(ambientStep + 4) % melody.length] / 2;
    bassEnvelope.gain.setValueAtTime(0.0001, now);
    bassEnvelope.gain.exponentialRampToValueAtTime(0.008, now + 0.2);
    bassEnvelope.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
    bass.connect(bassEnvelope).connect(ambientGain);
    bass.addEventListener('ended', () => {
      bass.disconnect();
      bassEnvelope.disconnect();
    }, { once: true });
    bass.start(now);
    bass.stop(now + 2.7);
  }
  ambientStep += 1;
}

async function toggleAmbientMusic(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>('#music-toggle')!;
  if (!ambientAudio) {
    ambientAudio = new AudioContext();
    ambientGain = ambientAudio.createGain();
    ambientGain.gain.value = 0;
    ambientGain.connect(ambientAudio.destination);
  }
  if (ambientAudio.state === 'suspended') await ambientAudio.resume();
  const enabled = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(enabled));
  button.textContent = enabled ? 'Music on' : 'Music off';
  if (enabled) {
    ambientGain!.gain.setTargetAtTime(1, ambientAudio.currentTime, 0.25);
    playAmbientNote();
    ambientTimer = window.setInterval(playAmbientNote, 760);
  } else {
    window.clearInterval(ambientTimer);
    ambientGain!.gain.setTargetAtTime(0, ambientAudio.currentTime, 0.18);
  }
}

function handleInventorySlotClick(index: number): void {
  if (heldInventorySlot === undefined) {
    if (index < 9) selectedHotbarSlot = index;
    else heldInventorySlot = index;
  } else {
    [inventory[index], inventory[heldInventorySlot]] = [inventory[heldInventorySlot], inventory[index]];
    if (index < 9) selectedHotbarSlot = index;
    heldInventorySlot = undefined;
  }
  renderInventory();
}

function swapInventorySlots(source: number, destination: number): void {
  if (source === destination) return;
  [inventory[source], inventory[destination]] = [inventory[destination], inventory[source]];
  if (destination < 9) selectedHotbarSlot = destination;
  heldInventorySlot = undefined;
  renderInventory();
}

let inventoryDragSource: number | undefined;

function bindInventoryDragging(): void {
  let touchSource: number | undefined;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDragging = false;
  let suppressNextInventoryClick = false;
  const clearTouchDrag = (): void => {
    sceneRoot.querySelectorAll('.inventory-slot.dragging, .inventory-slot.drop-target').forEach((slot) => {
      slot.classList.remove('dragging', 'drop-target');
    });
    touchSource = undefined;
    touchDragging = false;
  };

  sceneRoot.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
    if (!slot) return;
    touchSource = Number(slot.dataset.inventorySlot);
    touchStartX = event.clientX;
    touchStartY = event.clientY;
  });
  sceneRoot.addEventListener('pointermove', (event) => {
    if (touchSource === undefined || event.pointerType !== 'touch') return;
    if (!touchDragging && Math.hypot(event.clientX - touchStartX, event.clientY - touchStartY) > 7) {
      touchDragging = true;
      sceneRoot.querySelector<HTMLButtonElement>(`[data-inventory-slot="${touchSource}"]`)?.classList.add('dragging');
    }
    if (!touchDragging) return;
    event.preventDefault();
    sceneRoot.querySelectorAll('.inventory-slot.drop-target').forEach((slot) => slot.classList.remove('drop-target'));
    document.elementFromPoint(event.clientX, event.clientY)?.closest('.inventory-slot')?.classList.add('drop-target');
  });
  sceneRoot.addEventListener('pointerup', (event) => {
    if (touchSource === undefined || event.pointerType !== 'touch') return;
    const destination = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('[data-inventory-slot]');
    if (touchDragging && destination) {
      event.preventDefault();
      swapInventorySlots(touchSource, Number(destination.dataset.inventorySlot));
      suppressNextInventoryClick = true;
      window.setTimeout(() => { suppressNextInventoryClick = false; }, 0);
    }
    clearTouchDrag();
  });
  sceneRoot.addEventListener('pointercancel', clearTouchDrag);

  sceneRoot.addEventListener('dragstart', (event) => {
    const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
    if (!slot || !event.dataTransfer) return;
    inventoryDragSource = Number(slot.dataset.inventorySlot);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(inventoryDragSource));
    slot.classList.add('dragging');
  });
  sceneRoot.addEventListener('dragover', (event) => {
    const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
    if (!slot) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    sceneRoot.querySelectorAll('.inventory-slot.drop-target').forEach((candidate) => candidate.classList.remove('drop-target'));
    slot.classList.add('drop-target');
  });
  sceneRoot.addEventListener('drop', (event) => {
    const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
    if (!slot) return;
    event.preventDefault();
    const source = inventoryDragSource ?? Number(event.dataTransfer?.getData('text/plain'));
    const destination = Number(slot.dataset.inventorySlot);
    if (Number.isInteger(source) && source >= 0 && source < inventory.length) {
      swapInventorySlots(source, destination);
    }
    inventoryDragSource = undefined;
  });
  sceneRoot.addEventListener('dragend', (event) => {
    const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
    slot?.classList.remove('dragging');
    sceneRoot.querySelectorAll('.inventory-slot.drop-target').forEach((candidate) => candidate.classList.remove('drop-target'));
    inventoryDragSource = undefined;
  });
  sceneRoot.addEventListener('click', (event) => {
    if (!suppressNextInventoryClick) return;
    if (!(event.target as HTMLElement).closest('[data-inventory-slot]')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressNextInventoryClick = false;
  }, true);
}

function addItemToInventory(item: InventoryItem, count = 1): boolean {
  if (item === 'empty' || count <= 0) return false;
  const selected = inventory[selectedHotbarSlot];
  let destination = selected.item === item || selected.item === 'empty'
    ? selectedHotbarSlot
    : inventory.findIndex((slot) => slot.item === item && slot.count < 64);
  if (destination < 0) destination = inventory.findIndex((slot) => slot.item === 'empty');
  if (destination < 0) return false;

  const slot = inventory[destination];
  if (slot.item === item) slot.count = Math.min(64, slot.count + count);
  else {
    slot.item = item;
    slot.count = Math.min(64, count);
  }
  renderInventory();
  return true;
}

function consumeSelectedItem(): InventoryItem | undefined {
  const slot = inventory[selectedHotbarSlot];
  if (slot.count <= 0 || slot.item === 'empty' || slot.item === 'water') return undefined;
  const item = slot.item;
  slot.count -= 1;
  if (slot.count === 0) slot.item = 'empty';
  renderInventory();
  return item;
}

function showToast(message: string): void {
  const toast = document.querySelector<HTMLDivElement>('#world-toast')!;
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 1700);
}

class LanApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'LanApiError';
  }
}

async function requestLan<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const isGitHubPages = location.hostname === 'github.io' || location.hostname.endsWith('.github.io');
    const message = isGitHubPages
      ? 'GitHub Pages cannot host LAN rooms. On the host PC run npm run lan, open http://localhost:5173, then start the world there. Joiners use the host’s printed network address.'
      : 'This page is not connected to the LAN server. Run npm run lan on the host PC and open the game from the host’s printed network address.';
    throw new LanApiError(
      message,
      response.status,
    );
  }
  let result: { error?: string } & T;
  try {
    result = await response.json() as { error?: string } & T;
  } catch (error) {
    throw new LanApiError(`LAN server returned invalid JSON: ${error instanceof Error ? error.message : 'invalid response'}`, response.status);
  }
  if (!response.ok) throw new LanApiError(result.error ?? `LAN server returned ${response.status}`, response.status);
  return result;
}

function currentLanPlayerState(): LanPlayerState {
  return {
    x: playerPosition.x,
    y: playerPosition.y,
    z: playerPosition.z,
    yaw: camera.rotation.y,
    pitch: camera.rotation.x,
    crouching,
  };
}

function snapshotWorldEdits(): LocalWorldEdit[] {
  const edits: LocalWorldEdit[] = [];
  const makeEdit = (kind: LocalWorldEdit['kind'], key: string, chunkX: number, chunkZ: number, count?: number): LocalWorldEdit => ({
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    kind,
    key,
    chunkX,
    chunkZ,
    ...(count === undefined ? {} : { count }),
  });
  for (const [key, count] of removedColumns) {
    const [x, z] = key.split(',').map(Number);
    edits.push(makeEdit('terrain', key, Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE), count));
  }
  for (const key of removedTreeParts) {
    const coordinates = key.startsWith('fallen-log:') ? key.slice(key.lastIndexOf(':') + 1) : key.split(':')[1];
    const [x, z] = coordinates.split(',').map(Number);
    edits.push(makeEdit('tree', key, Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }
  for (const key of removedGrassFoliage) {
    const [x, z] = key.split(',').map(Number);
    edits.push(makeEdit('foliage', key, Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }
  for (const key of removedSandBlocks) {
    const [x, , z] = key.split(',').map(Number);
    edits.push(makeEdit('sand', key, Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)));
  }
  for (const block of placedBlocks.values()) {
    edits.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      kind: 'place',
      block: { ...block },
      chunkX: Math.floor(block.x / CHUNK_SIZE),
      chunkZ: Math.floor(block.z / CHUNK_SIZE),
    });
  }
  return edits;
}

function queueLanEdit(edit: Omit<LocalWorldEdit, 'id'>): void {
  if (!lanSession) return;
  pendingLanEdits.push({
    ...edit,
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  });
}

function attachRemoteSteve(remote: RemotePlayer): void {
  if (!steveAvatarTemplate || remote.model) return;
  if (remote.fallback) {
    remote.group.remove(remote.fallback);
    cleanObject(remote.fallback);
    remote.fallback = undefined;
  }
  const model = steveAvatarTemplate.clone(true);
  model.visible = true;
  remote.group.add(model);
  remote.model = model;
  for (const part of ['leftArm', 'rightArm', 'leftLeg', 'rightLeg'] as const) {
    const joint = model.getObjectByName(part);
    if (joint instanceof THREE.Group) remote.animationJoints[part] = joint;
  }
}

function createRemotePlayer(id: string, name: string, target: LanPlayerState): RemotePlayer {
  const group = new THREE.Group();
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 256;
  labelCanvas.height = 64;
  const context = labelCanvas.getContext('2d');
  if (context) {
    context.fillStyle = '#111c';
    context.fillRect(0, 0, labelCanvas.width, labelCanvas.height);
    context.fillStyle = '#fff';
    context.font = '28px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(name.slice(0, 20), 128, 32, 240);
    const labelTexture = new THREE.CanvasTexture(labelCanvas);
    labelTexture.colorSpace = THREE.SRGBColorSpace;
    labelTexture.minFilter = THREE.NearestFilter;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthTest: false }));
    label.position.y = 2.08;
    label.scale.set(1.8, 0.45, 1);
    group.add(label);
  }
  const remote: RemotePlayer = {
    group,
    target: { ...target },
    animationJoints: {},
    previousPosition: new THREE.Vector3(target.x, target.y - (target.crouching ? crouchingEyeHeight : standingEyeHeight), target.z),
    walkPhase: 0,
    moveSpeed: 0,
  };
  if (steveAvatarTemplate) {
    attachRemoteSteve(remote);
  } else {
    const fallback = new THREE.Group();
    const colorMaterial = new THREE.MeshStandardMaterial({ color: remotePlayerColor(id), roughness: 1 });
    const skinMaterial = new THREE.MeshStandardMaterial({ color: '#d6a47b', roughness: 1 });
    const addPart = (geometry: THREE.BoxGeometry, material: THREE.MeshStandardMaterial, position: THREE.Vector3): THREE.Mesh => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.castShadow = true;
      fallback.add(mesh);
      return mesh;
    };
    addPart(new THREE.BoxGeometry(0.58, 0.8, 0.3), colorMaterial, new THREE.Vector3(0, 0.9, 0));
    addPart(new THREE.BoxGeometry(0.42, 0.42, 0.42), skinMaterial, new THREE.Vector3(0, 1.52, 0));
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.38, 1.3, 0);
      const armMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.72, 0.28), colorMaterial);
      armMesh.position.y = -0.36;
      armMesh.castShadow = true;
      arm.add(armMesh);
      fallback.add(arm);
      remote.animationJoints[side < 0 ? 'leftArm' : 'rightArm'] = arm;
      const leg = new THREE.Group();
      leg.position.set(side * 0.16, 0.9, 0);
      const legMesh = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.75, 0.3), colorMaterial);
      legMesh.position.y = -0.375;
      legMesh.castShadow = true;
      leg.add(legMesh);
      fallback.add(leg);
      remote.animationJoints[side < 0 ? 'leftLeg' : 'rightLeg'] = leg;
    }
    remote.fallback = fallback;
    group.add(fallback);
  }
  scene.add(group);
  group.position.copy(remote.previousPosition);
  group.rotation.y = target.yaw + Math.PI;
  return remote;
}

function disposeRemotePlayer(remote: RemotePlayer): void {
  scene.remove(remote.group);
  if (remote.fallback) cleanObject(remote.fallback);
  remote.group.traverse((object) => {
    if (!(object instanceof THREE.Sprite)) return;
    const material = object.material;
    if (material instanceof THREE.SpriteMaterial) {
      material.map?.dispose();
      material.dispose();
    }
  });
}

function clearRemotePlayers(): void {
  for (const remote of remotePlayers.values()) {
    disposeRemotePlayer(remote);
  }
  remotePlayers.clear();
}

function applyRemoteWorldEdit(edit: RemoteWorldEdit): void {
  if (edit.kind === 'terrain' && edit.key && edit.count !== undefined) removedColumns.set(edit.key, edit.count);
  else if (edit.kind === 'tree' && edit.key) removedTreeParts.add(edit.key);
  else if (edit.kind === 'foliage' && edit.key) removedGrassFoliage.add(edit.key);
  else if (edit.kind === 'sand' && edit.key) removedSandBlocks.add(edit.key);
  else if (edit.kind === 'break-placed' && edit.key) placedBlocks.delete(edit.key);
  else if (edit.kind === 'place' && edit.block) placedBlocks.set(placedBlockKey(edit.block.x, edit.block.y, edit.block.z), { ...edit.block });
  else return;
  if (loadedChunks.has(chunkKey(edit.chunkX, edit.chunkZ))) rebuildChunk(edit.chunkX, edit.chunkZ);
}

async function synchronizeLanRoom(): Promise<void> {
  if (!lanSession || lanSyncInProgress) return;
  const session = lanSession;
  lanSyncInProgress = true;
  const edits = pendingLanEdits.slice(0, 100);
  try {
    const response = await requestLan<LanSyncResponse>('/api/lan/sync', {
      code: session.code,
      playerId: session.playerId,
      state: currentLanPlayerState(),
      edits,
      after: lastLanEditSequence,
    });
    pendingLanEdits.splice(0, edits.length);
    const activePlayers = new Set<string>();
    for (const player of response.players) {
      if (player.id === session.playerId || !player.state) continue;
      activePlayers.add(player.id);
      let remote = remotePlayers.get(player.id);
      if (!remote) {
        remote = createRemotePlayer(player.id, player.name, player.state);
        remotePlayers.set(player.id, remote);
      }
      remote.target = player.state;
      attachRemoteSteve(remote);
    }
    for (const [id, remote] of remotePlayers) {
      if (activePlayers.has(id)) continue;
      disposeRemotePlayer(remote);
      remotePlayers.delete(id);
    }
    for (const edit of response.edits) {
      lastLanEditSequence = Math.max(lastLanEditSequence, edit.sequence);
      if (edit.playerId !== session.playerId) applyRemoteWorldEdit(edit);
    }
    const status = `Connected · code ${session.code} · ${response.players.length} player${response.players.length === 1 ? '' : 's'}`;
    document.querySelector('#lan-status')!.textContent = status;
    document.querySelector('#pause-lan-status')!.textContent = status;
  } catch (error) {
    if (error instanceof LanApiError && error.status === 404) {
      lanSession = undefined;
      document.querySelector<HTMLDivElement>('#lan-room-badge')!.hidden = true;
      document.querySelector('#pause-lan-status')!.textContent = 'LAN world disconnected.';
      clearRemotePlayers();
      showToast('LAN world is no longer available');
    }
    const message = error instanceof Error ? error.message : 'Unknown LAN error';
    document.querySelector('#lan-status')!.textContent = `Connection issue: ${message}`;
    document.querySelector('#pause-lan-status')!.textContent = `Connection issue: ${message}`;
  } finally {
    lanSyncInProgress = false;
  }
}

function updateRemotePlayers(delta: number): void {
  for (const remote of remotePlayers.values()) {
    remote.group.position.x = THREE.MathUtils.damp(remote.group.position.x, remote.target.x, delta, 12);
    const remoteEyeHeight = remote.target.crouching ? crouchingEyeHeight : standingEyeHeight;
    remote.group.position.y = THREE.MathUtils.damp(remote.group.position.y, remote.target.y - remoteEyeHeight, delta, 12);
    if (remote.model && steveAvatarTemplate) {
      remote.model.scale.y = steveAvatarTemplate.scale.y * (remote.target.crouching ? 1.5 / 1.8 : 1);
    }
    remote.group.position.z = THREE.MathUtils.damp(remote.group.position.z, remote.target.z, delta, 12);
    const yawDifference = THREE.MathUtils.euclideanModulo(remote.target.yaw + Math.PI - remote.group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    remote.group.rotation.y += yawDifference * (1 - Math.exp(-12 * delta));

    const movedX = remote.group.position.x - remote.previousPosition.x;
    const movedZ = remote.group.position.z - remote.previousPosition.z;
    const observedSpeed = delta > 0 ? Math.hypot(movedX, movedZ) / delta : 0;
    remote.moveSpeed = THREE.MathUtils.damp(remote.moveSpeed, Math.min(observedSpeed, 8.8), delta, 8);
    remote.previousPosition.set(remote.group.position.x, remote.group.position.y, remote.group.position.z);
    if (remote.moveSpeed > 0.15) {
      remote.walkPhase += delta * remote.moveSpeed * Math.PI;
      const limbSwing = Math.sin(remote.walkPhase) * 0.65 * Math.min(remote.moveSpeed / 5.6, 1);
      if (remote.animationJoints.leftArm) remote.animationJoints.leftArm.rotation.x = limbSwing;
      if (remote.animationJoints.rightArm) remote.animationJoints.rightArm.rotation.x = -limbSwing;
      if (remote.animationJoints.leftLeg) remote.animationJoints.leftLeg.rotation.x = -limbSwing;
      if (remote.animationJoints.rightLeg) remote.animationJoints.rightLeg.rotation.x = limbSwing;
    } else {
      for (const joint of Object.values(remote.animationJoints)) {
        if (joint) joint.rotation.x = THREE.MathUtils.damp(joint.rotation.x, 0, delta, 10);
      }
    }
  }
}

function syncRenderDistance(): void {
  const slider = document.querySelector<HTMLInputElement>('#render-distance-slider');
  const label = document.querySelector<HTMLSpanElement>('#render-distance-label');
  if (!slider || !label) return;
  renderDistance = Number(slider.value);
  gameSettings.renderDistance = renderDistance;
  label.textContent = `${renderDistance} chunks`;
}

function randomSeed(): string {
  return String(Math.floor(100_000_000_000 + Math.random() * 900_000_000_000));
}

function normalizeSeed(seed: string): string | undefined {
  const value = seed.trim();
  if (!/^\d{1,16}$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
  return BigInt(value).toString();
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

function placedBlockKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

type TextureRect = readonly [uMin: number, vMin: number, uMax: number, vMax: number];

function createBlockGeometry(item: PlacedBlock['item'], size = 1): THREE.BoxGeometry {
  const geometry = new THREE.BoxGeometry(size, size, size);
  const dirtRect: TextureRect = [0, 0.25, 1, 0.5];
  const grassTopRect: TextureRect = [0, 0.75, 1, 1];
  const grassSideRect: TextureRect = [0, 0.5, 1, 0.75];
  const grassBottomRect: TextureRect = [0, 0, 1, 0.25];
  const woodBarkRect: TextureRect = [0, 0.5, 1, 1];
  const woodEndRect: TextureRect = [0, 0, 1, 0.5];
  const faceRects: TextureRect[] = item === 'grass'
    ? [grassSideRect, grassSideRect, grassTopRect, grassBottomRect, grassSideRect, grassSideRect]
    : item === 'dirt'
      ? Array.from({ length: 6 }, () => dirtRect)
      : item === 'wood'
        ? [woodBarkRect, woodBarkRect, woodEndRect, woodEndRect, woodBarkRect, woodBarkRect]
        : Array.from({ length: 6 }, () => [0, 0, 1, 1] as const);
  const uv = geometry.getAttribute('uv');
  faceRects.forEach(([uMin, vMin, uMax, vMax], face) => {
    for (let corner = 0; corner < 4; corner += 1) {
      const index = face * 4 + corner;
      uv.setXY(index, uMin + uv.getX(index) * (uMax - uMin), vMin + uv.getY(index) * (vMax - vMin));
    }
  });
  uv.needsUpdate = true;
  return geometry;
}

function createBlockMaterial(item: PlacedBlock['item'], biome = currentBiome): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: blockTextures[item],
    roughness: 1,
    ...(item === 'leaves' ? leavesMaterialOptions : {}),
  });
  if (item === 'grass') {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.grassBlockTint = { value: new THREE.Color(biomeGrassTints[biome]) };
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        '#include <common>\nuniform vec3 grassBlockTint;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float atlasMax = max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b);
        float atlasMin = min(min(diffuseColor.r, diffuseColor.g), diffuseColor.b);
        float grayMask = 1.0 - smoothstep(0.025, 0.12, atlasMax - atlasMin);
        diffuseColor.rgb *= mix(vec3(1.0), grassBlockTint, grayMask * step(0.5, vMapUv.y));`,
      );
    };
    material.customProgramCacheKey = () => 'placed-grass-block-tint-v1';
  }
  return material;
}

function createPlacedBlockMesh(block: PlacedBlock): THREE.Mesh {
  const mesh = new THREE.Mesh(
    createBlockGeometry(block.item),
    createBlockMaterial(block.item, getBiomeAt(currentSeed, block.x + 0.5, block.z + 0.5)),
  );
  mesh.position.set(block.x + 0.5, block.y + 0.5, block.z + 0.5);
  mesh.name = 'placed-block';
  mesh.userData.blockKey = placedBlockKey(block.x, block.y, block.z);
  mesh.userData.chunkKey = chunkKey(Math.floor(block.x / CHUNK_SIZE), Math.floor(block.z / CHUNK_SIZE));
  mesh.userData.inventoryItem = block.item;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function entityRandom(chunkX: number, chunkZ: number, salt: number): number {
  let value = Number(BigInt(currentSeed) & 0xffff_ffffn)
    ^ Math.imul(chunkX + salt, 0x9e3779b1)
    ^ Math.imul(chunkZ - salt, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return ((value ^ (value >>> 16)) >>> 0) / 0x1_0000_0000;
}

function addPig(chunk: LoadedChunk, x: number, z: number, salt: number): void {
  if (!pigTemplate) return;
  const ground = chunk.terrain.groundHeightAt(x, z);
  const biome = getBiomeAt(currentSeed, x, z);
  if (ground <= WATER_LEVEL + 1 || ground >= 23 || (biome !== 'woodland' && biome !== 'plains')) return;
  const blocked = chunk.terrain.obstacles.some((obstacle) =>
    obstacle.bottom < ground + 0.8 && obstacle.top > ground
    && Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.55);
  if (blocked) return;

  const model = new THREE.Group();
  const pigModel = pigTemplate.clone(true);
  const legPivots: PigEntity['legPivots'] = {};
  const materials: THREE.MeshStandardMaterial[] = [];
  pigModel.traverse((part) => {
    if (part.name === 'pig-leg-front-left') legPivots.frontLeft = part as THREE.Group;
    else if (part.name === 'pig-leg-front-right') legPivots.frontRight = part as THREE.Group;
    else if (part.name === 'pig-leg-back-left') legPivots.backLeft = part as THREE.Group;
    else if (part.name === 'pig-leg-back-right') legPivots.backRight = part as THREE.Group;
    if (part instanceof THREE.Mesh) {
      const sourceMaterials = Array.isArray(part.material) ? part.material : [part.material];
      const clonedMaterials = sourceMaterials.map((material) => material.clone());
      clonedMaterials.forEach((material) => {
        if (material instanceof THREE.MeshStandardMaterial) materials.push(material);
      });
      part.material = Array.isArray(part.material) ? clonedMaterials : clonedMaterials[0];
    }
  });
  model.add(pigModel);
  const heading = entityRandom(chunk.chunkX + salt, chunk.chunkZ, salt + 17) * Math.PI * 2;
  model.position.set(x, ground, z);
  model.rotation.y = heading + Math.PI;
  model.name = 'pig-entity';
  scene.add(model);
  chunk.pigs.push({
    model,
    legPivots,
    materials,
    x,
    z,
    heading,
    walkTime: 1 + entityRandom(chunk.chunkX, chunk.chunkZ + salt, salt + 31) * 2.5,
    walkPhase: 0,
    knockbackVelocity: new THREE.Vector3(),
    health: 10,
    fleeTime: 0,
    hurtTime: 0,
  });
}

function spawnPigsForChunk(chunk: LoadedChunk): void {
  if (!pigTemplate || chunk.pigs.length > 0) return;
  const centerX = chunk.chunkX * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centerZ = chunk.chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centerBiome = getBiomeAt(currentSeed, centerX, centerZ);
  if ((centerBiome !== 'woodland' && centerBiome !== 'plains')
    || entityRandom(chunk.chunkX, chunk.chunkZ, 1) >= 0.3) return;

  const pigCount = 1 + Math.floor(entityRandom(chunk.chunkX, chunk.chunkZ, 2) * 2);
  for (let index = 0; index < pigCount; index += 1) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const x = chunk.chunkX * CHUNK_SIZE + 2 + entityRandom(chunk.chunkX + index, chunk.chunkZ + attempt, 3 + index * 7 + attempt) * (CHUNK_SIZE - 4);
      const z = chunk.chunkZ * CHUNK_SIZE + 2 + entityRandom(chunk.chunkX - attempt, chunk.chunkZ + index, 41 + index * 7 + attempt) * (CHUNK_SIZE - 4);
      const biome = getBiomeAt(currentSeed, x, z);
      if (biome !== 'woodland' && biome !== 'plains') continue;
      const before = chunk.pigs.length;
      addPig(chunk, x, z, index * 11 + attempt);
      if (chunk.pigs.length > before) break;
    }
  }
}

function updatePigs(delta: number): void {
  for (const chunk of loadedChunks.values()) {
    for (const pig of chunk.pigs) {
      if (pig.hurtTime > 0) {
        pig.hurtTime = Math.max(0, pig.hurtTime - delta);
        if (pig.hurtTime === 0) pig.materials.forEach((material) => material.color.set('#d98e91'));
      }
      if (pig.walkTime <= 0) {
        pig.heading = entityRandom(Math.floor(pig.x), Math.floor(pig.z), Math.floor(pig.walkPhase * 10) + 53) * Math.PI * 2;
        pig.walkTime = 1 + entityRandom(Math.floor(pig.z), Math.floor(pig.x), Math.floor(pig.walkPhase) + 79) * 2.5;
      }
      const speed = pig.fleeTime > 0 ? 4.2 : 0.85;
      const nextX = pig.x + (Math.sin(pig.heading) * speed + pig.knockbackVelocity.x) * delta;
      const nextZ = pig.z + (Math.cos(pig.heading) * speed + pig.knockbackVelocity.z) * delta;
      const nextChunk = chunkAt(nextX, nextZ);
      const nextGround = nextChunk?.terrain.groundHeightAt(nextX, nextZ);
      let blocked = !nextChunk || nextGround === undefined || nextGround <= WATER_LEVEL + 1
        || Math.abs(nextGround - pig.model.position.y) > 1;
      if (!blocked && nextGround !== undefined) {
        const nextChunkX = Math.floor(nextX / CHUNK_SIZE);
        const nextChunkZ = Math.floor(nextZ / CHUNK_SIZE);
        for (let dz = nextChunkZ - 1; dz <= nextChunkZ + 1 && !blocked; dz += 1) {
          for (let dx = nextChunkX - 1; dx <= nextChunkX + 1 && !blocked; dx += 1) {
            const nearby = loadedChunks.get(chunkKey(dx, dz));
            if (nearby?.terrain.obstacles.some((obstacle) =>
              obstacle.bottom < nextGround + 0.8 && obstacle.top > nextGround
              && Math.hypot(nextX - obstacle.x, nextZ - obstacle.z) < obstacle.radius + 0.38)) blocked = true;
          }
        }
      }
      if (blocked) {
        pig.heading = (pig.heading + Math.PI / 2 + entityRandom(Math.floor(pig.x), Math.floor(pig.z), Math.floor(pig.walkPhase * 10) + 101) * Math.PI) % (Math.PI * 2);
        pig.walkTime = 1;
        pig.knockbackVelocity.set(0, 0, 0);
      } else {
        pig.x = nextX;
        pig.z = nextZ;
        pig.walkTime -= delta;
        pig.walkPhase += delta * (pig.fleeTime > 0 ? 14 : 8);
        pig.knockbackVelocity.multiplyScalar(Math.exp(-4.5 * delta));
      }
      pig.fleeTime = Math.max(0, pig.fleeTime - delta);
      const ground = chunkAt(pig.x, pig.z)?.terrain.groundHeightAt(pig.x, pig.z) ?? pig.model.position.y;
      pig.model.position.set(pig.x, ground + Math.abs(Math.sin(pig.walkPhase)) * 0.025, pig.z);
      pig.model.rotation.y = pig.heading + Math.PI;
      const stride = Math.sin(pig.walkPhase) * 0.62;
      for (const [joint, direction] of [
        [pig.legPivots.frontLeft, 1],
        [pig.legPivots.backRight, 1],
        [pig.legPivots.frontRight, -1],
        [pig.legPivots.backLeft, -1],
      ] as const) {
        if (joint) joint.rotation.x = THREE.MathUtils.damp(joint.rotation.x, stride * direction, delta, 12);
      }
    }
  }
}

function disposeChunk(key: string): void {
  const chunk = loadedChunks.get(key);
  if (!chunk) return;
  scene.remove(chunk.terrain.group);
  cleanObject(chunk.terrain.group);
  for (const pig of chunk.pigs) scene.remove(pig.model);
  for (const sand of chunk.sandMeshes) {
    sandGroup.remove(sand);
    const index = fallingSandBlocks.findIndex((entry) => entry.mesh === sand);
    if (index >= 0) fallingSandBlocks.splice(index, 1);
  }
  loadedChunks.delete(key);
}

function loadChunk(chunkX: number, chunkZ: number): void {
  const key = chunkKey(chunkX, chunkZ);
  if (loadedChunks.has(key)) return;
  const centerX = chunkX * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centerZ = chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;
  const generated = generateTerrain({
    seed: currentSeed,
    chunkSize: CHUNK_SIZE,
    radius: 0,
    relief: 18,
    centerX,
    centerZ,
    removedColumns: Object.fromEntries(removedColumns),
    removedTreeParts: [...removedTreeParts],
    removedGrassFoliage: [...removedGrassFoliage],
  });
  generated.group.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) object.userData.chunkKey = key;
  });
  scene.add(generated.group);

  const sandMeshes: THREE.Mesh[] = [];
  const placedMeshes: THREE.Mesh[] = [];
  const minX = chunkX * CHUNK_SIZE;
  const minZ = chunkZ * CHUNK_SIZE;
  for (let z = 0; z < CHUNK_SIZE; z += 1) {
    for (let x = 0; x < CHUNK_SIZE; x += 1) {
      const worldX = minX + x;
      const worldZ = minZ + z;
      const ground = generated.groundHeightAt(worldX + 0.5, worldZ + 0.5);
      if (ground < WATER_LEVEL - 2.2 || ground >= WATER_LEVEL - 0.2) continue;
      const sand = new THREE.Mesh(sandGeometry, sandMaterial);
      const sandY = ground + 0.5;
      sand.position.set(worldX + 0.5, sandY, worldZ + 0.5);
      const sandKey = placedBlockKey(worldX, Math.floor(sandY - 0.5), worldZ);
      if (removedSandBlocks.has(sandKey)) continue;
      sand.name = 'sand-block';
      sand.userData.blockKey = sandKey;
      sand.userData.inventoryItem = 'sand';
      sand.userData.chunkKey = key;
      sand.castShadow = true;
      sand.receiveShadow = true;
      sandGroup.add(sand);
      sandMeshes.push(sand);
      const obstacle = { x: worldX + 0.5, y: sandY, z: worldZ + 0.5, radius: 0.5, bottom: sandY - 0.5, top: sandY + 0.5, fullBlock: true };
      fallingSandBlocks.push({ mesh: sand, obstacle, x: worldX + 0.5, y: sandY, z: worldZ + 0.5, chunkKey: key });
      generated.obstacles.push(obstacle);
    }
  }
  for (const block of placedBlocks.values()) {
    if (Math.floor(block.x / CHUNK_SIZE) !== chunkX || Math.floor(block.z / CHUNK_SIZE) !== chunkZ) continue;
    const mesh = createPlacedBlockMesh(block);
    generated.group.add(mesh);
    placedMeshes.push(mesh);
    generated.obstacles.push({
      x: block.x + 0.5,
      y: block.y + 0.5,
      z: block.z + 0.5,
      radius: 0.5,
      bottom: block.y,
      top: block.y + 1,
      fullBlock: true,
    });
  }
  const chunk: LoadedChunk = { chunkX, chunkZ, terrain: generated, sandMeshes, placedMeshes, pigs: [] };
  loadedChunks.set(key, chunk);
  spawnPigsForChunk(chunk);
  document.querySelector('#tree-count')!.textContent = String([...loadedChunks.values()].reduce((total, entry) => total + entry.terrain.trees, 0));
  document.querySelector('#chunk-count')!.textContent = String(loadedChunks.size);
}

function refreshChunkStream(resetCursor = false): void {
  const playerChunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
  const playerChunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
  if (resetCursor || playerChunkX !== streamAnchorX || playerChunkZ !== streamAnchorZ || streamRadius !== renderDistance) {
    streamAnchorX = playerChunkX;
    streamAnchorZ = playerChunkZ;
    streamRadius = renderDistance;
    streamRing = 0;
    streamRingCursor = 0;
    for (const chunk of loadedChunks.values()) {
      if (Math.abs(chunk.chunkX - playerChunkX) > renderDistance || Math.abs(chunk.chunkZ - playerChunkZ) > renderDistance) {
        disposeChunk(chunkKey(chunk.chunkX, chunk.chunkZ));
      }
    }
  }

  let added = 0;
  while (added < 2 && streamRing <= renderDistance) {
    let offsetX = 0;
    let offsetZ = 0;
    if (streamRing === 0) {
      if (streamRingCursor > 0) {
        streamRing = 1;
        streamRingCursor = 0;
        continue;
      }
      streamRingCursor = 1;
    } else {
      const side = streamRing * 2;
      const perimeter = side * 4;
      if (streamRingCursor >= perimeter) {
        streamRing += 1;
        streamRingCursor = 0;
        continue;
      }
      const index = streamRingCursor++;
      if (index < side) { offsetX = -streamRing + index; offsetZ = -streamRing; }
      else if (index < side * 2) { offsetX = streamRing; offsetZ = -streamRing + index - side; }
      else if (index < side * 3) { offsetX = streamRing - (index - side * 2); offsetZ = streamRing; }
      else { offsetX = -streamRing; offsetZ = streamRing - (index - side * 3); }
    }
    const targetX = playerChunkX + offsetX;
    const targetZ = playerChunkZ + offsetZ;
    if (!loadedChunks.has(chunkKey(targetX, targetZ))) {
      loadChunk(targetX, targetZ);
      added += 1;
    }
  }
}

function generateWorld(
  seed = currentSeed,
  forceReset = false,
  spawn?: { position: [number, number, number]; rotation: [number, number] },
): void {
  const nextSeed = normalizeSeed(seed);
  if (nextSeed === undefined) {
    showToast('Seed must be a whole number with up to 16 digits');
    return;
  }
  const seedChanged = nextSeed !== currentSeed || forceReset;
  currentSeed = nextSeed;
  if (seedChanged) {
    removedColumns.clear();
    removedTreeParts.clear();
    removedGrassFoliage.clear();
    placedBlocks.clear();
    removedSandBlocks.clear();
    for (const key of [...loadedChunks.keys()]) disposeChunk(key);
    streamAnchorX = Number.NaN;
    streamAnchorZ = Number.NaN;
    streamRing = 0;
    streamRingCursor = 0;
    playerPosition.set(...(spawn?.position ?? [8, 24, 8]));
    camera.position.copy(playerPosition);
    camera.rotation.set(spawn?.rotation[0] ?? 0, spawn?.rotation[1] ?? 0, 0);
    horizontalVelocity.set(0, 0, 0);
    verticalVelocity = 0;
    worldInitialized = false;
  } else if (spawn) {
    playerPosition.set(...spawn.position);
    camera.position.copy(playerPosition);
    camera.rotation.set(spawn.rotation[0], spawn.rotation[1], 0);
    horizontalVelocity.set(0, 0, 0);
    verticalVelocity = 0;
  }
  currentBiome = getBiomeAt(currentSeed, playerPosition.x, playerPosition.z);
  document.querySelector('#biome-readout')!.textContent = biomeNames[currentBiome];

  const toast = document.querySelector<HTMLDivElement>('#world-toast')!;
  toast.textContent = 'Loading nearby chunks';
  toast.classList.add('visible');

  if (!worldInitialized) {
    const spawnChunkX = Math.floor(playerPosition.x / CHUNK_SIZE);
    const spawnChunkZ = Math.floor(playerPosition.z / CHUNK_SIZE);
    loadChunk(spawnChunkX, spawnChunkZ);
    const centerChunk = loadedChunks.get(chunkKey(spawnChunkX, spawnChunkZ));
    if (centerChunk && !spawn) {
      playerPosition.y = Math.max(8, centerChunk.terrain.groundHeightAt(playerPosition.x, playerPosition.z)) + eyeHeight;
      camera.rotation.set(0, centerChunk.terrain.spawn.yaw, 0);
    }
    worldInitialized = true;
  }

  refreshChunkStream(true);
  syncPovCamera();
  updateReadout();
  showToast('World ready');
  if (!lanJoinInProgress) setMenu(!pointerLock.isLocked && !mobilePlaying);
}

function createNewWorld(): void {
  const requestedSeed = normalizeSeed(document.querySelector<HTMLInputElement>('#custom-seed-input')!.value);
  if (requestedSeed === undefined) {
    showToast('Seed must be a whole number with up to 16 digits');
    return;
  }
  const nameInput = document.querySelector<HTMLInputElement>('#world-name-input')!;
  const worldName = nameInput.value.trim().slice(0, 32);
  if (!worldName) {
    showToast('Enter a name for this world');
    nameInput.focus();
    return;
  }
  if (activeWorldId && worldInitialized) saveCurrentWorld();
  activeWorldId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeWorldName = worldName;
  hasPlayed = false;
  const loading = document.querySelector<HTMLDivElement>('#world-loading')!;
  loading.hidden = false;
  document.querySelector('#world-loading-label')!.textContent = 'Building world...';
  window.requestAnimationFrame(() => {
    try {
      generateWorld(requestedSeed, true);
      saveCurrentWorld();
      renderSavedWorlds();
      loading.hidden = true;
      showMenuScreen('worlds');
      showToast('World created and saved');
    } catch (error) {
      console.error('Could not create the world.', error);
      loading.hidden = true;
      showToast('World could not be created');
      showMenuScreen('create-world');
    }
  });
}

function chunkAt(worldX: number, worldZ: number): LoadedChunk | undefined {
  return loadedChunks.get(chunkKey(Math.floor(worldX / CHUNK_SIZE), Math.floor(worldZ / CHUNK_SIZE)));
}

function hasStandingHeadroom(x: number, feet: number, z: number): boolean {
  const head = feet + 1.8;
  const chunkX = Math.floor(x / CHUNK_SIZE);
  const chunkZ = Math.floor(z / CHUNK_SIZE);
  for (let dz = chunkZ - 1; dz <= chunkZ + 1; dz += 1) {
    for (let dx = chunkX - 1; dx <= chunkX + 1; dx += 1) {
      const chunk = loadedChunks.get(chunkKey(dx, dz));
      if (!chunk) continue;
      const caveCeiling = chunk.terrain.caveCeilingAt(x, z, feet);
      if (caveCeiling !== undefined && caveCeiling < head) return false;
      for (const obstacle of chunk.terrain.obstacles) {
        if (head <= obstacle.bottom || feet >= obstacle.top) continue;
        const overlapsRadius = obstacle.fullBlock
          ? x + 0.3 > obstacle.x - 0.5 && x - 0.3 < obstacle.x + 0.5
            && z + 0.3 > obstacle.z - 0.5 && z - 0.3 < obstacle.z + 0.5
          : Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.35;
        if (overlapsRadius) return false;
      }
    }
  }
  return true;
}

function terrainGroundAt(x: number, z: number): number {
  return chunkAt(x, z)?.terrain.groundHeightAt(x, z) ?? 8;
}

function sandGroundAt(x: number, z: number): number {
  const chunk = chunkAt(x, z);
  let ground = terrainGroundAt(x, z);
  if (!chunk) return ground;
  for (const sand of chunk.sandMeshes) {
    if (Math.abs(x - sand.position.x) < 0.5 && Math.abs(z - sand.position.z) < 0.5) {
      ground = Math.max(ground, sand.position.y + 0.5);
    }
  }
  return ground;
}

function groundAt(x: number, z: number, feetY?: number, stepHeight = 0.05): number {
  const normalGround = Math.max(terrainGroundAt(x, z), sandGroundAt(x, z));
  let placedGround = 0;
  const blockX = Math.floor(x);
  const blockZ = Math.floor(z);
  for (const block of placedBlocks.values()) {
    const top = block.y + 1;
    if (block.x === blockX && block.z === blockZ && (feetY === undefined || top <= feetY + stepHeight)) {
      placedGround = Math.max(placedGround, top);
    }
  }
  for (let chunkZ = Math.floor(z / CHUNK_SIZE) - 1; chunkZ <= Math.floor(z / CHUNK_SIZE) + 1; chunkZ += 1) {
    for (let chunkX = Math.floor(x / CHUNK_SIZE) - 1; chunkX <= Math.floor(x / CHUNK_SIZE) + 1; chunkX += 1) {
      const chunk = loadedChunks.get(chunkKey(chunkX, chunkZ));
      if (!chunk) continue;
      for (const obstacle of chunk.terrain.obstacles) {
        if (!obstacle.fullBlock
          || x < obstacle.x - 0.5 || x >= obstacle.x + 0.5
          || z < obstacle.z - 0.5 || z >= obstacle.z + 0.5
          || (feetY !== undefined && obstacle.top > feetY + stepHeight)) continue;
        placedGround = Math.max(placedGround, obstacle.top);
      }
    }
  }
  if (feetY !== undefined) {
    const caveFloor = chunkAt(x, z)?.terrain.caveFloorAt(x, z, feetY);
    if (caveFloor !== undefined) return Math.max(caveFloor, sandGroundAt(x, z), placedGround);
  }
  return Math.max(normalGround, placedGround);
}

function updateSandBlocks(delta: number): void {
  for (const sand of fallingSandBlocks) {
    const supportY = terrainGroundAt(sand.x, sand.z) + 0.5;
    sand.y = Math.max(supportY, sand.y - 2.6 * delta);
    sand.mesh.position.y = sand.y;
    sand.obstacle.y = sand.y;
    sand.obstacle.bottom = sand.y - 0.5;
    sand.obstacle.top = sand.y + 0.5;
  }
}

function getBlockTargetMeshes(): THREE.Object3D[] {
  const targetMeshes: THREE.Object3D[] = [];
  for (const chunk of loadedChunks.values()) {
    const terrainMesh = chunk.terrain.group.getObjectByName('terrain-block-mesh');
    const trunks = chunk.terrain.group.getObjectByName('tree-trunk-blocks');
    const leaves = chunk.terrain.group.getObjectByName('tree-leaf-blocks');
    const fallenLogs = chunk.terrain.group.getObjectByName('fallen-log-blocks');
    const grassFoliage = chunk.terrain.group.getObjectByName('grass-foliage-blocks');
    if (terrainMesh) targetMeshes.push(terrainMesh);
    if (trunks) targetMeshes.push(trunks);
    if (leaves) targetMeshes.push(leaves);
    if (fallenLogs) targetMeshes.push(fallenLogs);
    if (grassFoliage) targetMeshes.push(grassFoliage);
    targetMeshes.push(...chunk.sandMeshes, ...chunk.placedMeshes);
  }
  return targetMeshes;
}

function attackPig(): boolean {
  if (!loadedChunks.size || (!pointerLock.isLocked && !mobilePlaying)
    || !(document.querySelector('#inventory-panel') as HTMLDivElement).hidden) return false;

  const pigs = [...loadedChunks.values()].flatMap((chunk) => chunk.pigs);
  if (pigs.length === 0) return false;
  raycaster.setFromCamera(rayCenter, camera);
  const pigHit = raycaster.intersectObjects(pigs.map((pig) => pig.model), true)[0];
  if (!pigHit) return false;
  const blockHit = raycaster.intersectObjects(getBlockTargetMeshes(), false)[0];
  if (blockHit && blockHit.distance <= pigHit.distance) return false;

  const pig = pigs.find((candidate) => candidate.model.getObjectById(pigHit.object.id) === pigHit.object);
  if (!pig) return false;
  pig.health -= 2;
  if (pig.health <= 0) {
    scene.remove(pig.model);
    const chunk = [...loadedChunks.values()].find((entry) => entry.pigs.includes(pig));
    if (chunk) chunk.pigs.splice(chunk.pigs.indexOf(pig), 1);
    return true;
  }

  pig.materials.forEach((material) => material.color.set('#ff6868'));
  pig.hurtTime = 0.18;
  const fleeX = pig.x - playerPosition.x;
  const fleeZ = pig.z - playerPosition.z;
  if (Math.hypot(fleeX, fleeZ) > 0.001) {
    pig.heading = Math.atan2(fleeX, fleeZ);
    pig.knockbackVelocity.set(fleeX, 0, fleeZ).normalize();
  } else {
    pig.heading = (pig.heading + Math.PI) % (Math.PI * 2);
    pig.knockbackVelocity.set(Math.sin(pig.heading), 0, Math.cos(pig.heading));
  }
  pig.fleeTime = 1.5;
  pig.walkTime = Math.max(pig.walkTime, 1.5);
  pig.knockbackVelocity.multiplyScalar(8);
  return true;
}

function updateBreakTarget(delta: number): void {
  if (!loadedChunks.size || (!pointerLock.isLocked && !mobilePlaying)) {
    breakOverlay.visible = false;
    blockOutline.visible = false;
    currentBreakTarget = '';
    breakProgress = 0;
    document.querySelector('#break-meter')!.classList.remove('visible');
    return;
  }

  raycaster.setFromCamera(rayCenter, camera);
  const hit = raycaster.intersectObjects(getBlockTargetMeshes(), false)[0];
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
  let targetKind: 'terrain' | 'tree' | 'placed' | 'sand' | 'foliage';
  let dropItem: InventoryItem;
  let targetPosition: THREE.Vector3;
  const hitChunkKey = hit.object.userData.chunkKey as string | undefined;
  const hitChunk = hitChunkKey ? loadedChunks.get(hitChunkKey) : undefined;
  if (!hitChunk) return;
  if (hit.object.name === 'terrain-block-mesh') {
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const insidePoint = hit.point.clone().addScaledVector(normal, -0.015);
    const cell = hitChunk.terrain.cellAt(insidePoint.x, insidePoint.z);
    const columnHeight = hitChunk.terrain.groundHeightAt(insidePoint.x, insidePoint.z);
    const worldBlockX = hitChunk.chunkX * CHUNK_SIZE + cell.x;
    const worldBlockZ = hitChunk.chunkZ * CHUNK_SIZE + cell.z;
    if (columnHeight <= 2) {
      breakOverlay.visible = false;
      blockOutline.visible = false;
      currentBreakTarget = '';
      breakProgress = 0;
      breakFrame = -1;
      document.querySelector('#break-meter')!.classList.remove('visible');
      return;
    }
    targetId = `terrain:${worldBlockX},${worldBlockZ}`;
    targetKind = 'terrain';
    dropItem = (removedColumns.get(`${worldBlockX},${worldBlockZ}`) ?? 0) === 0 ? 'grass' : 'dirt';
    targetPosition = new THREE.Vector3(worldBlockX + 0.5, columnHeight - 0.5, worldBlockZ + 0.5);
  } else if (hit.object.name === 'placed-block' || hit.object.name === 'sand-block') {
    const blockKey = hit.object.userData.blockKey as string | undefined;
    if (!blockKey) return;
    targetId = `${hit.object.name}:${blockKey}`;
    targetKind = hit.object.name === 'sand-block' ? 'sand' : 'placed';
    dropItem = hit.object.userData.inventoryItem as InventoryItem;
    targetPosition = hit.object.position.clone();
  } else if (hit.object.name === 'grass-foliage-blocks') {
    const instanceMesh = hit.object as THREE.InstancedMesh;
    if (hit.instanceId === undefined) return;
    const partIds = instanceMesh.userData.breakPartIds as string[] | undefined;
    const partId = partIds?.[hit.instanceId];
    if (!partId) return;
    const instanceMatrix = new THREE.Matrix4();
    instanceMesh.getMatrixAt(hit.instanceId, instanceMatrix);
    targetPosition = new THREE.Vector3().setFromMatrixPosition(instanceMatrix).applyMatrix4(instanceMesh.matrixWorld);
    targetPosition.y += 0.38;
    targetId = `foliage:${partId}`;
    targetKind = 'foliage';
    dropItem = 'empty';
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
    dropItem = partId.startsWith('trunk:') || partId.startsWith('fallen-log:') ? 'wood' : 'leaves';
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
        queueLanEdit({ kind: 'terrain', key: cellId, count: removedCount + 1, chunkX: hitChunk.chunkX, chunkZ: hitChunk.chunkZ });
      } else if (targetKind === 'tree') {
        const key = targetId.slice('tree:'.length);
        removedTreeParts.add(key);
        queueLanEdit({ kind: 'tree', key, chunkX: hitChunk.chunkX, chunkZ: hitChunk.chunkZ });
      } else if (targetKind === 'sand') {
        const key = targetId.slice('sand-block:'.length);
        removedSandBlocks.add(key);
        queueLanEdit({ kind: 'sand', key, chunkX: hitChunk.chunkX, chunkZ: hitChunk.chunkZ });
      } else if (targetKind === 'foliage') {
        const key = targetId.slice('foliage:'.length);
        removedGrassFoliage.add(key);
        queueLanEdit({ kind: 'foliage', key, chunkX: hitChunk.chunkX, chunkZ: hitChunk.chunkZ });
      } else {
        const key = targetId.slice('placed-block:'.length);
        placedBlocks.delete(key);
        queueLanEdit({ kind: 'break-placed', key, chunkX: hitChunk.chunkX, chunkZ: hitChunk.chunkZ });
      }
      if (dropItem !== 'empty' && !addItemToInventory(dropItem)) showToast('Inventory full');
      breakHeld = false;
      breakProgress = 0;
      breakFrame = -1;
      viewArm.rotation.x = 0;
      rebuildChunk(hitChunk.chunkX, hitChunk.chunkZ);
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

function rebuildChunk(chunkX: number, chunkZ: number): void {
  const key = chunkKey(chunkX, chunkZ);
  disposeChunk(key);
  loadChunk(chunkX, chunkZ);
  refreshChunkStream();
  const ground = groundAt(playerPosition.x, playerPosition.z, playerPosition.y - eyeHeight);
  if (playerPosition.y - eyeHeight < ground) playerPosition.y = ground + eyeHeight;
  syncPovCamera();
  updateReadout();
}

function placeSelectedBlock(): void {
  if ((!pointerLock.isLocked && !mobilePlaying) || !loadedChunks.size
    || !(document.querySelector('#inventory-panel') as HTMLDivElement).hidden) return;
  const item = inventory[selectedHotbarSlot].item;
  if (item === 'empty' || item === 'water') return;

  raycaster.setFromCamera(rayCenter, camera);
  const hit = raycaster.intersectObjects(getBlockTargetMeshes(), false)[0];
  if (!hit?.face) return;

  const faceNormal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const position = hit.point.clone().addScaledVector(faceNormal, 0.51);
  const x = Math.floor(position.x);
  const y = Math.floor(position.y);
  const z = Math.floor(position.z);
  const key = placedBlockKey(x, y, z);
  const chunkX = Math.floor(x / CHUNK_SIZE);
  const chunkZ = Math.floor(z / CHUNK_SIZE);
  const chunk = loadedChunks.get(chunkKey(chunkX, chunkZ));
  if (!chunk || y < 0 || y >= 128 || placedBlocks.has(key)) return;

  const surfaceHeight = chunk.terrain.groundHeightAt(x + 0.5, z + 0.5);
  if (y < surfaceHeight) return;
  const blockIsOccupied = [...loadedChunks.values()].some((loaded) => loaded.terrain.obstacles.some((obstacle) =>
    y < obstacle.top && y + 1 > obstacle.bottom
    && x + 1 > obstacle.x - 0.5 && x < obstacle.x + 0.5
    && z + 1 > obstacle.z - 0.5 && z < obstacle.z + 0.5));
  if (blockIsOccupied) return;
  const playerFeet = playerPosition.y - eyeHeight;
  const playerRadius = 0.3;
  const intersectsPlayer = x + 1 > playerPosition.x - playerRadius
    && x < playerPosition.x + playerRadius
    && z + 1 > playerPosition.z - playerRadius
    && z < playerPosition.z + playerRadius
    && y < playerFeet + playerHeight
    && y + 1 > playerFeet;
  if (intersectsPlayer) return;

  const placed = { x, y, z, item };
  const mesh = createPlacedBlockMesh(placed);
  chunk.terrain.group.add(mesh);
  chunk.placedMeshes.push(mesh);
  chunk.terrain.obstacles.push({ x: x + 0.5, y: y + 0.5, z: z + 0.5, radius: 0.5, bottom: y, top: y + 1, fullBlock: true });
  placedBlocks.set(key, placed);
  queueLanEdit({ kind: 'place', block: placed, chunkX, chunkZ });
  consumeSelectedItem();
}

function updatePlayer(delta: number): void {
  if (!loadedChunks.size) return;
  const initialFeet = playerPosition.y - eyeHeight;
  const initialGround = groundAt(playerPosition.x, playerPosition.z, initialFeet);
  const initiallyInWater = initialGround < WATER_LEVEL && initialFeet < WATER_LEVEL && initialFeet + playerHeight > initialGround;
  const feetBeforePostureChange = playerPosition.y - eyeHeight;
  const wantsCrouch = !initiallyInWater && pressed.has('control');
  const canChangePosture = wantsCrouch || !crouching
    || hasStandingHeadroom(playerPosition.x, feetBeforePostureChange, playerPosition.z);
  crouching = wantsCrouch || !canChangePosture;
  eyeHeight = crouching ? crouchingEyeHeight : standingEyeHeight;
  playerHeight = crouching ? 1.5 : 1.8;
  playerModel.scale.y = playerHeight / 1.8;

  const feet = feetBeforePostureChange;
  playerPosition.y = feet + eyeHeight;
  const currentGround = groundAt(playerPosition.x, playerPosition.z, feet);
  const inWater = currentGround < WATER_LEVEL && feet < WATER_LEVEL && feet + playerHeight > currentGround;
  const grounded = !inWater && feet <= currentGround + 0.05 && verticalVelocity <= 0;
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
    if (povMode === 'third-person-front') moveForward.negate();
    if (!inWater) moveForward.y = 0;
    moveForward.normalize();
    moveRight.crossVectors(moveForward, up).normalize();
    movement.copy(moveForward).multiplyScalar(forwardInput).addScaledVector(moveRight, strafeInput);
    if (movement.lengthSq() > 1) movement.normalize();
  }

  const sprinting = !crouching && pressed.has('shift') && hasMovementInput;
  const surfaceSwimming = feet > WATER_LEVEL - 1.35;
  const swimSpeed = sprinting ? 3.918 : surfaceSwimming ? 2.2 : 1.97;
  targetVelocity.copy(movement).setY(0).multiplyScalar(inWater ? swimSpeed : crouching ? 1.7 : sprinting ? 8.8 : 5.6);
  velocityChange.subVectors(targetVelocity, horizontalVelocity);
  const isGrounded = grounded && verticalVelocity <= 0;
  const maxVelocityChange = inWater
    ? (hasMovementInput ? 12 : 4) * delta
    : (hasMovementInput ? (isGrounded ? 48 : 10) : (isGrounded ? 58 : 2.2)) * delta;
  const velocityChangeLength = velocityChange.length();
  if (velocityChangeLength > maxVelocityChange && velocityChangeLength > 0) {
    velocityChange.multiplyScalar(maxVelocityChange / velocityChangeLength);
  }
  horizontalVelocity.add(velocityChange);

  const canOccupy = (x: number, z: number): boolean => {
    const centerChunkX = Math.floor(x / CHUNK_SIZE);
    const centerChunkZ = Math.floor(z / CHUNK_SIZE);
    const centerChunk = loadedChunks.get(chunkKey(centerChunkX, centerChunkZ));
    if (!centerChunk) return false;
    const nextGround = groundAt(x, z, playerPosition.y - eyeHeight, 1.05);
    const steppingUp = nextGround > currentGround + 0.05
      && nextGround <= currentGround + 1.05;
    if (!inWater) {
      const highestWalkable = isGrounded
        ? currentGround + (steppingUp ? 1.05 : 0.05)
        : playerPosition.y - eyeHeight + 0.12;
      if (nextGround > highestWalkable) return false;
    }
    const playerFeet = steppingUp ? nextGround : playerPosition.y - eyeHeight;
    const playerHead = playerFeet + playerHeight;
    for (let chunkZ = centerChunkZ - 1; chunkZ <= centerChunkZ + 1; chunkZ += 1) {
      for (let chunkX = centerChunkX - 1; chunkX <= centerChunkX + 1; chunkX += 1) {
        const nearbyChunk = loadedChunks.get(chunkKey(chunkX, chunkZ));
        if (!nearbyChunk) continue;
        for (const obstacle of nearbyChunk.terrain.obstacles) {
          const overlapsHeight = playerHead > obstacle.bottom && playerFeet < obstacle.top;
          const overlapsRadius = obstacle.fullBlock
            ? x + 0.3 > obstacle.x - 0.5 && x - 0.3 < obstacle.x + 0.5
              && z + 0.3 > obstacle.z - 0.5 && z - 0.3 < obstacle.z + 0.5
            : Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + 0.35;
          if (overlapsHeight && overlapsRadius) return false;
        }
      }
    }
    return true;
  };

  const nextX = playerPosition.x + horizontalVelocity.x * delta;
  if (canOccupy(nextX, playerPosition.z)) playerPosition.x = nextX;
  else horizontalVelocity.x = 0;
  const nextZ = playerPosition.z + horizontalVelocity.z * delta;
  if (canOccupy(playerPosition.x, nextZ)) playerPosition.z = nextZ;
  else horizontalVelocity.z = 0;

  const previousFeet = playerPosition.y - eyeHeight;
  const ground = groundAt(playerPosition.x, playerPosition.z, previousFeet);
  if (inWater) {
    const controlSwim = Number(pressed.has(' ')) * 8 - Number(pressed.has('control')) * 8;
    const lookSwim = forwardInput !== 0 ? movement.y * swimSpeed : 0;
    verticalVelocity += (lookSwim + controlSwim - 2.2) * delta;
    if (forwardInput > 0 && !pressed.has('control') && !pressed.has(' ') && moveForward.y > -0.25
      && previousFeet > WATER_LEVEL - 1.8) {
      const surfaceFeet = WATER_LEVEL - 0.82;
      verticalVelocity += ((surfaceFeet - previousFeet) * 5 - verticalVelocity * 2.5) * delta;
    }
    verticalVelocity *= Math.exp(-2.2 * delta);
    playerPosition.y += verticalVelocity * delta;
    if (!pressed.has(' ') && playerPosition.y - eyeHeight > WATER_LEVEL - 0.25) {
      playerPosition.y = WATER_LEVEL - 0.25 + eyeHeight;
      verticalVelocity = 0;
    }
    if (playerPosition.y - eyeHeight < ground) {
      playerPosition.y = ground + eyeHeight;
      verticalVelocity = 0;
    }
    horizontalVelocity.multiplyScalar(0.96);
  } else if (verticalVelocity > 0 || playerPosition.y - eyeHeight > ground) {
    verticalVelocity -= 23 * delta;
    playerPosition.y += verticalVelocity * delta;
    if (playerPosition.y - eyeHeight <= ground) {
      playerPosition.y = ground + eyeHeight;
      verticalVelocity = 0;
      coyoteTimer = 0.12;
    }
  } else {
    playerPosition.y = ground + eyeHeight;
  }

  const nextFeet = playerPosition.y - eyeHeight;
  const playerRadius = 0.3;
  for (let chunkZ = Math.floor(playerPosition.z / CHUNK_SIZE) - 1; chunkZ <= Math.floor(playerPosition.z / CHUNK_SIZE) + 1; chunkZ += 1) {
    for (let chunkX = Math.floor(playerPosition.x / CHUNK_SIZE) - 1; chunkX <= Math.floor(playerPosition.x / CHUNK_SIZE) + 1; chunkX += 1) {
      const chunk = loadedChunks.get(chunkKey(chunkX, chunkZ));
      if (!chunk) continue;
      for (const obstacle of chunk.terrain.obstacles) {
        if (!obstacle.fullBlock
          || playerPosition.x + playerRadius <= obstacle.x - 0.5
          || playerPosition.x - playerRadius >= obstacle.x + 0.5
          || playerPosition.z + playerRadius <= obstacle.z - 0.5
          || playerPosition.z - playerRadius >= obstacle.z + 0.5) continue;
            if (verticalVelocity > 0 && previousFeet + playerHeight <= obstacle.bottom && nextFeet + playerHeight > obstacle.bottom) {
              playerPosition.y = obstacle.bottom - playerHeight + eyeHeight;
          verticalVelocity = 0;
        } else if (verticalVelocity < 0 && previousFeet >= obstacle.top && nextFeet < obstacle.top) {
          playerPosition.y = obstacle.top + eyeHeight;
          verticalVelocity = 0;
        }
      }
    }
  }

  const caveCeiling = chunkAt(playerPosition.x, playerPosition.z)?.terrain.caveCeilingAt(
    playerPosition.x,
    playerPosition.z,
    playerPosition.y - eyeHeight,
  );
  if (caveCeiling !== undefined && playerPosition.y - eyeHeight + playerHeight > caveCeiling) {
    playerPosition.y = caveCeiling - playerHeight + eyeHeight;
    if (verticalVelocity > 0) verticalVelocity = 0;
  }

  const horizontalSpeed = Math.hypot(horizontalVelocity.x, horizontalVelocity.z);
  if (horizontalSpeed > 0.15) {
    walkPhase += delta * horizontalSpeed * Math.PI;
    viewArm.position.y = Math.sin(walkPhase) * Math.min(0.045, horizontalSpeed * 0.004);
    viewArm.rotation.z = Math.sin(walkPhase) * 0.045;
    playerWalkBob = Math.abs(Math.sin(walkPhase * 2)) * Math.min(0.045, horizontalSpeed * 0.004);
    const limbSwing = Math.sin(walkPhase) * 0.65;
    if (playerAnimationJoints.leftArm) playerAnimationJoints.leftArm.rotation.x = limbSwing;
    if (playerAnimationJoints.rightArm) playerAnimationJoints.rightArm.rotation.x = -limbSwing;
    if (playerAnimationJoints.leftLeg) playerAnimationJoints.leftLeg.rotation.x = -limbSwing;
    if (playerAnimationJoints.rightLeg) playerAnimationJoints.rightLeg.rotation.x = limbSwing;
  } else {
    viewArm.position.y = THREE.MathUtils.damp(viewArm.position.y, 0, delta, 10);
    viewArm.rotation.z = THREE.MathUtils.damp(viewArm.rotation.z, 0, delta, 10);
    playerWalkBob = THREE.MathUtils.damp(playerWalkBob, 0, delta, 10);
    for (const joint of Object.values(playerAnimationJoints)) {
      if (joint) joint.rotation.x = THREE.MathUtils.damp(joint.rotation.x, 0, delta, 10);
    }
  }

  syncPovCamera();
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
  frameAccumulator += clock.getDelta();
  const frameInterval = gameSettings.maxFrameRate === 0 ? 0 : 1 / gameSettings.maxFrameRate;
  if (frameInterval > 0 && frameAccumulator < frameInterval) return;
  const delta = Math.min(frameAccumulator, 0.05);
  frameAccumulator = 0;
  if (lanSession) {
    lanSyncElapsed += delta;
    if (lanSyncElapsed >= 0.2) {
      lanSyncElapsed = 0;
      void synchronizeLanRoom();
    }
  }
  updateRemotePlayers(delta);
  refreshChunkStream();
  updatePigs(delta);
  if (pointerLock.isLocked || mobilePlaying) {
    updatePlayer(delta);
    autosaveElapsed += delta;
    if (autosaveElapsed >= 20) {
      saveCurrentWorld();
      autosaveElapsed = 0;
    }
  }
  updateSandBlocks(delta);
  renderer.render(scene, camera);
}

function setTouchKey(key: string, pressedState: boolean): void {
  if (pressedState) pressed.add(key);
  else pressed.delete(key);
}

function initializePigModel(): void {
  new OBJLoader().load(
    pigModelUrl,
    (model) => {
      const bounds = new THREE.Box3().setFromObject(model);
      const size = bounds.getSize(new THREE.Vector3());
      if (size.y <= 0 || !Number.isFinite(size.y)) {
        console.error('Pig OBJ has invalid dimensions.');
        showToast('Pig model has invalid dimensions');
        return;
      }

      const material = new THREE.MeshStandardMaterial({ color: '#d98e91', roughness: 1 });
      model.updateMatrixWorld(true);
      const legParts: Array<{ mesh: THREE.Mesh; bounds: THREE.Box3 }> = [];
      model.traverse((part) => {
        if (!(part instanceof THREE.Mesh)) return;
        part.material = material;
        part.castShadow = true;
        part.receiveShadow = true;
        const bounds = new THREE.Box3().setFromObject(part);
        const size = bounds.getSize(new THREE.Vector3());
        if (bounds.min.y >= -0.001 && bounds.max.y <= 0.4 && size.x <= 0.31 && size.z <= 0.31) {
          legParts.push({ mesh: part, bounds });
        }
      });
      for (const { mesh, bounds } of legParts) {
        const center = bounds.getCenter(new THREE.Vector3());
        const pivot = new THREE.Group();
        const end = center.z < 0 ? 'front' : 'back';
        const side = center.x < 0 ? 'left' : 'right';
        pivot.name = `pig-leg-${end}-${side}`;
        pivot.position.set(center.x, bounds.max.y, center.z);
        model.remove(mesh);
        mesh.position.sub(pivot.position);
        pivot.add(mesh);
        model.add(pivot);
      }
      model.scale.setScalar(0.9 / size.y);
      model.updateMatrixWorld(true);
      const scaledBounds = new THREE.Box3().setFromObject(model);
      model.position.set(
        -(scaledBounds.min.x + scaledBounds.max.x) / 2,
        -scaledBounds.min.y,
        -(scaledBounds.min.z + scaledBounds.max.z) / 2,
      );
      pigTemplate = model;
      for (const chunk of loadedChunks.values()) spawnPigsForChunk(chunk);
    },
    undefined,
    (error) => {
      console.error('Could not load the pig model.', error);
      showToast('Pig model failed to load');
    },
  );
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

function setLanStatus(message: string): void {
  document.querySelector('#lan-status')!.textContent = message;
}

function lanErrorMessage(error: unknown): string {
  if (error instanceof LanApiError) return error.message;
  if (error instanceof TypeError) {
    const isGitHubPages = location.hostname === 'github.io' || location.hostname.endsWith('.github.io');
    return isGitHubPages
      ? 'GitHub Pages cannot host LAN rooms. On the host PC run npm run lan, open http://localhost:5173, then start the world there. Joiners use the host’s printed network address.'
      : 'Cannot reach the LAN server. Make sure npm run lan is running and open the game from the host computer’s network address.';
  }
  return error instanceof Error ? error.message : 'Unknown LAN error';
}

async function hostLanWorld(): Promise<void> {
  if (lanSession) {
    document.querySelector('#pause-lan-status')!.textContent = `Already connected to LAN code ${lanSession.code}.`;
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('#pause-start-lan')!;
  button.disabled = true;
  document.querySelector('#pause-lan-status')!.textContent = 'Starting LAN world...';
  try {
    const response = await requestLan<{ code: string; playerId: string }>('/api/lan/host', {
      seed: currentSeed,
      name: activeWorldName,
      state: currentLanPlayerState(),
      edits: snapshotWorldEdits(),
    });
    lanSession = {
      code: response.code,
      playerId: response.playerId,
      role: 'host',
      seed: currentSeed,
      name: activeWorldName,
    };
    lastLanEditSequence = 0;
    pendingLanEdits.length = 0;
    document.querySelector<HTMLDivElement>('#lan-room-badge')!.textContent = `LAN CODE ${response.code}`;
    document.querySelector<HTMLDivElement>('#lan-room-badge')!.hidden = false;
    document.querySelector('#pause-lan-status')!.textContent =
      `LAN is open. Share code ${response.code} with players on your Wi-Fi. Choose Back to Game to continue.`;
    if (!worldInitialized) generateWorld(currentSeed);
  } catch (error) {
    const message = lanErrorMessage(error);
    document.querySelector('#pause-lan-status')!.textContent = `Could not start LAN: ${message}`;
  } finally {
    button.disabled = false;
  }
}

async function joinLanWorld(): Promise<void> {
  if (lanSession) {
    setLanStatus(`Already connected to LAN code ${lanSession.code}.`);
    return;
  }
  const codeInput = document.querySelector<HTMLInputElement>('#lan-code-input')!;
  const code = codeInput.value.trim();
  if (!/^\d{4}$/.test(code)) {
    setLanStatus('Enter the four-digit code shown by the host.');
    codeInput.focus();
    return;
  }
  const button = document.querySelector<HTMLButtonElement>('#join-lan-world')!;
  button.disabled = true;
  setLanStatus('Connecting to LAN world...');
  const loading = document.querySelector<HTMLDivElement>('#world-loading')!;
  loading.hidden = false;
  document.querySelector('#world-loading-label')!.textContent = 'Connecting to LAN world...';
  try {
    if (activeWorldId && worldInitialized && !saveCurrentWorld()) return;
    lanJoinInProgress = true;
    startPlaying();
    const response = await requestLan<{
      playerId: string;
      seed: string;
      name: string;
      hostState?: LanPlayerState;
    }>('/api/lan/join', { code });
    activeWorldId = undefined;
    activeWorldName = response.name;
    const hostState = response.hostState;
    const spawn = hostState
      ? {
          position: [hostState.x + 2, hostState.y, hostState.z + 2] as [number, number, number],
          rotation: [hostState.pitch, hostState.yaw] as [number, number],
        }
      : undefined;
    lanSession = {
      code,
      playerId: response.playerId,
      role: 'guest',
      seed: response.seed,
      name: response.name,
    };
    lastLanEditSequence = 0;
    pendingLanEdits.length = 0;
    clearRemotePlayers();
    document.querySelector('#world-loading-label')!.textContent = `Joining ${response.name}...`;
    await new Promise<void>((resolveFrame) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolveFrame()));
    });
    generateWorld(response.seed, true, spawn);
    document.querySelector<HTMLDivElement>('#lan-room-badge')!.textContent = `LAN CODE ${code}`;
    document.querySelector<HTMLDivElement>('#lan-room-badge')!.hidden = false;
    lanJoinInProgress = false;
    setMenu(!pointerLock.isLocked && !mobilePlaying);
  } catch (error) {
    console.error('Could not join the LAN world.', error);
    const message = lanErrorMessage(error);
    setLanStatus(`Could not join: ${message}`);
    document.querySelector<HTMLDivElement>('#lan-room-badge')!.hidden = true;
    const joinedSession = lanSession;
    lanSession = undefined;
    clearRemotePlayers();
    if (joinedSession) {
      void requestLan('/api/lan/leave', { code: joinedSession.code, playerId: joinedSession.playerId }).catch((leaveError: unknown) => {
        console.error('Could not leave the failed LAN join.', leaveError);
      });
    }
    lanJoinInProgress = false;
    mobilePlaying = false;
    pressed.clear();
    requestedMenuScreen = 'multiplayer';
    if (pointerLock.isLocked) pointerLock.unlock();
    else setMenu(true);
  } finally {
    loading.hidden = true;
    button.disabled = false;
  }
}

document.querySelector('#open-worlds')!.addEventListener('click', () => {
  renderSavedWorlds();
  showMenuScreen('worlds');
});
document.querySelector('#title-options')!.addEventListener('click', showOptions);
document.querySelector('#pause-options')!.addEventListener('click', showOptions);
document.querySelector('#multiplayer-notice')!.addEventListener('click', () => showMenuScreen('multiplayer'));
document.querySelector('#pause-start-lan')!.addEventListener('click', () => { void hostLanWorld(); });
document.querySelector('#join-lan-world')!.addEventListener('click', () => { void joinLanWorld(); });
document.querySelector<HTMLInputElement>('#lan-code-input')!.addEventListener('input', (event) => {
  const input = event.currentTarget as HTMLInputElement;
  input.value = input.value.replace(/\D/g, '').slice(0, 4);
});
document.querySelector<HTMLInputElement>('#lan-code-input')!.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void joinLanWorld();
});
document.querySelector('#quit-game')!.addEventListener('click', () => showToast('You can close this browser tab to quit'));
document.querySelector('#make-world-open')!.addEventListener('click', () => {
  (document.querySelector<HTMLInputElement>('#custom-seed-input')!).value = randomSeed();
  (document.querySelector<HTMLInputElement>('#world-name-input')!).value = 'New World';
  showMenuScreen('create-world');
});
document.querySelector('#create-world-button')!.addEventListener('click', createNewWorld);
document.querySelector<HTMLInputElement>('#custom-seed-input')!.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') createNewWorld();
});
document.querySelector<HTMLInputElement>('#world-name-input')!.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') createNewWorld();
});
document.querySelector('#randomize-seed')!.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  (document.querySelector<HTMLInputElement>('#custom-seed-input')!).value = randomSeed();
});
document.querySelectorAll<HTMLButtonElement>('[data-menu-back]').forEach((button) => {
  button.addEventListener('click', () => showMenuScreen(button.dataset.menuBack as MenuScreen));
});
document.querySelector('#saved-world-list')!.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-world-action]');
  if (!button) return;
  const world = savedWorlds.find((entry) => entry.id === button.dataset.worldId);
  if (!world) return;
  if (button.dataset.worldAction === 'delete') {
    if (!window.confirm(`Delete "${world.name}"? This cannot be undone.`)) return;
    savedWorlds = savedWorlds.filter((entry) => entry.id !== world.id);
    try {
      localStorage.setItem(SAVED_WORLDS_KEY, JSON.stringify(savedWorlds));
      renderSavedWorlds();
      showToast('World deleted');
    } catch (error) {
      console.error('Could not delete the saved world.', error);
      loadSavedWorlds();
      renderSavedWorlds();
      showToast('World could not be deleted');
    }
    return;
  }
  if (activeWorldId && activeWorldId !== world.id) saveCurrentWorld();
  const loading = document.querySelector<HTMLDivElement>('#world-loading')!;
  loading.hidden = false;
  document.querySelector('#world-loading-label')!.textContent = `Loading ${world.name}...`;
  startPlaying();
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      try {
        restoreSavedWorld(world);
        if (!loadedChunks.has(chunkKey(Math.floor(playerPosition.x / CHUNK_SIZE), Math.floor(playerPosition.z / CHUNK_SIZE)))) {
          throw new Error('The spawn chunk was not generated.');
        }
        if (!pointerLock.isLocked && !mobilePlaying) showMenuScreen('pause');
      } catch (error) {
        console.error(`Could not load world "${world.name}".`, error);
        showToast('World could not be loaded');
        mobilePlaying = false;
        if (pointerLock.isLocked) {
          requestedMenuScreen = 'worlds';
          pointerLock.unlock();
        } else {
          requestedMenuScreen = 'worlds';
          setMenu(true);
        }
      } finally {
        loading.hidden = true;
      }
    });
  });
});
document.querySelector('#resume-world')!.addEventListener('click', startPlaying);
document.querySelector('#save-quit-world')!.addEventListener('click', quitToTitle);
document.querySelector('#options-done')!.addEventListener('click', () => showMenuScreen(optionsReturnScreen));
document.querySelector('#video-tab')!.addEventListener('click', () => setOptionsTab('video'));
document.querySelector('#controls-tab')!.addEventListener('click', () => setOptionsTab('controls'));
document.querySelector<HTMLButtonElement>('#video-tab')!.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') setOptionsTab('controls');
});
document.querySelector<HTMLButtonElement>('#controls-tab')!.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowLeft') setOptionsTab('video');
});
document.querySelector('#pause-game-button')!.addEventListener('click', pauseWorld);
document.querySelector('#fullscreen-toggle')!.addEventListener('click', () => {
  const fullscreen = document.fullscreenElement ? document.exitFullscreen() : sceneRoot.requestFullscreen();
  void fullscreen.catch((error: unknown) => {
    console.error('Could not change fullscreen mode.', error);
    showToast('Fullscreen is unavailable in this browser');
  });
});
document.addEventListener('fullscreenchange', syncFullscreenButton);
document.querySelector('#max-framerate-toggle')!.addEventListener('click', () => {
  gameSettings.maxFrameRate = gameSettings.maxFrameRate === 0 ? 60 : gameSettings.maxFrameRate === 60 ? 30 : 0;
  syncSettingsInputs();
  saveGameSettings();
});
document.querySelector<HTMLButtonElement>('#shadows-toggle')!.addEventListener('click', () => {
  gameSettings.shadows = !gameSettings.shadows;
  applyGameSettings();
  syncSettingsInputs();
  saveGameSettings();
});
document.querySelector('#music-toggle')!.addEventListener('click', () => {
  void toggleAmbientMusic().catch((error: unknown) => {
    console.error('Could not start ambient music.', error);
    showToast('Audio is unavailable in this browser');
  });
});
document.querySelector('#pov-toggle')!.addEventListener('click', () => {
  if (!touchControlsAvailable) cyclePov();
});
bindInventoryDragging();
const settingsInputs = [
  '#render-distance-slider', '#quality-slider', '#brightness-slider', '#mouse-sensitivity',
  '#mobile-sensitivity', '#joystick-size', '#touch-opacity',
];
settingsInputs.forEach((selector) => {
  document.querySelector<HTMLInputElement>(selector)!.addEventListener('input', () => {
    gameSettings.renderDistance = Number(document.querySelector<HTMLInputElement>('#render-distance-slider')!.value);
    gameSettings.resolutionQuality = Number(document.querySelector<HTMLInputElement>('#quality-slider')!.value) / 100;
    gameSettings.brightness = Number(document.querySelector<HTMLInputElement>('#brightness-slider')!.value) / 100;
    gameSettings.mouseSensitivity = Number(document.querySelector<HTMLInputElement>('#mouse-sensitivity')!.value) / 100;
    gameSettings.mobileSensitivity = Number(document.querySelector<HTMLInputElement>('#mobile-sensitivity')!.value) / 100;
    gameSettings.joystickSize = Number(document.querySelector<HTMLInputElement>('#joystick-size')!.value);
    gameSettings.touchOpacity = Number(document.querySelector<HTMLInputElement>('#touch-opacity')!.value) / 100;
    document.querySelector('#quality-label')!.textContent = `${Math.round(gameSettings.resolutionQuality * 100)}%`;
    document.querySelector('#brightness-label')!.textContent = `${Math.round(gameSettings.brightness * 100)}%`;
    document.querySelector('#mouse-sensitivity-label')!.textContent = `${Math.round(gameSettings.mouseSensitivity * 100)}%`;
    document.querySelector('#mobile-sensitivity-label')!.textContent = `${Math.round(gameSettings.mobileSensitivity * 100)}%`;
    document.querySelector('#joystick-size-label')!.textContent = `${gameSettings.joystickSize} px`;
    document.querySelector('#touch-opacity-label')!.textContent = `${Math.round(gameSettings.touchOpacity * 100)}%`;
    applyGameSettings();
    saveGameSettings();
  });
});
document.querySelector('#render-distance-slider')!.addEventListener('change', () => {
  refreshChunkStream(true);
});
document.querySelector('#hotbar')!.addEventListener('click', (event) => {
  const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
  if (slot) handleInventorySlotClick(Number(slot.dataset.inventorySlot));
});
document.querySelector('#inventory-panel')!.addEventListener('click', (event) => {
  const slot = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-inventory-slot]');
  if (slot) handleInventorySlotClick(Number(slot.dataset.inventorySlot));
});
document.querySelector('#touch-inventory')!.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (mobilePlaying) toggleInventory();
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
  camera.rotation.y -= deltaX * 0.004 * gameSettings.mobileSensitivity;
  camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - deltaY * 0.004 * gameSettings.mobileSensitivity, -Math.PI / 2 + 0.04, Math.PI / 2 - 0.04);
});
const releaseLook = (): void => { lookPointerId = -1; };
lookZone.addEventListener('pointerup', releaseLook);
lookZone.addEventListener('pointercancel', releaseLook);
lookZone.addEventListener('lostpointercapture', releaseLook);

bindTouchHold('#touch-jump', ' ', () => { jumpBufferTimer = 0.16; });
bindTouchHold('#touch-break', 'break', () => { breakHeld = !attackPig(); }, () => { breakHeld = false; });
bindTouchHold('#touch-sprint', 'shift');
bindTouchHold('#touch-place', 'place', placeSelectedBlock);
document.querySelector('#touch-pause')!.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!mobilePlaying) return;
  mobilePlaying = false;
  pressed.clear();
  breakHeld = false;
  setMenu(true);
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
window.addEventListener('pagehide', () => {
  if (activeWorldId && worldInitialized) saveCurrentWorld();
  if (lanSession) {
    const payload = new Blob([JSON.stringify({ code: lanSession.code, playerId: lanSession.playerId })], { type: 'application/json' });
    navigator.sendBeacon('/api/lan/leave', payload);
  }
});
document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.target instanceof HTMLInputElement) return;
  if ((pointerLock.isLocked || mobilePlaying) && key === 'e') {
    event.preventDefault();
    toggleInventory();
    return;
  }
  if ((pointerLock.isLocked || mobilePlaying) && /^[1-9]$/.test(key)) {
    selectedHotbarSlot = Number(key) - 1;
    renderInventory();
    event.preventDefault();
    return;
  }
  if (key === 'escape' && !(document.querySelector('#inventory-panel') as HTMLDivElement).hidden) {
    toggleInventory(false);
    event.preventDefault();
    return;
  }
  if (key === 'escape' && pointerLock.isLocked) {
    pointerLock.unlock();
    return;
  }
  if (key === 'f5' && pointerLock.isLocked && !event.repeat) {
    cyclePov();
    event.preventDefault();
    return;
  }
  if (!pointerLock.isLocked) return;
  if (['w', 'a', 's', 'd', ' ', 'shift', 'control'].includes(key)) {
    pressed.add(key);
    if (key === ' ' && !event.repeat) jumpBufferTimer = 0.16;
    event.preventDefault();
  }
});
document.addEventListener('keyup', (event) => pressed.delete(event.key.toLowerCase()));
document.addEventListener('mousedown', (event) => {
  if (event.button === 2 && (pointerLock.isLocked || mobilePlaying)) {
    placeSelectedBlock();
    event.preventDefault();
    return;
  }
  if (event.button === 0 && (pointerLock.isLocked || mobilePlaying)) {
    breakHeld = !attackPig();
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
  loadGameSettings();
  loadSavedWorlds();
  renderInventory();
  initializePigModel();
  generateWorld();
  animate();
} catch (error) {
  console.error(error);
  document.querySelector('#scene-error')!.removeAttribute('hidden');
}