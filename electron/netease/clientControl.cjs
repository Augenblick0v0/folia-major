"use strict";

const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');
const CHANNELS = require('./clientIpcChannels.cjs');

// electron/netease/clientControl.cjs
// Main-process owner of the NetEase PC client takeover. The renderer never opens the DevTools
// socket: this module discovers the client's orpheus page on 127.0.0.1:9223, injects
// clientBootstrap.js into it, polls a snapshot every 500ms and forwards the transport commands.
//
// The lifecycle is generation-guarded. Every connect / disconnect bumps `generation`; any await
// that resumes with a stale generation closes its socket and returns instead of overwriting the
// state a newer call owns. Socket closes reconnect only when they were not requested by us.

const DEBUG_PORT = 9223;
const BASE_URL = `http://127.0.0.1:${DEBUG_PORT}`;

const NO_CAPABILITIES = Object.freeze({
  playById: false,
  transport: false,
  seek: false,
  setVolume: false,
  readProgress: false,
  nativeSkip: false,
});

const CLIENT_ERROR_CODES = new Set([
  'cdp-unreachable',
  'page-target-missing',
  'unsupported-client',
  'websocket-error',
  'evaluate-timeout',
  'client-rejected',
  'song-detail-empty',
  'not-connected',
  'invalid-argument',
  'untrusted',
]);

const toClientError = (code, message) => ({
  code: CLIENT_ERROR_CODES.has(code) ? code : 'client-rejected',
  message: String(message === undefined || message === null ? code : message),
});

const finiteNumber = (value, fallback = 0) => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

const clamp01 = (value) => Math.min(1, Math.max(0, finiteNumber(value, 0)));

const parseClientVersion = (info) => {
  if (!info || typeof info !== 'object') return null;
  const userAgent = typeof info['User-Agent'] === 'string' ? info['User-Agent'] : '';
  const matched = userAgent.match(/NeteaseMusicDesktop\/[\d.]+/);
  if (matched) return matched[0];
  return typeof info.Browser === 'string' && info.Browser.length > 0 ? info.Browser : null;
};

const normalizeCapabilities = (value) => ({
  playById: Boolean(value && value.playById === true),
  transport: Boolean(value && value.transport === true),
  seek: Boolean(value && value.seek === true),
  setVolume: Boolean(value && value.setVolume === true),
  readProgress: Boolean(value && value.readProgress === true),
  nativeSkip: Boolean(value && value.nativeSkip === true),
});

const normalizeTrack = (value) => {
  if (!value || typeof value !== 'object') return null;
  const id = Number(value.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const track = {
    id,
    name: typeof value.name === 'string' ? value.name : '',
    durationMs: Math.max(0, Math.round(finiteNumber(value.durationMs, 0))),
  };
  if (Array.isArray(value.artists)) {
    const artists = value.artists.filter((artist) => typeof artist === 'string' && artist.length > 0);
    if (artists.length > 0) track.artists = artists;
  }
  if (typeof value.album === 'string' && value.album.length > 0) track.album = value.album;
  return track;
};

const normalizePlayback = (value) => (
  value === 'playing' || value === 'paused' ? value : 'stopped'
);

const errorFromException = (details) => {
  const description = (details && details.exception && details.exception.description)
    || (details && details.text)
    || 'The client rejected the command.';
  if (/song-detail-empty/i.test(description)) return toClientError('song-detail-empty', description);
  if (/unsupported-client/i.test(description)) return toClientError('unsupported-client', description);
  return toClientError('client-rejected', String(description).split('\n')[0]);
};

const createNeteaseClientController = ({
  broadcast = () => {},
  logger = console,
  fetchImpl = (...args) => globalThis.fetch(...args),
  WebSocketImpl = WebSocket,
  bootstrapSource = null,
  now = () => Date.now(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  pollIntervalMs = 500,
  fetchTimeoutMs = 1500,
  evaluateTimeoutMs = 5000,
  reconnectDelays = [1000, 2000, 5000, 10000, 30000],
} = {}) => {
  let connectionState = 'disconnected';
  let clientVersion = null;
  let capabilities = { ...NO_CAPABILITIES };
  let track = null;
  let playback = 'stopped';
  let durationSec = 0;
  let volume = 0;
  let positionSec = 0;
  let lastError = null;
  let revision = 0;
  let snapshotCache = null;

  let generation = 0;
  let manualClose = false;
  let socket = null;
  let messageId = 0;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let pollingTimer = null;
  let pollSuspended = 0;
  let connectPromise = null;

  const pending = new Map();
  let commandChain = Promise.resolve();
  let cachedBootstrapSource = bootstrapSource;

  const getBootstrapSource = () => {
    if (cachedBootstrapSource === null) {
      cachedBootstrapSource = fs.readFileSync(path.join(__dirname, 'clientBootstrap.js'), 'utf8');
    }
    return cachedBootstrapSource;
  };

  const emit = (channel, payload) => {
    try {
      broadcast(channel, payload);
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] broadcast failed', error);
    }
  };

  const getStatus = () => ({
    status: connectionState,
    clientVersion,
    port: DEBUG_PORT,
    capabilities: { ...capabilities },
    error: lastError,
  });

  const buildSnapshot = () => ({
    revision,
    status: connectionState,
    clientVersion,
    track,
    playback,
    positionSec,
    sampledAt: now(),
    durationSec,
    volume,
    capabilities: { ...capabilities },
    error: lastError,
  });

  const getSnapshot = () => (snapshotCache ? { ...snapshotCache } : null);

  const broadcastStatus = () => {
    emit(CHANNELS.status, getStatus());
  };

  const broadcastSnapshot = () => {
    revision += 1;
    snapshotCache = buildSnapshot();
    emit(CHANNELS.snapshot, snapshotCache);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeoutImpl(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const stopPolling = () => {
    if (pollingTimer !== null) {
      clearTimeoutImpl(pollingTimer);
      pollingTimer = null;
    }
  };

  const rejectPending = (error) => {
    for (const [id, entry] of pending) {
      clearTimeoutImpl(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const resetPlayback = () => {
    track = null;
    playback = 'stopped';
    durationSec = 0;
    positionSec = 0;
    volume = 0;
    snapshotCache = null;
  };

  const setConnectionState = (next, error = null) => {
    connectionState = next;
    lastError = error;
    if (next === 'connecting') clientVersion = null;
    if (next === 'disconnected' || next === 'connecting' || next === 'error') {
      capabilities = { ...NO_CAPABILITIES };
    }
    if (next === 'disconnected' || next === 'connecting' || next === 'error') {
      resetPlayback();
    }
    broadcastStatus();
    if (next === 'disconnected' || next === 'error') {
      // A status without a snapshot left the renderer's cached track alive. Broadcast the empty
      // snapshot too, so no subscriber keeps a track the client no longer has. (Not for
      // `connecting`: the first real snapshot should stay revision 1.)
      broadcastSnapshot();
    }
  };

  const handleSocketMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (error) {
      return;
    }
    if (!message || message.id === undefined || message.id === null) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeoutImpl(entry.timer);
    if (message.error) {
      entry.reject(toClientError('websocket-error', message.error.message || 'DevTools command failed'));
      return;
    }
    const result = message.result || {};
    if (result.exceptionDetails) {
      entry.reject(errorFromException(result.exceptionDetails));
      return;
    }
    entry.resolve(result.result ? result.result.value : undefined);
  };

  const attachSocket = (ws, gen) => {
    ws.on('message', (raw) => {
      if (socket !== ws) return;
      handleSocketMessage(raw);
    });
    ws.on('error', (error) => {
      if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] websocket error', error);
    });
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      const closeError = toClientError('websocket-error', 'The DevTools socket closed.');
      lastError = closeError;
      rejectPending(closeError);
      if (!manualClose && gen === generation) scheduleReconnect();
    });
  };

  const sendRaw = (method, params, timeoutMs = evaluateTimeoutMs) => new Promise((resolve, reject) => {
    const current = socket;
    if (!current) {
      reject(toClientError('not-connected', 'The NetEase client is not connected.'));
      return;
    }
    const id = ++messageId;
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeoutImpl(() => {
      pending.delete(id);
      reject(toClientError('evaluate-timeout', `The client did not answer ${method} in time.`));
    }, timeoutMs);
    pending.set(id, entry);
    try {
      current.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        const stored = pending.get(id);
        if (!stored) return;
        pending.delete(id);
        clearTimeoutImpl(stored.timer);
        stored.reject(toClientError('websocket-error', error.message || 'DevTools send failed'));
      });
    } catch (error) {
      pending.delete(id);
      clearTimeoutImpl(entry.timer);
      reject(toClientError('websocket-error', error && error.message ? error.message : String(error)));
    }
  });

  const evaluate = async (expression, timeoutMs = evaluateTimeoutMs) => {
    const response = await sendRaw('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    return response;
  };

  // A Runtime.evaluate timeout only forgets the command in the main process; the page's playSong
  // may still finish its song-detail fetch and start playing. cancelPlay marks that generation dead;
  // the pause covers a play that had already dispatched before the cancel arrived.
  const cancelPendingPlayback = async () => {
    try {
      await evaluate('window.__foliaNetease && typeof window.__foliaNetease.cancelPlay === "function" ? window.__foliaNetease.cancelPlay() : false', 1000);
    } catch (error) {
      // The socket may be gone; there is nothing left to cancel in that case.
    }
    try {
      await evaluate('window.__foliaNetease && typeof window.__foliaNetease.pause === "function" ? window.__foliaNetease.pause() : false', 1000);
    } catch (error) {
      // Same as above.
    }
  };

  const fetchJson = async (url) => {
    const abort = new AbortController();
    const timer = setTimeoutImpl(() => abort.abort(), fetchTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: abort.signal });
      if (!response || response.ok === false) {
        throw new Error(`HTTP ${response && response.status ? response.status : 'request failed'}`);
      }
      return await response.json();
    } catch (error) {
      throw toClientError('cdp-unreachable', `${url}: ${error && error.message ? error.message : String(error)}`);
    } finally {
      clearTimeoutImpl(timer);
    }
  };

  const openSocket = (url) => new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch (error) {
      reject(toClientError('websocket-error', error && error.message ? error.message : String(error)));
      return;
    }
    let settled = false;
    const openTimer = setTimeoutImpl(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (closeError) { /* already gone */ }
      reject(toClientError('websocket-error', 'The DevTools socket did not open in time.'));
    }, evaluateTimeoutMs);
    ws.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(openTimer);
      resolve(ws);
    });
    ws.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(openTimer);
      try { ws.close(); } catch (closeError) { /* already gone */ }
      reject(toClientError('websocket-error', error && error.message ? error.message : 'The DevTools socket failed to open.'));
    });
  });

  const closeSocket = () => {
    const current = socket;
    socket = null;
    if (!current) return;
    try { current.close(); } catch (error) { /* already gone */ }
  };

  const applyBootstrap = (result) => {
    if (!result || (result.installed !== true && result.reused !== true)) {
      throw toClientError('unsupported-client', 'The client did not expose the expected store API.');
    }
    const reported = result.capabilities || {};
    capabilities = {
      ...normalizeCapabilities({
        ...reported,
        // seek / setVolume / nativeSkip were measured on the real client and stay available
        // unless a command fails; the bootstrap only reports whether dispatch exists at all.
        seek: reported.playById,
        setVolume: reported.playById,
        nativeSkip: reported.playById,
      }),
    };
    if (reported.playById !== true) {
      throw toClientError('unsupported-client', 'The client store dispatch API is not available.');
    }
  };

  const applyRawSnapshot = (raw) => {
    if (!raw || typeof raw !== 'object') {
      throw toClientError('unsupported-client', 'The client snapshot is empty.');
    }
    const nextTrack = normalizeTrack(raw.track);
    track = nextTrack;
    playback = normalizePlayback(raw.playback);
    const reportedDuration = finiteNumber(raw.durationSec, -1);
    durationSec = reportedDuration >= 0
      ? reportedDuration
      : (nextTrack ? nextTrack.durationMs / 1000 : 0);
    volume = clamp01(raw.volume);
    const reportedPosition = Math.max(0, finiteNumber(raw.positionSec, 0));
    positionSec = durationSec > 0 ? Math.min(reportedPosition, durationSec) : reportedPosition;
    if (raw.capabilities && typeof raw.capabilities === 'object') {
      // Polling may only take a capability away: a command failure stays failed until reconnect.
      if (raw.capabilities.playById === false) capabilities.playById = false;
      if (raw.capabilities.transport === false) capabilities.transport = false;
      if (raw.capabilities.readProgress === false) capabilities.readProgress = false;
    }
    lastError = null;
    broadcastSnapshot();
  };

  const refreshSnapshot = async () => {
    const raw = await evaluate(
      'window.__foliaNetease && typeof window.__foliaNetease.readAll === "function" ? window.__foliaNetease.readAll() : null',
    );
    applyRawSnapshot(raw);
  };

  const startPolling = (gen) => {
    stopPolling();
    const tick = async () => {
      pollingTimer = null;
      if (gen !== generation || connectionState !== 'connected') return;
      if (pollSuspended === 0) {
        try {
          // Polling shares the command queue: a snapshot read never overlaps a playSong call.
          await enqueue(() => refreshSnapshot());
        } catch (error) {
          if (error && error.code === 'websocket-error') {
            // The socket close handler owns the reconnect; failing a poll adds no state here.
            return;
          }
          if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] snapshot poll failed', error);
        }
      }
      if (gen === generation && connectionState === 'connected') {
        pollingTimer = setTimeoutImpl(tick, pollIntervalMs);
      }
    };
    pollingTimer = setTimeoutImpl(tick, pollIntervalMs);
  };

  const scheduleReconnect = () => {
    if (manualClose) return;
    if (reconnectAttempts >= reconnectDelays.length) {
      closeSocket();
      setConnectionState('error', toClientError('cdp-unreachable', 'The NetEase client did not answer after reconnecting.'));
      return;
    }
    const delay = reconnectDelays[reconnectAttempts];
    reconnectAttempts += 1;
    setConnectionState('reconnecting', lastError);
    const gen = generation;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      if (gen !== generation || manualClose) return;
      void establish(gen, true).catch((error) => {
        if (gen !== generation || manualClose) return;
        if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] reconnect failed', error);
        scheduleReconnect();
      });
    }, delay);
  };

  const establish = async (gen, isReconnect) => {
    const versionInfo = await fetchJson(`${BASE_URL}/json/version`);
    if (gen !== generation) return false;
    const targets = await fetchJson(`${BASE_URL}/json`);
    if (gen !== generation) return false;
    const list = Array.isArray(targets) ? targets : [];
    const target = list.find((candidate) => (
      candidate
      && candidate.type === 'page'
      && typeof candidate.url === 'string'
      && candidate.url.startsWith('orpheus://')
      && typeof candidate.webSocketDebuggerUrl === 'string'
    ));
    if (!target) {
      throw toClientError('page-target-missing', 'No orpheus:// page target was found on port 9223.');
    }

    const ws = await openSocket(target.webSocketDebuggerUrl);
    if (gen !== generation) {
      try { ws.close(); } catch (error) { /* already gone */ }
      return false;
    }
    socket = ws;
    attachSocket(ws, gen);
    clientVersion = parseClientVersion(versionInfo);

    try {
      await sendRaw('Runtime.enable', {});
      if (gen !== generation) {
        try { ws.close(); } catch (error) { /* already gone */ }
        return false;
      }
      const result = await evaluate(getBootstrapSource());
      if (gen !== generation) {
        try { ws.close(); } catch (error) { /* already gone */ }
        return false;
      }
      applyBootstrap(result);
      if (gen !== generation) {
        try { ws.close(); } catch (error) { /* already gone */ }
        return false;
      }
      setConnectionState('connected', null);
      startPolling(gen);
      await refreshSnapshot();
      // Reset the backoff only after the new socket produced a snapshot: a reconnect that opens
      // the socket but cannot read the page must keep counting towards the five attempts.
      reconnectAttempts = 0;
      return true;
    } catch (error) {
      stopPolling();
      closeSocket();
      throw error;
    }
  };

  const runConnect = async (options) => {
    if (options.force === true) {
      await disconnectInternal({ pauseFirst: false });
    } else if (connectionState === 'connected') {
      return getStatus();
    }

    const gen = ++generation;
    manualClose = false;
    reconnectAttempts = 0;
    clearReconnectTimer();
    stopPolling();
    setConnectionState('connecting', null);
    try {
      await establish(gen, false);
    } catch (error) {
      if (gen !== generation) return getStatus();
      closeSocket();
      const clientError = error && error.code
        ? toClientError(error.code, error.message)
        : toClientError('cdp-unreachable', error && error.message ? error.message : String(error));
      setConnectionState('error', clientError);
    }
    return getStatus();
  };

  const connect = (options = {}) => {
    const normalized = options && typeof options === 'object' ? options : {};
    if (connectPromise && normalized.force !== true) return connectPromise;
    const previous = connectPromise ? connectPromise.catch(() => undefined) : Promise.resolve();
    const run = previous.then(() => runConnect(normalized));
    const tracked = run.finally(() => {
      if (connectPromise === tracked) connectPromise = null;
    });
    connectPromise = tracked;
    return tracked;
  };

  const disconnectInternal = async ({ pauseFirst = false } = {}) => {
    generation += 1;
    manualClose = true;
    clearReconnectTimer();
    stopPolling();
    const current = socket;
    if (pauseFirst && current) {
      try {
        await evaluate('window.__foliaNetease && typeof window.__foliaNetease.pause === "function" ? window.__foliaNetease.pause() : false');
      } catch (error) {
        if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] pause before disconnect failed', error);
      }
    }
    // Close the socket this call owns, not whatever `socket` points at now: a connect that ran
    // while the pause above was in flight owns the newer one.
    if (current) {
      if (socket === current) socket = null;
      try { current.close(); } catch (error) { /* already gone */ }
    }
    rejectPending(toClientError('not-connected', 'The NetEase client was disconnected.'));
    clientVersion = null;
    connectionState = 'disconnected';
    lastError = null;
    capabilities = { ...NO_CAPABILITIES };
    resetPlayback();
    broadcastStatus();
    // The renderer must learn the track is gone, not only that the socket is. Without this its
    // snapshot cache kept the last connected track and a shim attach replayed it.
    broadcastSnapshot();
    return getStatus();
  };

  const disconnect = (options = {}) => disconnectInternal({
    pauseFirst: Boolean(options && options.pauseFirst === true),
  });

  const enqueue = (task) => {
    const result = commandChain.then(task, task);
    commandChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const degrade = (capability, error) => {
    if (!capability) return;
    capabilities = { ...capabilities, [capability]: false };
    lastError = error;
    broadcastStatus();
  };

  const executeCommand = (expression, capability, { suspendPolling = false } = {}) => enqueue(async () => {
    if (connectionState !== 'connected' || !socket) {
      return { ok: false, error: toClientError('not-connected', 'The NetEase client is not connected.') };
    }
    if (suspendPolling) pollSuspended += 1;
    try {
      const value = await evaluate(expression);
      if (value === false) throw toClientError('client-rejected', 'The client rejected the command.');
      try {
        await refreshSnapshot();
      } catch (error) {
        // The command itself succeeded; keep the result usable with the last known snapshot.
      }
      return { ok: true, snapshot: snapshotCache || buildSnapshot() };
    } catch (error) {
      const clientError = error && error.code
        ? toClientError(error.code, error.message)
        : toClientError('client-rejected', error && error.message ? error.message : String(error));
      if (capability === 'playById' && clientError.code === 'evaluate-timeout') {
        await cancelPendingPlayback();
      }
      degrade(capability, clientError);
      return { ok: false, error: clientError };
    } finally {
      if (suspendPolling) pollSuspended = Math.max(0, pollSuspended - 1);
    }
  });

  const playSong = (input) => {
    const queueIds = input && Array.isArray(input.queueIds) ? input.queueIds : null;
    const startPositionSec = input && typeof input.startPositionSec === 'number' && Number.isFinite(input.startPositionSec)
      ? input.startPositionSec
      : null;
    const expression = `window.__foliaNetease.playSong(${JSON.stringify(input ? input.songId : null)}, ${JSON.stringify(queueIds)}, ${JSON.stringify(startPositionSec)})`;
    return executeCommand(expression, 'playById', { suspendPolling: true });
  };

  const play = () => executeCommand('window.__foliaNetease.play()', 'transport');
  const pause = () => executeCommand('window.__foliaNetease.pause()', 'transport');
  const toggle = () => executeCommand('window.__foliaNetease.toggle()', 'transport');
  const next = () => executeCommand('window.__foliaNetease.next()', 'nativeSkip');
  const prev = () => executeCommand('window.__foliaNetease.prev()', 'nativeSkip');

  const seek = (positionSecInput) => {
    const requested = Math.max(0, finiteNumber(positionSecInput, 0));
    const clamped = durationSec > 0 ? Math.min(requested, durationSec) : requested;
    return executeCommand(`window.__foliaNetease.seek(${JSON.stringify(clamped)})`, 'seek');
  };

  const setVolume = (volumeInput) => {
    const clamped = clamp01(volumeInput);
    return executeCommand(`window.__foliaNetease.setVolume(${JSON.stringify(clamped)})`, 'setVolume');
  };

  const start = () => {
    try {
      getBootstrapSource();
    } catch (error) {
      if (logger && typeof logger.warn === 'function') logger.warn('[ClientTakeover] bootstrap source is missing', error);
    }
  };

  const dispose = () => disconnectInternal({ pauseFirst: false });

  return {
    start,
    connect,
    disconnect,
    getStatus,
    getSnapshot,
    playSong,
    play,
    pause,
    toggle,
    next,
    prev,
    seek,
    setVolume,
    dispose,
  };
};

module.exports = {
  DEBUG_PORT,
  NO_CAPABILITIES,
  parseClientVersion,
  createNeteaseClientController,
};
