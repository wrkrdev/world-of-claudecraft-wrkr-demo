// WRKR Scale load smoke: create N real accounts/characters, connect them over
// the public API + WebSocket path, move/chat briefly, then disconnect.
import WebSocket from 'ws';

const BASE = process.env.SERVER_URL ?? 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const PLAYERS = Math.max(1, Math.floor(Number(process.env.LOAD_PLAYERS ?? 25)));
const PASSWORD = process.env.LOAD_PASSWORD ?? 'hunter22';
const REGISTER_DELAY_MS = Math.max(0, Math.floor(Number(process.env.LOAD_REGISTER_DELAY_MS ?? 3200)));
const CONNECT_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 12_000;

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${extra ? ` ${extra}` : ''}`);
  }
}

async function api(path, opts = {}, token = null) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const DELTA_SELF_KEYS = ['inv', 'equip', 'qlog', 'qdone', 'cds', 'stats', 'weapon', 'party', 'trade', 'duel'];
function mergeSelf(prev, next) {
  if (prev) for (const k of DELTA_SELF_KEYS) if (!(k in next)) next[k] = prev[k];
  return next;
}

class Client {
  constructor(label) {
    this.label = label;
    this.pid = -1;
    this.self = null;
    this.events = [];
    this.snapshots = 0;
  }

  connect(token, characterId) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/ws`);
      const timeout = setTimeout(() => reject(new Error(`${this.label} connect timeout`)), CONNECT_TIMEOUT_MS);
      this.ws.on('open', () => this.send({ t: 'auth', token, character: characterId }));
      this.ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'hello') {
          this.pid = msg.pid;
          clearTimeout(timeout);
          resolve(msg);
        } else if (msg.t === 'snap') {
          this.snapshots++;
          this.self = mergeSelf(this.self, msg.self);
        } else if (msg.t === 'events') {
          this.events.push(...msg.list);
        } else if (msg.t === 'error') {
          clearTimeout(timeout);
          reject(new Error(`${this.label}: ${msg.error}`));
        }
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  send(obj) {
    this.ws?.send(JSON.stringify(obj));
  }

  input(mi, facing) {
    this.send({ t: 'input', mi, ...(facing !== undefined ? { facing } : {}) });
  }

  cmd(payload) {
    this.send({ t: 'cmd', ...payload });
  }

  close() {
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function alphaSuffix(value) {
  return String(value)
    .split('')
    .map((ch) => /[0-9]/.test(ch) ? 'abcdefghij'[Number(ch)] : ch)
    .join('')
    .replace(/[^a-z]/gi, '')
    .slice(-6)
    .padStart(6, 'a');
}

async function waitForSnapshots(clients) {
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (clients.every((c) => c.snapshots > 0 && c.self)) return true;
    await sleep(200);
  }
  return false;
}

async function main() {
  console.log(`WRKR load smoke against ${BASE} with ${PLAYERS} players`);
  if (REGISTER_DELAY_MS > 0 && PLAYERS > 1) {
    console.log(`Registration pacing: ${REGISTER_DELAY_MS}ms between users`);
  }
  const initialStatus = await api('/api/status');
  check('server status is healthy', initialStatus.status === 200 && initialStatus.body.ok);
  if (initialStatus.status !== 200 || !initialStatus.body.ok) {
    process.exit(1);
  }
  const onlineBefore = Number(initialStatus.body.players_online ?? 0);
  const maxPlayers = Number(initialStatus.body.max_players ?? 0);
  check('server reports player cap', maxPlayers >= PLAYERS, `max_players=${maxPlayers}`);
  if (maxPlayers > 0 && onlineBefore + PLAYERS > maxPlayers) {
    console.error(`fatal: server has ${onlineBefore} online; ${PLAYERS} more would exceed max_players=${maxPlayers}`);
    process.exit(1);
  }

  const uniq = alphaSuffix(Date.now().toString(36));
  const classes = ['warrior', 'mage', 'rogue', 'priest', 'hunter', 'paladin', 'shaman', 'warlock', 'druid'];
  const clients = [];

  for (let i = 0; i < PLAYERS; i++) {
    if (i > 0 && REGISTER_DELAY_MS > 0) await sleep(REGISTER_DELAY_MS);
    const username = `load_${uniq}_${i}`;
    const charName = `Load${alphaSuffix(`${uniq}${i}`).slice(0, 8)}`.slice(0, 16);
    const cls = classes[i % classes.length];
    const reg = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    check(`register ${username}`, reg.status === 200 && reg.body.token);
    if (reg.status !== 200 || !reg.body.token) continue;
    const char = await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify({ name: charName, class: cls }),
    }, reg.body.token);
    check(`create ${charName}`, char.status === 200 && char.body.id > 0);
    if (char.status !== 200 || !char.body.id) continue;
    clients.push({ client: new Client(charName), token: reg.body.token, characterId: char.body.id });
  }

  check('created requested load identities', clients.length === PLAYERS, `created=${clients.length}`);
  await Promise.all(clients.map((entry) => entry.client.connect(entry.token, entry.characterId)));
  check('all clients joined', clients.every((entry) => entry.client.pid > 0));

  const connected = clients.map((entry) => entry.client);
  check('all clients received first snapshot', await waitForSnapshots(connected));

  connected.forEach((client, i) => client.input({ f: 1 }, (i / Math.max(1, connected.length)) * Math.PI * 2));
  await sleep(1500);
  connected.forEach((client) => client.input({}));
  connected.forEach((client, i) => {
    if (i % 5 === 0) client.cmd({ cmd: 'chat', text: `Load smoke hello ${i}` });
  });
  await sleep(1000);

  const loadedStatus = await api('/api/status');
  check('status includes all load clients', loadedStatus.body.players_online >= onlineBefore + PLAYERS,
    `online=${loadedStatus.body.players_online}, expected>=${onlineBefore + PLAYERS}`);
  check('tick metric is numeric', typeof loadedStatus.body.tick_ms_avg === 'number');
  check('memory metric is numeric', typeof loadedStatus.body.rss_bytes === 'number');

  connected.forEach((client) => client.close());
  await sleep(1000);
  const finalStatus = await api('/api/status');
  check('clients disconnected cleanly', Number(finalStatus.body.players_online ?? 0) <= onlineBefore,
    `online=${finalStatus.body.players_online}, before=${onlineBefore}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
