"use strict";

const { createSenderGuardedHandler } = require('../ipcAccessGuard.cjs');
const CHANNELS = require('./clientIpcChannels.cjs');

// electron/netease/clientIpc.cjs
// The renderer-facing half of the NetEase PC client takeover. Every handler validates its own
// arguments before the controller sees them: the preload methods are a convenience, not a
// security boundary, and a compromised renderer can call ipcRenderer.invoke with anything.
// Callers must be the main window (remote-control is deliberately not trusted here).

const DEBUG_PORT = 9223;
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

const invalid = (message) => toClientError('invalid-argument', message);

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;

const isFiniteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const statusWithError = (error) => ({
  status: 'error',
  clientVersion: null,
  port: DEBUG_PORT,
  capabilities: { ...NO_CAPABILITIES },
  error,
});

const commandWithError = (error) => ({ ok: false, error });

const validateQueueIds = (queueIds, songId) => {
  if (queueIds === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(queueIds)) return { ok: false, error: invalid('queueIds must be an array.') };
  if (queueIds.length > 100) return { ok: false, error: invalid('queueIds may hold at most 100 ids.') };
  if (!queueIds.every(isPositiveInteger)) {
    return { ok: false, error: invalid('queueIds must contain positive integers only.') };
  }
  const unique = [...new Set(queueIds)];
  if (!unique.includes(songId)) {
    return { ok: false, error: invalid('queueIds must contain songId.') };
  }
  return { ok: true, value: unique };
};

const registerNeteaseClientIpc = ({
  ipcMain,
  controller,
  isTrusted,
}) => {
  const trusted = typeof isTrusted === 'function' ? isTrusted : () => false;

  const handle = (channel, handler, onUntrusted) => {
    ipcMain.handle(channel, createSenderGuardedHandler({
      channel,
      // main.cjs hands us isTrustedMainWindowContents, which takes the webContents; the guard
      // hands its callback the whole IPC event.
      isTrusted: (event) => trusted(event && event.sender),
      handler,
      onUntrusted,
    }));
  };

  const guardedStatus = (channel, handler) => handle(
    channel,
    handler,
    () => statusWithError(toClientError('untrusted', 'This window is not allowed to control the NetEase client.')),
  );

  const guardedCommand = (channel, handler) => handle(
    channel,
    handler,
    () => commandWithError(toClientError('untrusted', 'This window is not allowed to control the NetEase client.')),
  );

  guardedStatus(CHANNELS.connect, async (_event, options) => {
    if (options !== undefined && !isPlainObject(options)) {
      return statusWithError(invalid('options must be an object when provided.'));
    }
    if (options && options.force !== undefined && typeof options.force !== 'boolean') {
      return statusWithError(invalid('force must be a boolean.'));
    }
    try {
      return await controller.connect(options);
    } catch (error) {
      return statusWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedStatus(CHANNELS.disconnect, async (_event, options) => {
    if (options !== undefined && !isPlainObject(options)) {
      return statusWithError(invalid('options must be an object when provided.'));
    }
    if (options && options.pauseFirst !== undefined && typeof options.pauseFirst !== 'boolean') {
      return statusWithError(invalid('pauseFirst must be a boolean.'));
    }
    try {
      return await controller.disconnect(options);
    } catch (error) {
      return statusWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedStatus(CHANNELS.getStatus, async () => {
    try {
      return controller.getStatus();
    } catch (error) {
      return statusWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  handle(
    CHANNELS.getSnapshot,
    async () => {
      try {
        return controller.getSnapshot();
      } catch (error) {
        return null;
      }
    },
    () => null,
  );

  guardedCommand(CHANNELS.playSong, async (_event, input) => {
    if (!isPlainObject(input)) return commandWithError(invalid('input must be an object.'));
    if (!isPositiveInteger(input.songId)) return commandWithError(invalid('songId must be a positive integer.'));
    const queue = validateQueueIds(input.queueIds, input.songId);
    if (!queue.ok) return commandWithError(queue.error);
    if (input.startPositionSec !== undefined && !isFiniteNonNegative(input.startPositionSec)) {
      return commandWithError(invalid('startPositionSec must be a finite number >= 0.'));
    }
    try {
      return await controller.playSong({
        songId: input.songId,
        ...(queue.value === undefined ? {} : { queueIds: queue.value }),
        ...(input.startPositionSec === undefined ? {} : { startPositionSec: input.startPositionSec }),
      });
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.play, async () => {
    try {
      return await controller.play();
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.pause, async () => {
    try {
      return await controller.pause();
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.toggle, async () => {
    try {
      return await controller.toggle();
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.next, async () => {
    try {
      return await controller.next();
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.prev, async () => {
    try {
      return await controller.prev();
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.seek, async (_event, input) => {
    if (!isPlainObject(input)) return commandWithError(invalid('input must be an object.'));
    if (!isFiniteNonNegative(input.positionSec)) {
      return commandWithError(invalid('positionSec must be a finite number >= 0.'));
    }
    try {
      return await controller.seek(input.positionSec);
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });

  guardedCommand(CHANNELS.setVolume, async (_event, input) => {
    if (!isPlainObject(input)) return commandWithError(invalid('input must be an object.'));
    if (typeof input.volume !== 'number' || !Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1) {
      return commandWithError(invalid('volume must be a finite number between 0 and 1.'));
    }
    try {
      return await controller.setVolume(input.volume);
    } catch (error) {
      return commandWithError(toClientError('client-rejected', error && error.message ? error.message : String(error)));
    }
  });
};

module.exports = {
  NO_CAPABILITIES,
  registerNeteaseClientIpc,
};
