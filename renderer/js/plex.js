// Thin Plex Media Server client. JSON goes through the main process; images and media load directly.
import { libraryName } from './util.js';
export class Plex {
  constructor({ uri, token, clientId, version }) {
    this.uri = uri.replace(/\/$/, '');
    this.token = token;
    this.clientId = clientId;
    this.version = version;
  }

  identity() {
    return {
      'X-Plex-Product': 'Marquee',
      'X-Plex-Version': this.version,
      'X-Plex-Client-Identifier': this.clientId,
      'X-Plex-Platform': 'Generic',
      'X-Plex-Device': 'Windows',
      'X-Plex-Device-Name': 'Marquee',
      'X-Plex-Token': this.token,
    };
  }

  url(path, params = {}) {
    // Identity first, then the request's own parameters, so a request can override X-Plex-Platform.
    const u = new URL(this.uri + path);
    for (const [k, v] of Object.entries(this.identity())) u.searchParams.set(k, v);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    return u.toString();
  }

  async request(path, params = {}, method = 'GET') {
    const r = await window.marquee.request(this.url(path, params), method);
    if (r.status >= 400) throw new Error(`Plex returned HTTP ${r.status} for ${path}`);
    if (!r.text || !r.text.trim().startsWith('{')) return {};
    return JSON.parse(r.text).MediaContainer || {};
  }
  post(path, params) {
    return this.request(path, params, 'POST');
  }
  del(path, params) {
    return this.request(path, params, 'DELETE');
  }

  get(path, params) {
    return this.request(path, params, 'GET');
  }
  put(path, params) {
    return this.request(path, params, 'PUT');
  }

  // Resized image through the server's photo transcoder. Works for local paths and external URLs.
  img(path, width, height, extra = {}) {
    if (!path) return '';
    return this.url('/photo/:/transcode', { url: path, width, height, minSize: 1, upscale: 1, ...extra });
  }

  // ---------- library ----------
  async sections() {
    const c = await this.get('/library/sections');
    return (c.Directory || [])
      .filter((d) => d.type === 'movie' || d.type === 'show')
      .map((d) => ({ ...d, title: libraryName(d.title) }));
  }
  // Music and audiobook libraries (Plex type "artist").
  async audioSections() {
    const c = await this.get('/library/sections');
    return (c.Directory || []).filter((d) => d.type === 'artist').map((d) => ({ ...d, title: libraryName(d.title) }));
  }
  async metadata(id, params = {}) {
    const c = await this.get(`/library/metadata/${id}`, params);
    return c.Metadata?.[0];
  }
  async collections(sectionId, start = 0, size = 60) {
    const c = await this.get(`/library/sections/${sectionId}/collections`, { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
    return { items: c.Metadata || [], total: c.totalSize ?? c.size ?? 0 };
  }
  async children(id) {
    const c = await this.get(`/library/metadata/${id}/children`);
    return c.Metadata || [];
  }
  async list(sectionId, params = {}, start = 0, size = 60) {
    const c = await this.get(`/library/sections/${sectionId}/all`, {
      ...params,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': size,
    });
    return { items: c.Metadata || [], total: c.totalSize ?? c.size ?? 0 };
  }
  async genres(sectionId) {
    const c = await this.get(`/library/sections/${sectionId}/genre`);
    return c.Directory || [];
  }
  async decades(sectionId) {
    const c = await this.get(`/library/sections/${sectionId}/decade`);
    return c.Directory || [];
  }
  async hubs() {
    const c = await this.get('/hubs', { count: 24 });
    return c.Hub || [];
  }
  async hubItems(key, size = 24) {
    const c = await this.get(key, { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': size, count: size });
    return c.Metadata || c.Hub?.[0]?.Metadata || [];
  }
  async continueWatching() {
    const c = await this.get('/hubs/continueWatching', { count: 24 });
    return c.Hub?.[0]?.Metadata || [];
  }
  async search(query) {
    const c = await this.get('/hubs/search', { query, limit: 30 });
    return (c.Hub || []).filter((h) => h.Metadata?.length && ['movie', 'show', 'episode'].includes(h.type));
  }
  async history(id) {
    const c = await this.get('/status/sessions/history/all', { metadataItemID: id, sort: 'viewedAt:desc' });
    return c.Metadata || [];
  }
  async accounts() {
    const c = await this.get('/accounts');
    return Object.fromEntries((c.Account || []).map((a) => [a.id, a.name]));
  }
  markWatched(ratingKey, watched) {
    return this.get(watched ? '/:/scrobble' : '/:/unscrobble', { key: ratingKey, identifier: 'com.plexapp.plugins.library' });
  }

  // ---------- plex.tv: watchlist and Discover ----------
  // These go through the main process, which adds the user's plex.tv token.
  async tv(path, params = {}, method = 'GET') {
    const u = new URL(DISCOVER + path);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    const r = await window.marquee.plexTv(u.toString(), method);
    if (r.status >= 400) throw new Error(`plex.tv returned HTTP ${r.status} for ${path}`);
    if (!r.text || !r.text.trim().startsWith('{')) return {};
    return JSON.parse(r.text).MediaContainer || {};
  }
  async watchlist(start = 0, size = 60) {
    const c = await this.tv('/library/sections/watchlist/all', { 'X-Plex-Container-Start': start, 'X-Plex-Container-Size': size });
    return { items: (c.Metadata || []).map(fromDiscover), total: c.totalSize ?? c.size ?? 0 };
  }
  async onWatchlist(key) {
    const c = await this.tv(`/library/metadata/${key}/userState`);
    return !!c.UserState?.[0]?.watchlistedAt;
  }
  setWatchlist(key, on) {
    return this.tv(on ? '/actions/addToWatchlist' : '/actions/removeFromWatchlist', { ratingKey: key }, 'PUT');
  }
  async discoverItem(key) {
    const c = await this.tv(`/library/metadata/${key}`);
    return c.Metadata?.[0] ? fromDiscover(c.Metadata[0]) : null;
  }
  async discoverSearch(query, limit = 20) {
    const c = await this.tv('/library/search', { query, limit, searchTypes: 'movies,tv', searchProviders: 'discover', includeMetadata: 1 });
    const seen = new Set();
    const out = [];
    for (const group of c.SearchResults || []) {
      for (const r of group.SearchResult || []) {
        const m = r.Metadata;
        if (m && (m.type === 'movie' || m.type === 'show') && !seen.has(m.ratingKey)) {
          seen.add(m.ratingKey);
          out.push(fromDiscover(m));
        }
      }
    }
    return out;
  }
  // The library copy of a Plex catalog title (matched by its plex:// guid), if the server has one.
  async localByGuid(guid) {
    const c = await this.get('/library/all', { guid });
    return c.Metadata?.[0] || null;
  }

  // ---------- library actions ----------
  async machineId() {
    if (!this._machineId) this._machineId = (await this.get('/')).machineIdentifier;
    return this._machineId;
  }
  // The server URI that play queues and playlists take for a title or a list path.
  async itemUri(ratingKeyOrPath) {
    const path = String(ratingKeyOrPath).startsWith('/') ? ratingKeyOrPath : `/library/metadata/${ratingKeyOrPath}`;
    return `server://${await this.machineId()}/com.plexapp.plugins.library${path}`;
  }
  // Star rating from 0 to 10 (five stars in half steps). null clears it.
  rate(ratingKey, rating) {
    return this.put('/:/rate', { key: ratingKey, identifier: 'com.plexapp.plugins.library', rating: rating == null ? -1 : rating });
  }
  removeFromContinueWatching(ratingKey) {
    return this.put('/actions/removeFromContinueWatching', { ratingKey });
  }
  refreshMetadata(ratingKey) {
    return this.put(`/library/metadata/${ratingKey}/refresh`, { force: 1 });
  }
  analyze(ratingKey) {
    return this.put(`/library/metadata/${ratingKey}/analyze`);
  }
  async matches(ratingKey, { title, year } = {}) {
    const c = await this.get(`/library/metadata/${ratingKey}/matches`, { manual: 1, title, year, language: 'en-US' });
    return c.SearchResult || [];
  }
  applyMatch(ratingKey, { guid, name, year }) {
    return this.put(`/library/metadata/${ratingKey}/match`, { guid, name, year });
  }
  // Edits fields and locks them, so a metadata refresh keeps the edit. fields: { title: 'x', ... }
  editFields(item, fields) {
    const type = { movie: 1, show: 2, season: 3, episode: 4 }[item.type];
    const params = { type, id: item.ratingKey };
    for (const [k, v] of Object.entries(fields)) {
      params[`${k}.value`] = v;
      params[`${k}.locked`] = 1;
    }
    // Empty values must reach Plex to clear a field, so build this URL without dropping them.
    const u = new URL(this.url(`/library/sections/${item.librarySectionID}/all`));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v ?? '');
    return window.marquee.request(u.toString(), 'PUT').then((r) => {
      if (r.status >= 400) throw new Error(`Plex returned HTTP ${r.status} for the edit`);
    });
  }
  async playlists() {
    const c = await this.get('/playlists', { playlistType: 'video' });
    return c.Metadata || [];
  }
  async addToPlaylist(playlistId, ratingKey) {
    return this.put(`/playlists/${playlistId}/items`, { uri: await this.itemUri(ratingKey) });
  }
  // Play queue for a show, season, title, or playlist. Plex sets the order (shuffled or not) and
  // returns a window of about 20 items around the first one.
  async createPlayQueue({ key, playlistID, shuffle = false }) {
    const params = { type: 'video', shuffle: shuffle ? 1 : 0 };
    if (playlistID) params.playlistID = playlistID;
    else params.uri = await this.itemUri(key);
    return this.post('/playQueues', params);
  }
  // The items on each side of one queue item (center and window are Plex Web's parameters).
  queueWindow(playQueueID, itemID, size = 1) {
    return this.get(`/playQueues/${playQueueID}`, { center: itemID, window: size });
  }
  async playlistItems(playlistId) {
    const c = await this.get(`/playlists/${playlistId}/items`);
    return { info: c, items: c.Metadata || [] };
  }
  async createPlaylist(title, ratingKey) {
    const c = await this.post('/playlists', { type: 'video', title, smart: 0, uri: await this.itemUri(ratingKey) });
    return c.Metadata?.[0];
  }

  // ---------- playback ----------
  // Plex's Chrome profile plus three changes: copy HEVC and AV1 when this computer can decode them,
  // allow 10-bit video, and allow up to 7.1 audio when Plex converts the audio.
  static profileExtra() {
    const video = ['h264', ...decodableVideoCodecs()].join(',');
    return [
      `add-transcode-target(type=videoProfile&context=streaming&protocol=dash&container=mp4&videoCodec=${video}&audioCodec=aac,opus,flac,mp3&replace=true)`,
      'add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.bitDepth&value=10&replace=true)',
      'add-limitation(scope=videoTranscodeTarget&scopeName=*&scopeType=videoAudioCodec&context=streaming&protocol=*&type=upperBound&name=audio.channels&value=8&onlyTranscodes=true&replace=true)',
    ].join('+');
  }
  // burn: Plex draws the selected subtitle into the video. Otherwise Plex leaves subtitles out of the
  // stream and the player shows external text subtitles itself.
  streamParams(ratingKey, session, { burn = false, quality = 'original', mediaIndex = 0 } = {}) {
    const q = QUALITY[quality] || QUALITY.original;
    return {
      path: `/library/metadata/${ratingKey}`,
      mediaIndex,
      partIndex: 0,
      protocol: 'dash',
      fastSeek: 1,
      directPlay: 0,
      directStream: q.directStream,
      directStreamAudio: 1,
      subtitles: burn ? 'burn' : 'none',
      videoQuality: 100,
      maxVideoBitrate: q.bitrate,
      videoResolution: q.resolution,
      session,
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': Plex.profileExtra(),
    };
  }
  decision(ratingKey, session, opts) {
    return this.get('/video/:/transcode/universal/decision', this.streamParams(ratingKey, session, opts));
  }
  manifestUrl(ratingKey, session, opts) {
    return this.url('/video/:/transcode/universal/start.mpd', this.streamParams(ratingKey, session, opts));
  }
  stopTranscode(session) {
    return this.get('/video/:/transcode/universal/stop', { session }).catch(() => {});
  }
  // Keeps a paused transcode alive. Plex ends one after 180 seconds without requests.
  pingTranscode(session) {
    return this.get('/video/:/transcode/universal/ping', { session }).catch(() => {});
  }
  selectStreams(partId, { audioStreamID, subtitleStreamID }) {
    return this.put(`/library/parts/${partId}`, { audioStreamID, subtitleStreamID, allParts: 1 });
  }
  timelineParams(item, state, timeMs, session) {
    return {
      ratingKey: item.ratingKey,
      key: item.key,
      state,
      time: Math.round(timeMs),
      duration: item.duration,
      'X-Plex-Session-Identifier': session,
    };
  }
  timeline(item, state, timeMs, session) {
    return this.get('/:/timeline', this.timelineParams(item, state, timeMs, session)).catch(() => {});
  }
  // The two requests that end a stream: a stopped timeline and the transcode stop.
  streamEndUrls(item, timeMs, session) {
    return [this.url('/:/timeline', this.timelineParams(item, 'stopped', timeMs, session)), this.url('/video/:/transcode/universal/stop', { session })];
  }

  // ---------- Live TV ----------
  // The first DVR (tuner and guide). Its epgIdentifier names the guide provider path.
  async liveDvr() {
    const mc = await this.get('/livetv/dvrs');
    return (mc.Dvr || [])[0] || null;
  }
  async liveChannels(dvr) {
    const mc = await this.get(`/${dvr.epgIdentifier}/lineups/dvr/channels`);
    return mc.Channel || [];
  }
  // Programs airing between `from` and `to` (Unix seconds) on every channel.
  async liveGrid(dvr, from, to) {
    const mc = await this.get(`/${dvr.epgIdentifier}/grid`, { type: '1,4', 'endsAt>': from, 'beginsAt<': to });
    return mc.Metadata || [];
  }
  // Takes a tuner and starts a rolling grab. Returns the live session's metadata (key
  // /livetv/sessions/<uuid>). The channel is the guide's channelIdentifier, not the number.
  // The session must be the one the transcode uses: the transcoder reads
  // /livetv/sessions/<uuid>/<X-Plex-Session-Identifier>/index.m3u8, which exists only for the
  // identifier the tune carried. Without it the transcode gets a 404 and start.mpd stalls 25 s.
  async tune(dvr, channelId, session) {
    const mc = await this.post(`/livetv/dvrs/${dvr.key}/channels/${encodeURIComponent(channelId)}/tune`, { 'X-Plex-Session-Identifier': session });
    const op = mc.MediaSubscription?.[0]?.MediaGrabOperation?.[0];
    if (!op?.Metadata) throw new Error(mc.message || 'Plex could not tune this channel.');
    return op.Metadata;
  }
  // The live stream goes through the transcoder like a file: path is the live session.
  liveParams(sessionKey, session) {
    return {
      path: sessionKey,
      mediaIndex: 0,
      partIndex: 0,
      protocol: 'dash',
      fastSeek: 1,
      directPlay: 0,
      directStream: 0,
      directStreamAudio: 0,
      videoQuality: 100,
      session,
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': Plex.profileExtra(),
    };
  }
  liveDecision(sessionKey, session) {
    return this.get('/video/:/transcode/universal/decision', this.liveParams(sessionKey, session));
  }
  liveManifestUrl(sessionKey, session) {
    return this.url('/video/:/transcode/universal/start.mpd', this.liveParams(sessionKey, session));
  }
}

export const QUALITY = {
  original: { label: 'Original quality', directStream: 1, bitrate: 200000, resolution: '3840x2160' },
  '1080': { label: '1080p, 12 Mbps', directStream: 0, bitrate: 12000, resolution: '1920x1080' },
  '720': { label: '720p, 4 Mbps', directStream: 0, bitrate: 4000, resolution: '1280x720' },
};

export function imageOf(item, type) {
  return item?.Image?.find((i) => i.type === type)?.url || null;
}

// Video codecs, beyond H.264, that this computer's Chromium can decode through Media Source Extensions.
let codecCache = null;
export function decodableVideoCodecs() {
  if (codecCache) return codecCache;
  const ok = (type) => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  codecCache = [];
  if (ok('video/mp4; codecs="hvc1.2.4.L153.B0"') || ok('video/mp4; codecs="hev1.2.4.L153.B0"')) codecCache.push('hevc');
  if (ok('video/mp4; codecs="av01.0.08M.10"')) codecCache.push('av1');
  return codecCache;
}

// ---------- Plex catalog (Discover) ----------
const DISCOVER = 'https://discover.provider.plex.tv';
// The catalog ratingKey of a library title: the last part of its plex:// guid.
export function discoverKey(item) {
  return /^plex:\/\/(?:movie|show)\/([0-9a-f]+)$/.exec(item?.guid || '')?.[1] || null;
}
// Catalog items look like library items, but their keys belong to plex.tv. `discover` marks them so
// cards link to the catalog page instead of the library.
function fromDiscover(m) {
  return { ...m, discover: true };
}
