import { createReadStream, existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');
const port = Number(process.env.PORT ?? 5173);
const rooms = new Map();
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.obj', 'text/plain; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function respondJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request, maxBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 });
  }
}

function cleanRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    for (const [id, player] of room.players) {
      if (id !== room.hostId && now - player.lastSeen > 15_000) room.players.delete(id);
    }
    if (!room.players.has(room.hostId) || now - room.players.get(room.hostId).lastSeen > 15_000) {
      rooms.delete(code);
    }
  }
}

function validState(state) {
  return state && ['x', 'y', 'z', 'yaw', 'pitch'].every((key) =>
    typeof state[key] === 'number' && Number.isFinite(state[key]));
}

function normalizeEdit(edit) {
  if (!edit || typeof edit !== 'object'
    || typeof edit.id !== 'string' || edit.id.length > 96
    || !Number.isInteger(edit.chunkX) || !Number.isInteger(edit.chunkZ)
    || !['terrain', 'tree', 'foliage', 'sand', 'place', 'break-placed'].includes(edit.kind)) return undefined;
  const clean = {
    id: edit.id,
    kind: edit.kind,
    chunkX: edit.chunkX,
    chunkZ: edit.chunkZ,
  };
  if (edit.kind === 'place') {
    const block = edit.block;
    if (!block || !['grass', 'dirt', 'stone', 'sand', 'wood', 'leaves'].includes(block.item)
      || ![block.x, block.y, block.z].every(Number.isFinite)) return undefined;
    return { ...clean, block: { x: block.x, y: block.y, z: block.z, item: block.item } };
  }
  if (typeof edit.key !== 'string' || edit.key.length > 512) return undefined;
  if (edit.kind === 'terrain' && (!Number.isInteger(edit.count) || edit.count < 1 || edit.count > 128)) return undefined;
  return { ...clean, key: edit.key, ...(edit.kind === 'terrain' ? { count: edit.count } : {}) };
}

function addEdit(room, playerId, rawEdit) {
  const edit = normalizeEdit(rawEdit);
  if (!edit || room.editIds.has(edit.id)) return false;
  room.editIds.add(edit.id);
  room.edits.push({ ...edit, sequence: room.nextSequence++, playerId });
  if (room.edits.length > 20_000) {
    const removed = room.edits.splice(0, room.edits.length - 20_000);
    for (const oldEdit of removed) room.editIds.delete(oldEdit.id);
  }
  return true;
}

function getRoom(code) {
  return typeof code === 'string' && /^\d{4}$/.test(code) ? rooms.get(code) : undefined;
}

async function handleApi(request, response, url) {
  cleanRooms();
  if (request.method === 'GET' && url.pathname === '/api/lan/health') {
    respondJson(response, 200, { ready: true });
    return;
  }
  if (request.method !== 'POST') {
    respondJson(response, 405, { error: 'Method not allowed.' });
    return;
  }
  const body = await readJson(request, url.pathname === '/api/lan/host' ? 5_000_000 : 1_000_000);

  if (url.pathname === '/api/lan/host') {
    if (typeof body.seed !== 'string' || !/^\d{1,16}$/.test(body.seed)
      || typeof body.name !== 'string' || !body.name.trim() || !validState(body.state)
      || !Array.isArray(body.edits) || body.edits.length > 10_000) {
      respondJson(response, 400, { error: 'Invalid host world details.' });
      return;
    }
    let code;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      code = String(randomInt(0, 10_000)).padStart(4, '0');
      if (!rooms.has(code)) break;
    }
    if (!code || rooms.has(code)) {
      respondJson(response, 503, { error: 'Could not reserve a room code. Try again.' });
      return;
    }
    const playerId = randomUUID();
    const room = {
      code,
      seed: body.seed,
      name: body.name.trim().slice(0, 32),
      hostId: playerId,
      players: new Map([[playerId, { name: 'Host', state: body.state, lastSeen: Date.now() }]]),
      edits: [],
      editIds: new Set(),
      nextSequence: 1,
    };
    for (const edit of body.edits) addEdit(room, playerId, edit);
    rooms.set(code, room);
    respondJson(response, 201, { code, playerId });
    return;
  }

  if (url.pathname === '/api/lan/join') {
    const room = getRoom(body.code);
    if (!room) {
      respondJson(response, 404, { error: 'Room code was not found.' });
      return;
    }
    if (room.players.size >= 8) {
      respondJson(response, 409, { error: 'This LAN world is full (maximum eight players).' });
      return;
    }
    const playerId = randomUUID();
    room.players.set(playerId, { name: `Player ${room.players.size}`, state: undefined, lastSeen: Date.now() });
    respondJson(response, 201, {
      playerId,
      seed: room.seed,
      name: room.name,
      hostState: room.players.get(room.hostId)?.state,
    });
    return;
  }

  if (url.pathname === '/api/lan/sync') {
    const room = getRoom(body.code);
    if (!room) {
      respondJson(response, 404, { error: 'Room code was not found.' });
      return;
    }
    const player = room.players.get(body.playerId);
    if (!player) {
      respondJson(response, 404, { error: 'Player is no longer in this LAN world.' });
      return;
    }
    if (!validState(body.state) || !Number.isInteger(body.after) || body.after < 0
      || !Array.isArray(body.edits) || body.edits.length > 100) {
      respondJson(response, 400, { error: 'Invalid player update.' });
      return;
    }
    player.state = body.state;
    player.lastSeen = Date.now();
    for (const edit of body.edits) addEdit(room, body.playerId, edit);
    const players = [...room.players].map(([id, entry]) => ({ id, name: entry.name, state: entry.state }));
    const edits = room.edits.filter((edit) => edit.sequence > body.after);
    respondJson(response, 200, { players, edits });
    return;
  }

  if (url.pathname === '/api/lan/leave') {
    const room = getRoom(body.code);
    if (room?.players.has(body.playerId)) {
      if (body.playerId === room.hostId) rooms.delete(room.code);
      else room.players.delete(body.playerId);
    }
    respondJson(response, 200, { left: true });
    return;
  }
  respondJson(response, 404, { error: 'Unknown LAN endpoint.' });
}

function serveStatic(request, response, url) {
  if (!existsSync(dist)) {
    respondJson(response, 503, { error: 'Built game not found. Run npm run build first.' });
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    respondJson(response, 400, { error: 'Malformed URL.' });
    return;
  }
  const requestedPath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(dist, requestedPath);
  const relativePath = path.relative(dist, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    respondJson(response, 403, { error: 'Forbidden.' });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(path.extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname.startsWith('/api/lan/')) {
    void handleApi(request, response, url).catch((error) => {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status === 500) console.error('LAN API request failed.', error);
      if (!response.headersSent) respondJson(response, status, { error: error instanceof Error ? error.message : 'LAN server error.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405);
    response.end('Method not allowed');
    return;
  }
  serveStatic(request, response, url);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`LAN server ready at http://localhost:${port}`);
  const addresses = Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).filter((entry) => entry.family === 'IPv4' && !entry.internal).map((entry) => entry.address));
  for (const address of addresses) console.log(`LAN players can open http://${address}:${port}`);
  if (addresses.length === 0) console.log('No LAN IPv4 address was detected; connect devices to the same network and check firewall access.');
});
