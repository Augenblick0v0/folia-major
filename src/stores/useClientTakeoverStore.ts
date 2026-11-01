// src/stores/useClientTakeoverStore.ts
// The runtime mirror of the desktop client: connection, track and playback state. Nothing here is
// persisted - a reconnect fills it from the main process again - and snapshots arrive with a
// revision so an older IPC message can never overwrite a newer one.

import { create } from 'zustand';
import type {
    ClientTakeoverCapabilities,
    ClientTakeoverConnectionState,
    ClientTakeoverError,
    ClientTakeoverPlaybackState,
    ClientTakeoverSnapshot,
    ClientTakeoverStatus,
    ClientTakeoverTrack,
} from '../services/clientTakeover';

const NO_CAPABILITIES: ClientTakeoverCapabilities = {
    playById: false,
    transport: false,
    seek: false,
    setVolume: false,
    readProgress: false,
    nativeSkip: false,
};

export type ClientTakeoverRuntimeState = {
    status: ClientTakeoverConnectionState;
    clientVersion: string | null;
    capabilities: ClientTakeoverCapabilities;
    track: ClientTakeoverTrack | null;
    playback: ClientTakeoverPlaybackState;
    durationSec: number;
    volume: number;
    revision: number;
    error: ClientTakeoverError | null;
    /** 首次对齐/重连后是否允许反射；驱动 hook 重渲染，不能用 ref */
    armed: boolean;
    applyStatus: (status: ClientTakeoverStatus) => void;
    applySnapshot: (snapshot: ClientTakeoverSnapshot) => void;
    setArmed: (armed: boolean) => void;
    reset: () => void;
};

const initialState = {
    status: 'disconnected' as ClientTakeoverConnectionState,
    clientVersion: null,
    capabilities: NO_CAPABILITIES,
    track: null,
    playback: 'stopped' as ClientTakeoverPlaybackState,
    durationSec: 0,
    volume: 1,
    revision: -1,
    error: null,
    armed: false,
};

export const useClientTakeoverStore = create<ClientTakeoverRuntimeState>((set) => ({
    ...initialState,

    applyStatus: (status) => set(state => ({
        status: status.status,
        clientVersion: status.clientVersion,
        capabilities: status.capabilities,
        error: status.error,
        // A connection that is not up cannot be playing; keeping 'playing' here would leave the
        // controls showing a pause button for a client nobody is talking to. Its track is gone too:
        // a stale row was how a disconnected client kept naming a song.
        playback: status.status === 'connected' ? state.playback : 'stopped',
        track: status.status === 'connected' ? state.track : null,
        durationSec: status.status === 'connected' ? state.durationSec : 0,
    })),

    applySnapshot: (snapshot) => set((state) => {
        if (snapshot.revision <= state.revision) return state;
        return {
            revision: snapshot.revision,
            status: snapshot.status,
            clientVersion: snapshot.clientVersion,
            capabilities: snapshot.capabilities,
            track: snapshot.track,
            playback: snapshot.playback,
            durationSec: snapshot.durationSec,
            volume: snapshot.volume,
            error: snapshot.error,
        };
    }),

    setArmed: (armed) => set({ armed }),

    reset: () => set({ ...initialState }),
}));
