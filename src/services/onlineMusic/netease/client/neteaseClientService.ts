// src/services/onlineMusic/netease/client/neteaseClientService.ts
// The renderer's single view of the desktop-client takeover. It owns the snapshot cache, the
// extrapolated clock and the command surface; the preload bridge is the only thing that talks to
// the main process, and every failure is a value rather than a rejected promise.

import {
    clampPositionSec,
    extrapolatePosition,
    reanchor,
} from './clock';
import { NO_CAPABILITIES } from './types';
import type {
    NeteaseClientCapabilities,
    NeteaseClientClockAnchor,
    NeteaseClientCommandResult,
    NeteaseClientError,
    NeteaseClientPlaySongInput,
    NeteaseClientPreloadApi,
    NeteaseClientSnapshot,
    NeteaseClientStatus,
} from './types';

export type { NeteaseClientClockAnchor } from './types';

// The shared facade imports these aliases from here, keeping the platform name in one place.
export {
    isNeteaseOnlineSong as isClientTakeoverSong,
    buildClientQueueIds as buildClientTakeoverQueueIds,
    buildClientTakeoverSong,
} from './playback';
export { buildClientTakeoverDeckSrc } from './deckSrc';

const CLIENT_PORT = 9223 as const;

type CapabilityKey = keyof NeteaseClientCapabilities;

const unavailableStatus = (message: string): NeteaseClientStatus => ({
    status: 'disconnected',
    clientVersion: null,
    port: CLIENT_PORT,
    capabilities: NO_CAPABILITIES,
    error: { code: 'not-connected', message },
});

const notConnectedResult = (): NeteaseClientCommandResult => ({
    ok: false,
    error: { code: 'not-connected', message: 'The desktop client is not connected' },
});

const invalidArgument = (message: string): NeteaseClientCommandResult => ({
    ok: false,
    error: { code: 'invalid-argument', message },
});

const errorFromException = (error: unknown, fallback: NeteaseClientError['code']): NeteaseClientError => {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const text = message || 'The desktop client request failed';
    if (/client-rejected/i.test(text)) return { code: 'client-rejected', message: text };
    if (/unsupported-client/i.test(text)) return { code: 'unsupported-client', message: text };
    if (/song-detail-empty/i.test(text)) return { code: 'song-detail-empty', message: text };
    if (/timeout/i.test(text)) return { code: 'evaluate-timeout', message: text };
    return { code: fallback, message: text };
};

/**
 * The bridge preload exposes, read without teaching the global type about it here: the preload
 * task owns `Window.electron`'s declaration, and this service must also compile on its own.
 */
const readDefaultBridge = (): NeteaseClientPreloadApi | undefined => {
    if (typeof window === 'undefined') return undefined;
    const host = window.electron as unknown as { neteaseClient?: NeteaseClientPreloadApi } | undefined;
    return host?.neteaseClient;
};

export interface NeteaseClientService {
    readonly available: boolean;
    connect(options?: { force?: boolean }): Promise<NeteaseClientStatus>;
    disconnect(options?: { pauseFirst?: boolean }): Promise<NeteaseClientStatus>;
    getStatus(): Promise<NeteaseClientStatus>;
    getSnapshot(): Promise<NeteaseClientSnapshot | null>;
    getSnapshotSync(): NeteaseClientSnapshot | null;

    playSong(input: NeteaseClientPlaySongInput): Promise<NeteaseClientCommandResult>;
    play(): Promise<NeteaseClientCommandResult>;
    pause(): Promise<NeteaseClientCommandResult>;
    toggle(): Promise<NeteaseClientCommandResult>;
    next(): Promise<NeteaseClientCommandResult>;
    prev(): Promise<NeteaseClientCommandResult>;
    seek(positionSec: number): Promise<NeteaseClientCommandResult>;
    setVolume(volume: number): Promise<NeteaseClientCommandResult>;

    subscribe(listener: (snapshot: NeteaseClientSnapshot) => void): () => void;
    subscribeStatus(listener: (status: NeteaseClientStatus) => void): () => void;
    getPositionSec(nowMs?: number): number;
    getClockAnchor(): NeteaseClientClockAnchor | null;
    isConnected(): boolean;
    markExpectedTrack(songId: number): void;
    consumeExpectedTrack(trackId: number): boolean;
    dispose(): void;
}

export const createNeteaseClientService = (
    bridge: NeteaseClientPreloadApi | undefined,
): NeteaseClientService => {
    let lastRevision = -1;
    let snapshotCache: NeteaseClientSnapshot | null = null;
    let clockAnchor: NeteaseClientClockAnchor | null = null;
    let lastStatus: NeteaseClientStatus = bridge
        ? {
            status: 'disconnected',
            clientVersion: null,
            port: CLIENT_PORT,
            capabilities: NO_CAPABILITIES,
            error: null,
        }
        : unavailableStatus('The desktop client takeover is unavailable outside the desktop app');
    let expectedTrackId: number | null = null;
    let connectPromise: Promise<NeteaseClientStatus> | null = null;
    let listenersAttached = false;
    let detachStatus: (() => void) | null = null;
    let detachSnapshot: (() => void) | null = null;

    const snapshotListeners = new Set<(snapshot: NeteaseClientSnapshot) => void>();
    const statusListeners = new Set<(status: NeteaseClientStatus) => void>();

    const emitStatus = (status: NeteaseClientStatus) => {
        statusListeners.forEach((listener) => {
            try {
                listener(status);
            } catch (error) {
                console.warn('[ClientTakeover] a status listener threw', error);
            }
        });
    };

    const emitSnapshot = (snapshot: NeteaseClientSnapshot) => {
        snapshotListeners.forEach((listener) => {
            try {
                listener(snapshot);
            } catch (error) {
                console.warn('[ClientTakeover] a snapshot listener threw', error);
            }
        });
    };

    const rememberStatus = (status: NeteaseClientStatus, notify: boolean) => {
        lastStatus = status;
        if (status.status !== 'connected') {
            // A disconnected / connecting / error bridge has no current track. Keeping the last
            // connected snapshot here let a shim attach after a disconnect and replay the old song.
            snapshotCache = null;
            clockAnchor = null;
        }
        if (notify) emitStatus(status);
    };

    /** The only place a snapshot enters: an older revision must never move the clock backwards. */
    const ingestSnapshot = (snapshot: NeteaseClientSnapshot): boolean => {
        if (!snapshot || !Number.isFinite(snapshot.revision) || snapshot.revision <= lastRevision) {
            return false;
        }
        lastRevision = snapshot.revision;
        const now = Date.now();
        clockAnchor = reanchor(clockAnchor, snapshot, now);
        snapshotCache = snapshot;
        if (snapshot.status !== 'connected') {
            snapshotCache = null;
            clockAnchor = null;
        }
        lastStatus = {
            ...lastStatus,
            status: snapshot.status,
            clientVersion: snapshot.clientVersion ?? lastStatus.clientVersion,
            capabilities: snapshot.status === 'connected' ? snapshot.capabilities : NO_CAPABILITIES,
            error: snapshot.error,
        };
        emitSnapshot(snapshot);
        return true;
    };

    const degradeCapability = (key: CapabilityKey) => {
        if (!lastStatus.capabilities[key]) return;
        const capabilities = { ...lastStatus.capabilities, [key]: false };
        lastStatus = { ...lastStatus, capabilities };
        if (snapshotCache) snapshotCache = { ...snapshotCache, capabilities };
        emitStatus(lastStatus);
    };

    const ensureListeners = () => {
        if (listenersAttached || !bridge) return;
        listenersAttached = true;
        detachStatus = bridge.onStatusChanged((status) => rememberStatus(status, true));
        detachSnapshot = bridge.onSnapshot(ingestSnapshot);
    };

    const runCommand = (
        capability: CapabilityKey,
        call: (api: NeteaseClientPreloadApi) => Promise<NeteaseClientCommandResult>,
    ): Promise<NeteaseClientCommandResult> => {
        if (!bridge) return Promise.resolve(notConnectedResult());
        try {
            return call(bridge).then(
                (result) => {
                    if (result.ok) {
                        ingestSnapshot(result.snapshot);
                    } else {
                        degradeCapability(capability);
                    }
                    return result;
                },
                (error: unknown) => {
                    degradeCapability(capability);
                    return { ok: false, error: errorFromException(error, 'websocket-error') } as const;
                },
            );
        } catch (error) {
            degradeCapability(capability);
            return Promise.resolve({ ok: false, error: errorFromException(error, 'websocket-error') } as const);
        }
    };

    const service: NeteaseClientService = {
        available: Boolean(bridge),

        connect(options) {
            if (!bridge) return Promise.resolve(lastStatus);
            if (connectPromise) return connectPromise;
            const api = bridge;

            const run = async (): Promise<NeteaseClientStatus> => {
                try {
                    if (options?.force) {
                        await api.disconnect({ pauseFirst: false }).catch(() => undefined);
                    }
                    const status = await api.connect(options ? { force: options.force } : undefined);
                    rememberStatus(status, true);
                    if (status.status === 'connected') {
                        const snapshot = await api.getSnapshot().catch(() => null);
                        if (snapshot) ingestSnapshot(snapshot);
                    }
                    return status;
                } catch (error) {
                    const failed: NeteaseClientStatus = {
                        ...unavailableStatus('Could not connect to the desktop client'),
                        status: 'error',
                        error: errorFromException(error, 'cdp-unreachable'),
                    };
                    rememberStatus(failed, true);
                    return failed;
                }
            };

            connectPromise = run().finally(() => {
                connectPromise = null;
            });
            return connectPromise;
        },

        async disconnect(options) {
            if (!bridge) return lastStatus;
            try {
                if (options?.pauseFirst) {
                    await runCommand('transport', api => api.pause());
                }
                const status = await bridge.disconnect();
                rememberStatus(status, true);
                return status;
            } catch (error) {
                const failed: NeteaseClientStatus = {
                    ...unavailableStatus('Could not disconnect the desktop client'),
                    status: 'error',
                    error: errorFromException(error, 'websocket-error'),
                };
                rememberStatus(failed, true);
                return failed;
            }
        },

        async getStatus() {
            if (!bridge) return lastStatus;
            try {
                const status = await bridge.getStatus();
                rememberStatus(status, true);
                return status;
            } catch (error) {
                // A failed status read is not a connected client: no old capability may survive
                // into an error state (the contract reserves NO_CAPABILITIES for every non-connected
                // state, so a dead bridge cannot keep advertising seek).
                const failed: NeteaseClientStatus = {
                    status: 'error',
                    clientVersion: null,
                    port: CLIENT_PORT,
                    capabilities: NO_CAPABILITIES,
                    error: errorFromException(error, 'cdp-unreachable'),
                };
                rememberStatus(failed, true);
                return failed;
            }
        },

        async getSnapshot() {
            if (!bridge || lastStatus.status !== 'connected') return null;
            try {
                const snapshot = await bridge.getSnapshot();
                if (!snapshot) {
                    snapshotCache = null;
                    return null;
                }
                ingestSnapshot(snapshot);
                return snapshotCache;
            } catch (error) {
                console.warn('[ClientTakeover] could not read the client snapshot', error);
                return lastStatus.status === 'connected' ? snapshotCache : null;
            }
        },

        getSnapshotSync: () => snapshotCache,

        playSong(input) {
            if (!bridge) return Promise.resolve(notConnectedResult());
            if (!Number.isInteger(input?.songId) || input.songId <= 0) {
                return Promise.resolve(invalidArgument('songId must be a positive integer'));
            }
            if (input.queueIds && (!Array.isArray(input.queueIds) || input.queueIds.length > 100)) {
                return Promise.resolve(invalidArgument('queueIds must be an array of at most 100 ids'));
            }
            if (input.queueIds && input.queueIds.some(id => !Number.isInteger(id) || id <= 0)) {
                return Promise.resolve(invalidArgument('queueIds must contain positive integers'));
            }
            if (input.queueIds && !input.queueIds.includes(input.songId)) {
                return Promise.resolve(invalidArgument('queueIds must contain songId'));
            }
            const queueIds = input.queueIds ? [...new Set(input.queueIds)] : undefined;
            expectedTrackId = input.songId;
            return runCommand('playById', api => api.playSong(queueIds ? { ...input, queueIds } : input));
        },

        play: () => runCommand('transport', api => api.play()),
        pause: () => runCommand('transport', api => api.pause()),
        toggle: () => runCommand('transport', api => api.toggle()),
        next: () => runCommand('nativeSkip', api => api.next()),
        prev: () => runCommand('nativeSkip', api => api.prev()),

        seek(positionSec) {
            if (!bridge) return Promise.resolve(notConnectedResult());
            if (!Number.isFinite(positionSec) || positionSec < 0) {
                return Promise.resolve(invalidArgument('positionSec must be a non-negative finite number'));
            }
            const duration = snapshotCache?.durationSec ?? clockAnchor?.durationSec ?? 0;
            const target = clampPositionSec(positionSec, duration);
            const previousAnchor = clockAnchor;
            const trackId = snapshotCache?.track?.id ?? previousAnchor?.trackId ?? null;
            if (trackId !== null) {
                clockAnchor = {
                    trackId,
                    positionSec: target,
                    anchoredAtMs: Date.now(),
                    playing: snapshotCache ? snapshotCache.playback === 'playing' : previousAnchor?.playing ?? false,
                    durationSec: duration || previousAnchor?.durationSec || 0,
                };
            }
            return runCommand('seek', api => api.seek(target)).then((result) => {
                if (!result.ok) clockAnchor = previousAnchor;
                return result;
            }, (error: unknown) => {
                clockAnchor = previousAnchor;
                return { ok: false, error: errorFromException(error, 'websocket-error') } as const;
            });
        },

        setVolume(volume) {
            if (!bridge) return Promise.resolve(notConnectedResult());
            if (!Number.isFinite(volume)) {
                return Promise.resolve(invalidArgument('volume must be a finite number'));
            }
            const target = Math.min(1, Math.max(0, volume));
            return runCommand('setVolume', api => api.setVolume(target));
        },

        subscribe(listener) {
            ensureListeners();
            snapshotListeners.add(listener);
            return () => {
                snapshotListeners.delete(listener);
            };
        },

        subscribeStatus(listener) {
            ensureListeners();
            statusListeners.add(listener);
            return () => {
                statusListeners.delete(listener);
            };
        },

        getPositionSec(nowMs = Date.now()) {
            return clockAnchor ? extrapolatePosition(clockAnchor, nowMs) : 0;
        },

        getClockAnchor() {
            return clockAnchor ? { ...clockAnchor } : null;
        },

        isConnected: () => lastStatus.status === 'connected',

        markExpectedTrack(songId) {
            if (Number.isInteger(songId) && songId > 0) expectedTrackId = songId;
        },

        consumeExpectedTrack(trackId) {
            if (expectedTrackId === null || expectedTrackId !== trackId) return false;
            expectedTrackId = null;
            return true;
        },

        dispose() {
            snapshotListeners.clear();
            statusListeners.clear();
            detachStatus?.();
            detachSnapshot?.();
            detachStatus = null;
            detachSnapshot = null;
            listenersAttached = false;
        },
    };

    return service;
};

export const isClientTakeoverAvailable = (): boolean => readDefaultBridge() !== undefined;

export const neteaseClientService: NeteaseClientService = createNeteaseClientService(readDefaultBridge());
