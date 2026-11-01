// src/services/onlineMusic/netease/client/playback.ts
// Which songs the desktop-client engine can play, and the client's queue window around one of
// them. Pure: no bridge, no store, so the App and the queue controller can ask anywhere.

import type { SongResult } from '../../../../types';
import { getPlaybackSourceRef } from '../../../../utils/appPlaybackGuards';
import type { NeteaseClientTrack } from './types';

/** The client plays catalogue tracks by number; its own queue request is capped at this many. */
export const CLIENT_QUEUE_MAX = 100;

/**
 * A song the desktop client can be asked to play.
 *
 * Cloud-disk tracks are excluded exactly where the listening report excludes them
 * (`neteaseProvider.ts` `canReport`): an unmatched upload carries an id that names no catalogue
 * track, so neither `song/detail` nor `playing/play` can resolve it.
 */
export const isNeteaseOnlineSong = (song: SongResult | null | undefined): boolean => {
    if (!song) return false;
    const source = getPlaybackSourceRef(song);
    return source.kind === 'online'
        && source.providerId === 'netease'
        && source.variant !== 'cloud'
        && /^\d+$/.test(source.mediaId)
        && Number(source.mediaId) > 0;
};

/**
 * Up to 100 ids around the target, in queue order.
 *
 * The target is kept inside the window even at either end of the queue; when it is not a song the
 * client can play, the window is just the target so the caller still sends a valid request (the
 * IPC layer refuses a queue without the target).
 */
export const buildClientQueueIds = (queue: SongResult[], targetSongId: number): number[] => {
    const ids = queue
        .filter(isNeteaseOnlineSong)
        .map(song => Number(getPlaybackSourceRef(song).mediaId));
    const unique = [...new Set(ids)];
    const target = unique.indexOf(targetSongId);
    if (target < 0) return [targetSongId];
    const start = Math.max(0, Math.min(target - CLIENT_QUEUE_MAX / 2, unique.length - CLIENT_QUEUE_MAX));
    return unique.slice(start, start + CLIENT_QUEUE_MAX);
};

/**
 * A catalogue track the client reports as current, shaped like a queue song so a track it started
 * outside Folia's queue can still become the shown song and get its lyrics. The client knows only
 * id, name, artists and album; anything else comes from the lyric and cover caches.
 */
export const buildClientTakeoverSong = (track: NeteaseClientTrack): SongResult => ({
    id: track.id,
    name: track.name || `Track ${track.id}`,
    artists: (track.artists ?? []).map((name, index) => ({
        id: `client-artist-${track.id}-${index}`,
        name,
    })),
    album: { id: `client-album-${track.id}`, name: track.album ?? '' },
    durationMs: track.durationMs,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: String(track.id) },
});
