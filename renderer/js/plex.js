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
    if (!r.text) return {};
    return JSON.parse(r.text).MediaContainer || {};
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
  async metadata(id, params = {}) {
    const c = await this.get(`/library/metadata/${id}`, params);
    return c.Metadata?.[0];
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
  streamParams(ratingKey, session, { burn = false, quality = 'original' } = {}) {
    const q = QUALITY[quality] || QUALITY.original;
    return {
      path: `/library/metadata/${ratingKey}`,
      mediaIndex: 0,
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
