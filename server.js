const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();
const connectedClients = new Set();
const MAX_SF2_SIZE = 48 * 1024 * 1024;

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, except) {
  for (const client of room.clients) if (client !== except) send(client, data);
}
function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
}
function publishPublicRooms() {
  const publicRooms = [...rooms.values()]
    .filter(room => room.isPublic && room.clients.size > 0)
    .map(room => ({ code:room.code, name:room.name, playerCount:room.clients.size }));
  const message = { type:'public-rooms', rooms:publicRooms };
  for (const client of connectedClients) send(client, message);
}
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(ROOT, requested);
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control':'no-store' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: MAX_SF2_SIZE + 1024 });
wss.on('connection', ws => {
  connectedClients.add(ws);
  send(ws, { type:'public-rooms', rooms:[...rooms.values()].filter(room => room.isPublic && room.clients.size > 0).map(room => ({ code:room.code, name:room.name, playerCount:room.clients.size })) });
  ws.roomCode = null;
  ws.player = null;
  ws.on('message', (raw, isBinary) => {
    const currentRoom = rooms.get(ws.roomCode);
    // SF2 packets are binary: 4-byte big-endian JSON-header length, JSON metadata, then SF2 bytes.
    // Keep each player's uploaded banks in room memory and only forward the bank they select.
    if (isBinary) {
      if (!currentRoom || !ws.player) return;
      try {
        const packet = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (packet.length < 16 || packet.length > MAX_SF2_SIZE + 1024) return;
        const headerLength = packet.readUInt32BE(0);
        if (headerLength < 2 || headerLength > 2048 || 4 + headerLength >= packet.length) return;
        const meta = JSON.parse(packet.toString('utf8', 4, 4 + headerLength));
        if (meta.type !== 'soundfont' || String(meta.playerId) !== ws.player.id) return;
        const id = cleanText(meta.soundfontId, 100);
        const name = cleanText(meta.name, 120) || 'SoundFont.sf2';
        const payloadOffset = 4 + headerLength;
        // A valid SF2 is a RIFF container with the form type "sfbk".
        if (!id || packet.toString('ascii', payloadOffset, payloadOffset + 4) !== 'RIFF' || packet.toString('ascii', payloadOffset + 8, payloadOffset + 12) !== 'sfbk') return;
        const ownerFiles = currentRoom.soundfonts.get(ws.player.id) || new Map();
        const existingBytes = [...ownerFiles.values()].reduce((sum, entry) => sum + entry.size, 0);
        const old = ownerFiles.get(id);
        const newTotal = existingBytes - (old?.size || 0) + (packet.length - 4 - headerLength);
        if (newTotal > 128 * 1024 * 1024) {
          send(ws, { type:'error', message:'Your room soundfont uploads exceed the 128 MB per-player limit. Remove an SF2 and try again.' });
          return;
        }
        ownerFiles.set(id, { name, packet, size:packet.length - 4 - headerLength });
        currentRoom.soundfonts.set(ws.player.id, ownerFiles);
      } catch (error) {
        console.error('Rejected invalid SF2 upload:', error.message);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'list-public') { publishPublicRooms(); return; }

    if (msg.type === 'create') {
      const name = cleanText(msg.name, 20) || 'Pianist';
      const roomName = cleanText(msg.roomName, 32) || 'Piano Jam';
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = { code, name: roomName, isPublic: msg.visibility === 'public', clients: new Set(), players: new Map(), soundfonts: new Map() };
      rooms.set(code, room);
      joinRoom(ws, room, name, msg.playerId, msg.color);
      publishPublicRooms();
      return;
    }

    if (msg.type === 'join') {
      const code = cleanText(msg.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type:'error', message:'That room code does not exist.' });
      joinRoom(ws, room, cleanText(msg.name, 20) || 'Pianist', msg.playerId, msg.color);
      publishPublicRooms();
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room || !ws.player) return;
    if (msg.type === 'note-on' || msg.type === 'note-off') {
      const note = Math.max(0, Math.min(127, Number(msg.note) || 0));
      broadcast(room, { type:msg.type, note, player:ws.player }, ws);
    } else if (msg.type === 'chat') {
      const text = cleanText(msg.text, 240);
      if (text) broadcast(room, { type:'chat', text, player:ws.player }, ws);
    } else if (msg.type === 'soundfont-select') {
      const id = cleanText(msg.soundfontId, 100);
      const files = room.soundfonts.get(ws.player.id);
      if (!id) {
        ws.player.soundfontId = '';
        broadcast(room, { type:'soundfont-select', playerId:ws.player.id, soundfontId:'' }, ws);
      } else if (files && files.has(id)) {
        ws.player.soundfontId = id;
        const entry = files.get(id);
        broadcast(room, { type:'soundfont-select', playerId:ws.player.id, soundfontId:id }, ws);
        for (const client of room.clients) if (client !== ws && client.readyState === client.OPEN) client.send(entry.packet);
      }
    } else if (msg.type === 'ping') {
      send(ws, { type:'pong' });
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.player) return;
    room.clients.delete(ws);
    room.players.delete(ws.player.id);
    room.soundfonts.delete(ws.player.id);
    broadcast(room, { type:'leave', playerId:ws.player.id });
    if (room.clients.size === 0) rooms.delete(room.code);
    publishPublicRooms();
  });
});

function joinRoom(ws, room, name, id, color) {
  if (ws.roomCode) {
    const old = rooms.get(ws.roomCode);
    if (old) { old.clients.delete(ws); if (ws.player) { old.players.delete(ws.player.id); old.soundfonts.delete(ws.player.id); } if (old.clients.size === 0) rooms.delete(old.code); }
  }
  const player = {
    id: cleanText(id, 40) || Math.random().toString(36).slice(2),
    name,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#a78bfa',
    soundfontId: ''
  };
  ws.roomCode = room.code;
  ws.player = player;
  room.clients.add(ws);
  room.players.set(player.id, player);
  send(ws, { type:'joined', room:{ code:room.code, name:room.name }, players:[...room.players.values()] });
  broadcast(room, { type:'join', player }, ws);
  // A newcomer receives the currently selected instrument for every existing player.
  for (const existing of room.players.values()) {
    if (existing.id === player.id) continue;
    send(ws, { type:'soundfont-select', playerId:existing.id, soundfontId:existing.soundfontId || '' });
    if (existing.soundfontId) {
      const entry = room.soundfonts.get(existing.id)?.get(existing.soundfontId);
      if (entry) ws.send(entry.packet);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PianoHub running at http://localhost:${PORT}`);
});
