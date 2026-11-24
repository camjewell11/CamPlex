// Plex Companion player: lets Plex apps and the Plex server find Marquee and control its player.
// HTTP (from port 32500) takes the playback, navigation, and timeline commands. GDM on UDP 32412
// answers discovery searches, and HELLO messages on 32413 announce the player.
const http = require('http');
const dgram = require('dgram');
const PLATFORM = process.platform === 'darwin' ? 'macOS' : 'Windows';

const GDM_GROUP = '239.0.0.250';
const GDM_SEARCH_PORT = 32412;
const GDM_HELLO_PORT = 32413;
const CAPABILITIES = 'timeline,playback,navigation,playqueues';
const CONTROLLABLE = 'playPause,stop,stepBack,stepForward,seekTo,skipNext,skipPrevious,volume';
// A subscriber that doesn't renew within this time is dropped (Plex apps renew every 30 seconds or so).
const SUBSCRIBER_TTL = 90 * 1000;
const POLL_HOLD = 20 * 1000;

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');

class Companion {
  // onCommand(kind, name, params) handles playback and navigation commands; kind is 'playback',
  // 'navigation', or 'mirror'. host is the address to bind (127.0.0.1 while testing from source).
  constructor({ clientId, name, version, host = '0.0.0.0', onCommand, log = () => {} }) {
    Object.assign(this, { clientId, name, version, host, onCommand, log });
    this.port = null;
    this.server = null;
    this.udp = null;
    this.helloTimer = null;
    this.pushTimer = null;
    this.subscribers = new Map(); // client id -> { url, commandID, seen }
    this.polls = new Set(); // held poll responses
    this.state = { state: 'stopped' };
    this.lastKey = '';
  }

  async start(firstPort = 32500) {
    if (this.server) return this.port;
    this.server = http.createServer((req, res) => this.handle(req, res));
    for (let p = firstPort; p < firstPort + 20; p++) {
      try {
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(p, this.host, () => {
            this.server.off('error', reject);
            resolve();
          });
        });
        this.port = p;
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    if (!this.port) throw new Error('No free port for the Plex Companion player.');
    this.startGdm();
    this.pushTimer = setInterval(() => this.tick(), 1000);
    this.log(`companion listening on ${this.host}:${this.port}`);
    return this.port;
  }

  async stop() {
    clearInterval(this.helloTimer);
    clearInterval(this.pushTimer);
    this.helloTimer = this.pushTimer = null;
    if (this.udp) {
      await this.sendGdm('BYE').catch(() => {});
      try {
        this.udp.close();
      } catch {}
      this.udp = null;
    }
    for (const p of this.polls) p.finish();
    this.polls.clear();
    this.subscribers.clear();
    if (this.server) {
      await new Promise((r) => this.server.close(() => r()));
      this.server.closeAllConnections?.();
      this.server = null;
    }
    this.port = null;
  }

  // ---------- GDM discovery ----------
  gdmHeaders() {
    return [
      'Content-Type: plex/media-player',
      `Resource-Identifier: ${this.clientId}`,
      `Name: ${this.name}`,
      `Port: ${this.port}`,
      'Product: Marquee',
      `Version: ${this.version}`,
      'Protocol: plex',
      'Protocol-Version: 1',
      `Protocol-Capabilities: ${CAPABILITIES}`,
      'Device-Class: pc',
    ].join('\r\n');
  }

  startGdm() {
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = udp;
    udp.on('error', (e) => this.log(`companion GDM error: ${e.message}`));
    udp.on('message', (msg, rinfo) => {
      if (!/^M-SEARCH \* HTTP\/1\.\d/.test(msg.toString())) return;
      const reply = Buffer.from(`HTTP/1.0 200 OK\r\n${this.gdmHeaders()}\r\n\r\n`);
      udp.send(reply, rinfo.port, rinfo.address);
    });
    const bindTo = this.host === '0.0.0.0' ? undefined : this.host;
    udp.bind(GDM_SEARCH_PORT, bindTo, () => {
      if (!bindTo) {
        try {
          udp.addMembership(GDM_GROUP);
        } catch (e) {
          this.log(`companion GDM multicast unavailable: ${e.message}`);
        }
      }
      this.sendGdm('HELLO');
      this.helloTimer = setInterval(() => this.sendGdm('HELLO'), 30 * 1000);
    });
  }

  sendGdm(verb) {
    const udp = this.udp;
    if (!udp) return Promise.resolve();
    const msg = Buffer.from(`${verb} * HTTP/1.0\r\n${this.gdmHeaders()}\r\n\r\n`);
    const targets = this.host === '0.0.0.0' ? [GDM_GROUP, '127.0.0.1'] : ['127.0.0.1'];
    return Promise.all(targets.map((t) => new Promise((r) => udp.send(msg, GDM_HELLO_PORT, t, () => r()))));
  }

  // ---------- player state from the renderer ----------
  // s: { state, time, duration, ratingKey, key, machineIdentifier, address, port, protocol,
  // playQueueID, playQueueItemID, volume } with times in milliseconds. state is 'stopped' when no
  // player is open.
  setState(s) {
    this.state = s && s.state ? s : { state: 'stopped' };
    const key = `${this.state.state}|${this.state.ratingKey}|${this.state.playQueueItemID}|${this.state.volume}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.notify();
    }
  }

  timelineXml(commandID) {
    const s = this.state;
    const active = s.state !== 'stopped';
    const video = active
      ? {
          type: 'video',
          state: s.state,
          time: Math.round(s.time || 0),
          duration: Math.round(s.duration || 0),
          seekRange: `0-${Math.round(s.duration || 0)}`,
          key: s.key,
          ratingKey: s.ratingKey,
          machineIdentifier: s.machineIdentifier,
          address: s.address,
          port: s.port,
          protocol: s.protocol,
          containerKey: s.playQueueID ? `/playQueues/${s.playQueueID}` : s.key,
          playQueueID: s.playQueueID,
          playQueueItemID: s.playQueueItemID,
          volume: s.volume ?? 100,
          controllable: CONTROLLABLE,
          mute: s.muted ? 1 : 0,
        }
      : { type: 'video', state: 'stopped' };
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer${attrs({ commandID, location: active ? 'fullScreenVideo' : 'navigation' })}>` +
      `<Timeline type="music" state="stopped"/><Timeline type="photo" state="stopped"/>` +
      `<Timeline${attrs(video)}/></MediaContainer>`
    );
  }

  // Send the timeline to subscribers and answer held polls.
  notify() {
    for (const p of this.polls) p.finish();
    this.polls.clear();
    this.push();
  }

  tick() {
    const now = Date.now();
    for (const [id, sub] of this.subscribers) if (now - sub.seen > SUBSCRIBER_TTL) this.subscribers.delete(id);
    if (this.state.state === 'playing') this.push();
  }

  push() {
    for (const [, sub] of this.subscribers) {
      const body = this.timelineXml(sub.commandID);
      const req = http.request(sub.url, {
        method: 'POST',
        timeout: 3000,
        headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(body), ...this.identityHeaders() },
      });
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end(body);
    }
  }

  identityHeaders() {
    return {
      'X-Plex-Client-Identifier': this.clientId,
      'X-Plex-Product': 'Marquee',
      'X-Plex-Version': this.version,
      'X-Plex-Device-Name': this.name,
      'X-Plex-Platform': PLATFORM,
      'X-Plex-Provides': 'player',
    };
  }

  // ---------- HTTP ----------
  send(res, status, body, type = 'text/xml') {
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'X-Plex-Client-Identifier',
      'Access-Control-Max-Age': '1209600',
      Connection: 'close',
      ...this.identityHeaders(),
    });
    res.end(body);
  }
  ok(res, code = 200, status = 'OK') {
    this.send(res, code, `<?xml version="1.0" encoding="UTF-8"?>\n<Response code="${code}" status="${esc(status)}"/>`);
  }

  handle(req, res) {
    if (req.method === 'OPTIONS') return this.send(res, 200, '');
    const u = new URL(req.url, 'http://localhost');
    const params = Object.fromEntries(u.searchParams);
    const header = (n) => req.headers[n.toLowerCase()] || params[n];
    const controller = header('X-Plex-Client-Identifier') || req.socket.remoteAddress;
    const path = u.pathname.replace(/\/+$/, '');
    // Keep each controller's latest commandID, so timelines answer with it.
    const sub = this.subscribers.get(controller);
    if (sub && params.commandID) sub.commandID = params.commandID;

    if (path === '/resources') {
      const player = {
        title: this.name,
        machineIdentifier: this.clientId,
        product: 'Marquee',
        version: this.version,
        platform: PLATFORM,
        platformVersion: process.getSystemVersion?.() || '',
        protocolVersion: 1,
        protocolCapabilities: CAPABILITIES,
        deviceClass: 'pc',
      };
      return this.send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer><Player${attrs(player)}/></MediaContainer>`);
    }

    if (path === '/player/timeline/subscribe') {
      const host = req.socket.remoteAddress?.replace(/^::ffff:/, '') || '127.0.0.1';
      const protocol = params.protocol === 'https' ? 'https' : 'http';
      const port = Number(params.port);
      if (!port) return this.ok(res, 400, 'port is required');
      // An https subscriber would need TLS; send timelines over http only.
      this.subscribers.set(controller, { url: `${protocol === 'https' ? 'http' : protocol}://${host.includes(':') ? `[${host}]` : host}:${port}/:/timeline`, commandID: params.commandID || 0, seen: Date.now() });
      this.ok(res);
      setTimeout(() => this.push(), 100);
      return;
    }
    if (path === '/player/timeline/unsubscribe') {
      this.subscribers.delete(controller);
      return this.ok(res);
    }
    if (path === '/player/timeline/poll') {
      if (sub) sub.seen = Date.now();
      const commandID = params.commandID || 0;
      if (params.wait !== '1') return this.send(res, 200, this.timelineXml(commandID));
      const p = {
        finish: () => {
          clearTimeout(p.timer);
          if (!res.writableEnded) this.send(res, 200, this.timelineXml(commandID));
        },
      };
      p.timer = setTimeout(() => {
        this.polls.delete(p);
        p.finish();
      }, POLL_HOLD);
      res.on('close', () => {
        clearTimeout(p.timer);
        this.polls.delete(p);
      });
      this.polls.add(p);
      return;
    }

    const m = /^\/player\/(playback|navigation|mirror)\/(\w+)$/.exec(path);
    if (m) {
      Promise.resolve(this.onCommand(m[1], m[2], params))
        .then((r) => (r === false ? this.ok(res, 400, 'Not supported') : this.ok(res)))
        .catch((e) => this.ok(res, 500, e.message));
      return;
    }
    this.ok(res, 404, 'Not found');
  }
}

module.exports = { Companion };
