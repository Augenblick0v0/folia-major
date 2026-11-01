"use strict";

// electron/netease/clientIpcChannels.cjs
// The channel names of the NetEase PC client takeover. main.cjs and clientIpc.cjs share this
// module; preload.cjs is sandboxed and keeps its own copy inline (it may only require electron).

module.exports = Object.freeze({
  connect: 'netease-client:connect',
  disconnect: 'netease-client:disconnect',
  getStatus: 'netease-client:get-status',
  getSnapshot: 'netease-client:get-snapshot',
  playSong: 'netease-client:play-song',
  play: 'netease-client:play',
  pause: 'netease-client:pause',
  toggle: 'netease-client:toggle',
  next: 'netease-client:next',
  prev: 'netease-client:prev',
  seek: 'netease-client:seek',
  setVolume: 'netease-client:set-volume',
  status: 'netease-client:status',
  snapshot: 'netease-client:snapshot',
});
