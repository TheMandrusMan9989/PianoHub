const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const rooms = new Map();

function send(ws, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, except) {
  for (const client of room.clients) if (client !== except) send(client, data);
}
function cleanText(value, max) {
  return String(value || '').trim().slice(0, max);
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

const MAX_SF2_SIZE = 48 * 1024 * 1024;
const wss = new WebSocketServer({ server, maxPayload: MAX_SF2_SIZE + 1024 });
wss.on('connection', ws => {
  ws.roomCode = null;
  ws.player = null;
  ws.pendingSf2 = null;
  ws.on('message', (raw, isBinary) => {
    const currentRoom = rooms.get(ws.roomCode);
    if (isBinary) {
      if (!currentRoom || !ws.player || !ws.pendingSf2) return;
      const buffer = Buffer.from(raw);
      const pending = ws.pendingSf2;
      ws.pendingSf2 = null;
      if (buffer.length !== pending.size || buffer.length < 12 || buffer.length > MAX_SF2_SIZE || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'sfbk') {
        return send(ws, { type: 'error', message: 'That file does not look like a valid SF2 soundfont.' });
      }
      currentRoom.sf2Buffer = buffer;
      currentRoom.sf2Info = { name: pending.name, size: buffer.length, by: ws.player.name };
      broadcast(currentRoom, { type: 'sf2-info', info: currentRoom.sf2Info });
      for (const client of currentRoom.clients) { if (client.readyState === client.OPEN) client.send(buffer, { binary: true }); }
      return;
    }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'create') {
      const name = cleanText(msg.name, 20) || 'Pianist';
      const roomName = cleanText(msg.roomName, 32) || 'Piano Jam';
      let code;
      do { code = makeCode(); } while (rooms.has(code));
      const room = { code, name: roomName, clients: new Set(), players: new Map(), sf2Buffer: null, sf2Info: null };
      rooms.set(code, room);
      joinRoom(ws, room, name, msg.playerId, msg.color);
      return;
    }

    if (msg.type === 'join') {
      const code = cleanText(msg.code, 6).toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(ws, { type:'error', message:'That room code does not exist.' });
      joinRoom(ws, room, cleanText(msg.name, 20) || 'Pianist', msg.playerId, msg.color);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room || !ws.player) return;
    if (msg.type === 'sf2-upload-start') {
      const name = cleanText(msg.name, 100) || 'Custom soundfont.sf2';
      const size = Number(msg.size);
      if (!name.toLowerCase().endsWith('.sf2') || !Number.isFinite(size) || size < 12 || size > MAX_SF2_SIZE) {
        return send(ws, { type: 'error', message: 'Choose an SF2 file smaller than 48 MB.' });
      }
      ws.pendingSf2 = { name, size };
      return;
    }
    if (msg.type === 'note-on' || msg.type === 'note-off') {
      const note = Math.max(0, Math.min(127, Number(msg.note) || 0));
      broadcast(room, { type:msg.type, note, player:ws.player }, ws);
    } else if (msg.type === 'chat') {
      const text = cleanText(msg.text, 240);
      if (text) broadcast(room, { type:'chat', text, player:ws.player }, ws);
    } else if (msg.type === 'ping') {
      send(ws, { type:'pong' });
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || !ws.player) return;
    room.clients.delete(ws);
    room.players.delete(ws.player.id);
    broadcast(room, { type:'leave', playerId:ws.player.id });
    if (room.clients.size === 0) rooms.delete(room.code);
  });
});

function joinRoom(ws, room, name, id, color) {
  if (ws.roomCode) {
    const old = rooms.get(ws.roomCode);
    if (old) { old.clients.delete(ws); if (ws.player) old.players.delete(ws.player.id); }
  }
  const player = {
    id: cleanText(id, 40) || Math.random().toString(36).slice(2),
    name,
    color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#a78bfa'
  };
  ws.roomCode = room.code;
  ws.player = player;
  room.clients.add(ws);
  room.players.set(player.id, player);
  send(ws, { type:'joined', room:{ code:room.code, name:room.name }, players:[...room.players.values()] });
  broadcast(room, { type:'join', player }, ws);
  if (room.sf2Buffer && room.sf2Info) {
    send(ws, { type: 'sf2-info', info: room.sf2Info });
    ws.send(room.sf2Buffer, { binary: true });
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PianoHub running at http://localhost:${PORT}`);
});
