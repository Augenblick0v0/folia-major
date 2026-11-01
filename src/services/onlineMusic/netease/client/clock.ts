// src/services/onlineMusic/netease/client/clock.ts
// The renderer clock for a client that reports its position only a few times a second. Between
// snapshots the position is extrapolated; a snapshot re-anchors it only when the track changed,
// playback started or stopped, or the client's own position drifted far enough to be a seek.

import type { NeteaseClientClockAnchor, NeteaseClientSnapshot } from './types';

export type { NeteaseClientClockAnchor } from './types';

/** A drift this small is sampling jitter, not a seek: keep the old anchor. */
export const CLOCK_DRIFT_TOLERANCE_SEC = 1.5;

export const clampPositionSec = (positionSec: number, durationSec: number): number => {
    const position = Number.isFinite(positionSec) ? Math.max(0, positionSec) : 0;
    if (Number.isFinite(durationSec) && durationSec > 0) {
        return Math.min(durationSec, position);
    }
    return position;
};

/** Where the track is at `nowMs`, from the anchor plus the time spent playing since it was taken. */
export const extrapolatePosition = (anchor: NeteaseClientClockAnchor, nowMs: number): number => {
    const elapsed = anchor.playing ? Math.max(0, (nowMs - anchor.anchoredAtMs) / 1000) : 0;
    return clampPositionSec(anchor.positionSec + elapsed, anchor.durationSec);
};

/** The anchor a snapshot describes, with no extrapolation in between. */
export const anchorFromSnapshot = (snapshot: NeteaseClientSnapshot, nowMs: number): NeteaseClientClockAnchor => {
    const durationSec = Number.isFinite(snapshot.durationSec) && snapshot.durationSec > 0
        ? Math.max(0, snapshot.durationSec)
        : Math.max(0, (snapshot.track?.durationMs ?? 0) / 1000);
    return {
        trackId: snapshot.track?.id ?? null,
        positionSec: clampPositionSec(snapshot.positionSec, durationSec),
        anchoredAtMs: nowMs,
        playing: snapshot.playback === 'playing',
        durationSec,
    };
};

/**
 * The next anchor after a snapshot.
 *
 * A different track starts over at the snapshot's position. On the same track, a position within
 * the drift tolerance while playback did not change keeps the old anchor (and its `anchoredAtMs`),
 * so two snapshots a second do not make the clock stutter; anything bigger is the listener seeking,
 * or the client seeking for them, and is adopted whole.
 */
export const reanchor = (
    anchor: NeteaseClientClockAnchor | null,
    snapshot: NeteaseClientSnapshot,
    nowMs: number,
): NeteaseClientClockAnchor => {
    const next = anchorFromSnapshot(snapshot, nowMs);
    if (!anchor || anchor.trackId !== next.trackId) {
        return next;
    }

    const expected = extrapolatePosition(anchor, nowMs);
    if (anchor.playing === next.playing && Math.abs(expected - next.positionSec) <= CLOCK_DRIFT_TOLERANCE_SEC) {
        return {
            ...anchor,
            durationSec: next.durationSec || anchor.durationSec,
        };
    }

    return next;
};
