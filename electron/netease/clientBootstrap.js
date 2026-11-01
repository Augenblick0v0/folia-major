// electron/netease/clientBootstrap.js
// Evaluated inside the NetEase PC client's orpheus page by clientControl.cjs. The file is read as
// text and never required: package.json has "type": "module", so importing it would parse page
// globals (window, fetch) as module top-level code.
//
// The whole file is one expression. Runtime.evaluate returns its value, which tells the main
// process which client APIs were found. Keep it self-contained: no imports, no module syntax.
(() => {
  const VERSION = 2;
  const existing = window.__foliaNetease;
  if (existing && existing.version === VERSION) {
    if (typeof existing.probe === 'function') existing.probe();
    return { reused: true, capabilities: existing.capabilities() };
  }

  const requireModule = window.__gpt_cm_require__;
  if (typeof requireModule !== 'function') {
    throw new Error('unsupported-client: window.__gpt_cm_require__ is not available');
  }

  const storeModule = () => {
    const loaded = requireModule(8);
    const app = loaded && loaded.a;
    if (!app || typeof app.getStore !== 'function' || !app.app || !app.app._store) {
      throw new Error('unsupported-client: the client store is not available');
    }
    return app;
  };

  const getStore = () => storeModule().getStore();
  const dispatch = (action) => storeModule().app._store.dispatch(action);

  const finite = (value) => typeof value === 'number' && Number.isFinite(value);
  const clamp01 = (value) => Math.min(1, Math.max(0, finite(value) ? value : 0));

  const details = new Map();
  let progressBound = false;
  let lastProgress = null;
  // A playSong can outlive the main process's evaluate timeout (the song-detail fetch is on the
  // page). cancelPlay bumps this; the play checks it before it is allowed to touch the store.
  let playToken = 0;

  const trackIdOf = (playing) => {
    const resourceId = playing && playing.curPlaying && playing.curPlaying.resourceId;
    const numeric = Number(resourceId);
    if (Number.isInteger(numeric) && numeric > 0) return numeric;
    const parsed = Number(String((playing && playing.playId) || '').split('_')[0]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };

  const capabilities = () => {
    let canDispatch = false;
    try {
      canDispatch = Boolean(storeModule() && typeof storeModule().app._store.dispatch === 'function');
    } catch (error) {
      canDispatch = false;
    }
    return {
      playById: canDispatch,
      transport: canDispatch,
      seek: canDispatch,
      setVolume: canDispatch,
      readProgress: progressBound,
      nativeSkip: canDispatch,
    };
  };

  const bindProgress = () => {
    if (progressBound) return;
    try {
      const audioModule = requireModule(4);
      const audioPlayer = audioModule && audioModule.AudioPlayer;
      if (!audioPlayer || typeof audioPlayer.subscribePlayStatus !== 'function') return;
      // subscribePlayStatus returns a Promise, so there is no synchronous unsubscribe. The guard
      // above (version 1 reuse) keeps a reconnect from subscribing a second time.
      audioPlayer.subscribePlayStatus({
        type: 'playprogress',
        callback: (...args) => {
          const data = args[0] || {};
          if (!finite(data.current)) return;
          lastProgress = {
            playId: typeof data.playId === 'string' ? data.playId : '',
            current: data.current,
            at: Date.now(),
          };
        },
      });
      progressBound = true;
    } catch (error) {
      // Progress is optional. Without it readAll() reports 0 and the renderer's clock extrapolates.
    }
  };

  const rememberDetails = (songs) => {
    songs.forEach((song) => {
      const id = Number(song && song.id);
      if (Number.isInteger(id) && id > 0) details.set(id, song);
    });
  };

  const metaOf = (playing, id) => {
    const cached = details.get(id) || null;
    const current = (playing && playing.curTrack) || null;
    const artistList = (cached && cached.ar) || (current && current.artists) || null;
    const artists = Array.isArray(artistList)
      ? artistList
        .map((artist) => (typeof artist === 'string' ? artist : artist && artist.name))
        .filter((name) => typeof name === 'string' && name.length > 0)
      : undefined;
    const album = (cached && cached.al && cached.al.name)
      || (cached && cached.album && cached.album.name)
      || (current && current.album && current.album.name)
      || undefined;
    return {
      name: (playing && playing.resourceName) || (current && current.name) || (cached && cached.name) || '',
      artists,
      album,
    };
  };

  const readAll = () => {
    bindProgress();
    let playing;
    try {
      playing = getStore().playing || {};
    } catch (error) {
      throw new Error('unsupported-client: ' + (error && error.message ? error.message : String(error)));
    }

    const id = trackIdOf(playing);
    let track = null;
    if (id !== null) {
      const meta = metaOf(playing, id);
      const cached = details.get(id);
      const detailDuration = cached && (cached.duration || cached.dt);
      const trackDuration = playing.curTrack && playing.curTrack.duration;
      const resourceDurationMs = finite(playing.resourceDuration) ? Math.round(playing.resourceDuration * 1000) : 0;
      const rawDuration = finite(detailDuration) ? detailDuration : (finite(trackDuration) ? trackDuration : 0);
      const durationMs = Math.max(0, Math.round(rawDuration)) || Math.max(0, resourceDurationMs);
      track = { id, name: meta.name, durationMs };
      if (meta.artists && meta.artists.length > 0) track.artists = meta.artists;
      if (meta.album) track.album = meta.album;
    }

    const playback = playing.playingState === 2 ? 'playing' : (playing.playingState === 1 ? 'paused' : 'stopped');
    let positionSec = 0;
    if (lastProgress && (id === null || !lastProgress.playId || String(lastProgress.playId).split('_')[0] === String(id))) {
      const elapsed = playback === 'playing' ? Math.max(0, Math.min(2, (Date.now() - lastProgress.at) / 1000)) : 0;
      positionSec = Math.max(0, lastProgress.current + elapsed);
    }
    const durationSec = finite(playing.resourceDuration)
      ? Math.max(0, playing.resourceDuration)
      : (track ? track.durationMs / 1000 : 0);

    return {
      track,
      playback,
      positionSec,
      durationSec,
      volume: clamp01(playing.playingVolume),
      capabilities: capabilities(),
    };
  };

  const playSong = async (songId, queueIds, startPositionSec) => {
    const token = ++playToken;
    const targetId = Number(songId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new Error('client-rejected: invalid song id');
    }
    const ids = Array.isArray(queueIds) && queueIds.length > 0
      ? queueIds.map((value) => Number(value))
      : [targetId];
    // The IPC layer already rejects a queue without the target. Keep the target present even when
    // the bootstrap is called directly: a playing/play without its track in `tracks` cannot play.
    if (ids.indexOf(targetId) < 0) ids.push(targetId);

    const response = await fetch(
      'https://music.163.com/api/song/detail/?ids=' + encodeURIComponent(JSON.stringify(ids)),
      { headers: { Referer: 'https://music.163.com/' } },
    );
    const payload = await response.json();
    if (token !== playToken) return false;
    const songs = payload && Array.isArray(payload.songs) ? payload.songs : [];
    rememberDetails(songs);
    const tracks = ids
      .map((id) => songs.find((song) => song && Number(song.id) === id))
      .filter(Boolean);
    if (tracks.length === 0) throw new Error('song-detail-empty');
    const targetIndex = tracks.findIndex((track) => Number(track.id) === targetId);
    if (targetIndex < 0) throw new Error('song-detail-empty');

    // tracks must carry the complete song objects; an array of { id } changes the store but the
    // native player keeps playing the previous track (measured in the client probe).
    await dispatch({
      type: 'playing/play',
      payload: {
        tracks,
        from: {
          text: 'folia',
          href: '',
          resourceType: 'track',
          scene: 'search',
          fromInfo: {
            originalScene: 'search',
            originalResourceType: 'track',
            computeSourceResourceType: 'track',
            sourceData: {},
          },
        },
        options: { clear: true, play: true, playId: targetId, offset: targetIndex },
        triggerScene: 'search',
        triggerAction: 'playAll',
      },
    });

    if (token !== playToken) {
      // The request timed out in the main process while this fetch was in flight. Do not start
      // the track now; the UI has already been told the play failed.
      await dispatch({ type: 'playing/pause' });
      return false;
    }

    if (finite(startPositionSec) && startPositionSec > 0) {
      await dispatch({ type: 'playing/setPlayingPosition', payload: { duration: startPositionSec } });
    }
    lastProgress = {
      playId: targetId + '_',
      current: finite(startPositionSec) && startPositionSec > 0 ? startPositionSec : 0,
      at: Date.now(),
    };
    return true;
  };

  const play = async () => {
    await dispatch({ type: 'playing/resume' });
    return true;
  };

  const pause = async () => {
    await dispatch({ type: 'playing/pause' });
    return true;
  };

  const cancelPlay = () => {
    playToken += 1;
    return true;
  };

  const toggle = async () => {
    const playing = getStore().playing || {};
    await dispatch({ type: playing.playingState === 2 ? 'playing/pause' : 'playing/resume' });
    return true;
  };

  const skip = async (flag) => {
    await dispatch({
      type: 'playingList/jump2Track',
      payload: { flag, type: 'call', triggerScene: 'playlist' },
    });
    return true;
  };

  const seek = async (seconds) => {
    const value = Number(seconds);
    if (!finite(value) || value < 0) throw new Error('client-rejected: invalid seek position');
    await dispatch({ type: 'playing/setPlayingPosition', payload: { duration: value } });
    lastProgress = { playId: '', current: value, at: Date.now() };
    return true;
  };

  const setVolume = async (volume) => {
    const value = Number(volume);
    if (!finite(value)) throw new Error('client-rejected: invalid volume');
    await dispatch({ type: 'playing/setVolume', payload: { volume: clamp01(value) } });
    return true;
  };

  window.__foliaNetease = {
    version: VERSION,
    probe: bindProgress,
    capabilities,
    readAll,
    playSong,
    cancelPlay,
    play,
    pause,
    resume: play,
    toggle,
    next: () => skip(1),
    prev: () => skip(-1),
    seek,
    setVolume,
  };

  bindProgress();
  return { installed: true, capabilities: capabilities() };
})()
