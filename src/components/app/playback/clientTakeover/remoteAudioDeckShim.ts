import type { ClientTakeoverError, ClientTakeoverService, ClientTakeoverSnapshot, ClientTakeoverStatus } from '../../../../services/clientTakeover';

// src/components/app/playback/clientTakeover/remoteAudioDeckShim.ts
//
// An HTMLAudioElement-shaped view over the desktop client, installed on the two real decks the app
// already renders. App's media event handlers, the media session bridge and the transport keep
// working unchanged: they read `paused`/`duration`/`currentTime` from this view and receive the
// events they already listen for. The element itself keeps its src (a per-song silent data URI),
// so React's load lifecycle runs as usual.

export interface RemoteAudioDeckShim {
    attach(): void;
    detach(): void;
}

type ShimDeps = {
    service: ClientTakeoverService;
    getCurrentTakeoverSongId: () => number | null;
    getQueueIds: () => number[];
    /** A failed client command must be told, not only swallowed: the sound is still coming out. */
    onCommandError?: (error: ClientTakeoverError) => void;
};

type SavedProperty = {
    descriptor: PropertyDescriptor | undefined;
};

const TIMEUPDATE_INTERVAL_MS = 500;
const ENDED_SETTLE_DELAY_MS = 1200;
const SEEK_DISTANCE_THRESHOLD_SEC = 2;

const clampVolume = (value: number): number => Math.min(1, Math.max(0, value));

const sameTrack = (left: ClientTakeoverSnapshot | null, right: ClientTakeoverSnapshot | null): boolean => (
    (left?.track?.id ?? null) === (right?.track?.id ?? null)
);

/**
 * Installs the shim on one deck. `attach` is idempotent; `detach` puts every own property back the
 * way it was, falling through to the element's prototype again.
 */
export const createRemoteAudioDeckShim = (
    element: HTMLAudioElement,
    deps: ShimDeps,
): RemoteAudioDeckShim => {
    const saved = new Map<string, SavedProperty>();
    let attached = false;
    let snapshot: ClientTakeoverSnapshot | null = null;
    let previousSnapshot: ClientTakeoverSnapshot | null = null;
    let desiredVolume = 1;
    let muted = false;
    let lastTimeUpdateAt = 0;
    let lastPositionSec = 0;
    let lastPositionAt = 0;
    let endedTimer: ReturnType<typeof setTimeout> | null = null;
    let removeSnapshotListener: (() => void) | null = null;
    let removeStatusListener: (() => void) | null = null;
    let lastStatus: ClientTakeoverStatus['status'] = 'disconnected';
    let needsResumeEvent = false;

    const dispatch = (type: string) => {
        try {
            element.dispatchEvent(new Event(type));
        } catch (error) {
            console.warn(`[ClientTakeover] could not dispatch ${type}`, error);
        }
    };

    const clearEndedTimer = () => {
        if (endedTimer !== null) {
            clearTimeout(endedTimer);
            endedTimer = null;
        }
    };

    const currentPaused = () => !deps.service.isConnected() || snapshot?.playback !== 'playing';
    const currentDuration = () => snapshot?.durationSec ?? 0;
    const currentPosition = () => deps.service.getPositionSec();
    const currentEnded = () => (
        snapshot?.playback === 'stopped'
        && currentDuration() > 0
        && currentPosition() >= currentDuration() - 1
    );

    const scheduleEnded = () => {
        clearEndedTimer();
        const trackId = snapshot?.track?.id ?? null;
        endedTimer = setTimeout(() => {
            endedTimer = null;
            if (snapshot?.track?.id !== trackId || snapshot.playback !== 'stopped') return;
            // A client that really stops at the end: the app's own ended handling advances the
            // queue. A client that moves to the next track cancels this timer before it fires.
            dispatch('pause');
            dispatch('ended');
        }, ENDED_SETTLE_DELAY_MS);
    };

    const handleStatus = (status: ClientTakeoverStatus) => {
        const wasConnected = lastStatus === 'connected';
        lastStatus = status.status;
        if (status.status === 'connected') {
            // The snapshot that follows a reconnect has the same track and playback as the one
            // before the drop; only a synthesized play/playing tells the transport to resume.
            if (!wasConnected) needsResumeEvent = true;
            return;
        }
        clearEndedTimer();
        if (wasConnected && previousSnapshot?.playback === 'playing') {
            // The client went away mid-track: let the app settle on PAUSED instead of leaving the
            // transport stuck on a deck that is no longer reporting.
            dispatch('pause');
        }
    };

    const handleSnapshot = (next: ClientTakeoverSnapshot) => {
        if (next.revision <= (snapshot?.revision ?? -1)) return;
        const prior = snapshot;
        const trackChanged = !sameTrack(prior, next);
        // Publish the snapshot before any event: loadedmetadata/durationchange handlers read
        // `element.duration`, and on a track change that must be the new track's duration. With
        // the assignment at the end of this function they clamped a pending resume to the old
        // track's length and cleared it.
        snapshot = next;
        const now = Date.now();

        if (trackChanged && next.track) {
            clearEndedTimer();
            dispatch('loadedmetadata');
            dispatch('durationchange');
            dispatch('canplay');
            dispatch('timeupdate');
            if (next.playback === 'playing') {
                needsResumeEvent = false;
                dispatch('play');
                dispatch('playing');
            } else {
                dispatch('pause');
            }
            lastTimeUpdateAt = now;
            lastPositionSec = deps.service.getPositionSec(now);
            lastPositionAt = now;
        } else if (prior && prior.playback !== next.playback) {
            if (prior.playback === 'playing' && next.playback === 'paused') {
                dispatch('pause');
            } else if (prior.playback === 'paused' && next.playback === 'playing') {
                dispatch('play');
                dispatch('playing');
            }
        }

        if (next.playback === 'playing') {
            clearEndedTimer();
            if (needsResumeEvent) {
                needsResumeEvent = false;
                dispatch('play');
                dispatch('playing');
            }
            const expectedPosition = lastPositionSec + (
                prior?.playback === 'playing' ? Math.max(0, (now - lastPositionAt) / 1000) : 0
            );
            const actualPosition = deps.service.getPositionSec(now);
            if (Math.abs(actualPosition - expectedPosition) > SEEK_DISTANCE_THRESHOLD_SEC) {
                dispatch('seeked');
            }
            if (now - lastTimeUpdateAt >= TIMEUPDATE_INTERVAL_MS) {
                lastTimeUpdateAt = now;
                dispatch('timeupdate');
            }
            lastPositionSec = actualPosition;
            lastPositionAt = now;
        } else if (!trackChanged) {
            lastPositionSec = deps.service.getPositionSec(now);
            lastPositionAt = now;
        }

        if (
            !trackChanged
            && prior?.playback === 'playing'
            && next.playback === 'stopped'
            && next.durationSec > 0
            && deps.service.getPositionSec(now) >= next.durationSec - 1
        ) {
            scheduleEnded();
        } else if (next.playback !== 'stopped') {
            clearEndedTimer();
        }

        if (Number.isFinite(next.volume)) {
            desiredVolume = clampVolume(next.volume);
        }
        previousSnapshot = next;
        snapshot = next;
    };

    const define = (name: string, descriptor: PropertyDescriptor) => {
        if (!saved.has(name)) {
            saved.set(name, { descriptor: Object.getOwnPropertyDescriptor(element, name) });
        }
        Object.defineProperty(element, name, { configurable: true, enumerable: true, ...descriptor });
    };

    const restore = (name: string) => {
        const entry = saved.get(name);
        if (!entry) return;
        saved.delete(name);
        if (entry.descriptor) Object.defineProperty(element, name, entry.descriptor);
        else delete (element as unknown as Record<string, unknown>)[name];
    };

    const play = (): Promise<void> => {
        const currentId = deps.getCurrentTakeoverSongId();
        if (currentId === null) return Promise.resolve();
        const current = deps.service.getSnapshotSync() ?? snapshot;
        const playCurrent = async () => {
            const queueIds = deps.getQueueIds();
            const input = queueIds.length > 0
                ? { songId: currentId, queueIds }
                : { songId: currentId };
            const result = await deps.service.playSong(input);
            if (!result.ok) throw new Error(result.error.message);
        };
        const run = async () => {
            // `pause()` deliberately leaves the client's track in place. A stale snapshot therefore
            // names the previous song, and starting it again would undo a track Folia just chose.
            if (!current?.track || current.track.id !== currentId) {
                await playCurrent();
            }
            const result = await deps.service.play();
            if (!result.ok) throw new Error(result.error.message);
        };
        return run();
    };

    const pause = (): void => {
        void deps.service.pause().then((result) => {
            if (result.ok) return;
            // The transport has already shown PAUSED; the client kept sounding. Tell the listener,
            // and put the transport back on PLAYING while the client still reports that it plays.
            deps.onCommandError?.(result.error);
            if (deps.service.getSnapshotSync()?.playback === 'playing') {
                dispatch('play');
                dispatch('playing');
            }
        }).catch((error: unknown) => {
            console.warn('[ClientTakeover] pause command failed', error);
        });
        const ownPause = saved.get('pause')?.descriptor?.value as (() => void) | undefined;
        const nativePause = ownPause ?? (
            typeof HTMLMediaElement !== 'undefined' ? HTMLMediaElement.prototype.pause : undefined
        );
        if (typeof nativePause === 'function') nativePause.call(element);
    };

    const attach = () => {
        if (attached) return;
        attached = true;
        snapshot = deps.service.getSnapshotSync();
        previousSnapshot = snapshot;
        desiredVolume = snapshot && Number.isFinite(snapshot.volume) ? clampVolume(snapshot.volume) : 1;
        lastStatus = deps.service.isConnected() ? 'connected' : 'disconnected';
        lastPositionSec = deps.service.getPositionSec();
        lastPositionAt = Date.now();

        define('currentTime', {
            get: currentPosition,
            set: (value: number) => {
                if (!Number.isFinite(value) || value < 0) return;
                if (!snapshot?.capabilities.seek) return;
                dispatch('seeking');
                lastPositionSec = value;
                lastPositionAt = Date.now();
                void deps.service.seek(value).then((result) => {
                    if (!result.ok) return;
                    snapshot = result.snapshot;
                    dispatch('seeked');
                });
            },
        });
        define('duration', { get: currentDuration });
        define('paused', { get: currentPaused });
        define('ended', { get: currentEnded });
        define('volume', {
            get: () => desiredVolume,
            set: (value: number) => {
                if (!Number.isFinite(value)) return;
                desiredVolume = clampVolume(value);
                void deps.service.setVolume(muted ? 0 : desiredVolume);
            },
        });
        define('muted', {
            get: () => muted,
            set: (value: boolean) => {
                muted = Boolean(value);
                void deps.service.setVolume(muted ? 0 : desiredVolume);
            },
        });
        define('error', { get: () => null });
        define('readyState', { get: () => (snapshot?.track ? 4 : 0) });
        define('networkState', { get: () => 1 });
        define('play', { value: play, writable: true });
        define('pause', { value: pause, writable: true });
        define('load', { value: () => undefined, writable: true });

        removeSnapshotListener = deps.service.subscribe(handleSnapshot);
        removeStatusListener = deps.service.subscribeStatus(handleStatus);

        if (snapshot?.status === 'connected' && snapshot.track) {
            needsResumeEvent = false;
            dispatch('loadedmetadata');
            dispatch('durationchange');
            if (snapshot.playback === 'playing') {
                dispatch('play');
                dispatch('playing');
            }
        }
    };

    const detach = () => {
        if (!attached) return;
        attached = false;
        clearEndedTimer();
        removeSnapshotListener?.();
        removeStatusListener?.();
        removeSnapshotListener = null;
        removeStatusListener = null;
        ['currentTime', 'duration', 'paused', 'ended', 'volume', 'muted', 'error', 'readyState', 'networkState', 'play', 'pause', 'load']
            .forEach(restore);
        snapshot = null;
        previousSnapshot = null;
    };

    return { attach, detach };
};
