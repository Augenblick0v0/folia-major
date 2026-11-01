// src/services/onlineMusic/netease/client/types.ts
// The wire contract between the renderer and the NetEase PC client takeover in the main process.
// Everything here crosses the preload bridge; nothing in this file touches the client itself.

export type NeteaseClientConnectionState =
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'error';

export type NeteaseClientPlaybackState = 'playing' | 'paused' | 'stopped';

export interface NeteaseClientCapabilities {
    playById: boolean;
    transport: boolean;
    seek: boolean;
    setVolume: boolean;
    readProgress: boolean;
    nativeSkip: boolean;
}

/** Every capability false: the answer while no client is connected, and before bootstrap. */
export const NO_CAPABILITIES: NeteaseClientCapabilities = Object.freeze({
    playById: false,
    transport: false,
    seek: false,
    setVolume: false,
    readProgress: false,
    nativeSkip: false,
});

export interface NeteaseClientError {
    code:
        | 'cdp-unreachable'
        | 'page-target-missing'
        | 'unsupported-client'
        | 'websocket-error'
        | 'evaluate-timeout'
        | 'client-rejected'
        | 'song-detail-empty'
        | 'not-connected'
        | 'invalid-argument'
        | 'untrusted';
    message: string;
}

export interface NeteaseClientTrack {
    id: number;
    name: string;
    /** resourceDuration（秒）或 curPlaying.track.duration（毫秒）换算；未知为 0 */
    durationMs: number;
    /** 客户端 store 或本次 song/detail 缓存有才填；UI 反射以 omni.getSongDetail 为准 */
    artists?: string[];
    album?: string;
}

/** The renderer's extrapolation state for one snapshot; see clock.ts. */
export interface NeteaseClientClockAnchor {
    trackId: number | null;
    positionSec: number;
    anchoredAtMs: number;
    playing: boolean;
    durationSec: number;
}

export interface NeteaseClientSnapshot {
    revision: number;
    status: NeteaseClientConnectionState;
    clientVersion: string | null;
    track: NeteaseClientTrack | null;
    playback: NeteaseClientPlaybackState;
    positionSec: number;
    sampledAt: number;
    durationSec: number;
    volume: number;
    capabilities: NeteaseClientCapabilities;
    error: NeteaseClientError | null;
}

export interface NeteaseClientStatus {
    status: NeteaseClientConnectionState;
    clientVersion: string | null;
    port: 9223;
    capabilities: NeteaseClientCapabilities;
    error: NeteaseClientError | null;
}

export type NeteaseClientCommandResult =
    | { ok: true; snapshot: NeteaseClientSnapshot }
    | { ok: false; error: NeteaseClientError };

export interface NeteaseClientPlaySongInput {
    songId: number;
    /** 由 clientTakeover facade 的 buildClientQueueIds 生成，目标 id 必在数组内，最多 100 个 */
    queueIds?: number[];
    /** 接管时保留 Folia 当前位置：先 playing/play，再 playing/setPlayingPosition {duration} */
    startPositionSec?: number;
}

/**
 * The methods preload exposes as `window.electron.neteaseClient`.
 *
 * The renderer service is built against this interface alone; the preload implementation is a
 * sandboxed CJS module and keeps its channel strings inline.
 */
export interface NeteaseClientPreloadApi {
    connect(options?: { force?: boolean }): Promise<NeteaseClientStatus>;
    disconnect(options?: { pauseFirst?: boolean }): Promise<NeteaseClientStatus>;
    getStatus(): Promise<NeteaseClientStatus>;
    getSnapshot(): Promise<NeteaseClientSnapshot | null>;
    playSong(input: NeteaseClientPlaySongInput): Promise<NeteaseClientCommandResult>;
    play(): Promise<NeteaseClientCommandResult>;
    pause(): Promise<NeteaseClientCommandResult>;
    toggle(): Promise<NeteaseClientCommandResult>;
    next(): Promise<NeteaseClientCommandResult>;
    prev(): Promise<NeteaseClientCommandResult>;
    seek(positionSec: number): Promise<NeteaseClientCommandResult>;
    setVolume(volume: number): Promise<NeteaseClientCommandResult>;
    onStatusChanged(listener: (status: NeteaseClientStatus) => void): () => void;
    onSnapshot(listener: (snapshot: NeteaseClientSnapshot) => void): () => void;
}
