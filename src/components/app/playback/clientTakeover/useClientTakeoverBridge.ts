import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { buildClientTakeoverQueueIds, clientTakeoverService, isClientTakeoverSong } from '../../../../services/clientTakeover';
import type { ClientTakeoverError, ClientTakeoverSnapshot, ClientTakeoverStatus } from '../../../../services/clientTakeover';
import { CLIENT_TAKEOVER_ENGINE, useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useClientTakeoverStore } from '../../../../stores/useClientTakeoverStore';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { getPlaybackSourceRef } from '../../../../utils/appPlaybackGuards';
import { isMainAppSurface } from '../../../../utils/appSurface';
import { createRemoteAudioDeckShim, type RemoteAudioDeckShim } from './remoteAudioDeckShim';

// src/components/app/playback/clientTakeover/useClientTakeoverBridge.ts
//
// The main window's takeover controller. It owns the connection to the desktop client, feeds the
// runtime store from it, attaches the deck shims while the engine is in use, and performs the
// first / reconnect alignment once per connection. Nothing here touches individual songs: queue
// authority, entry and leaving are the queue controller's.

type ClientTakeoverDeckElements = {
    A: HTMLAudioElement | null;
    B: HTMLAudioElement | null;
};

type UseClientTakeoverBridgeParams = {
    deckElementsRef: MutableRefObject<ClientTakeoverDeckElements>;
    enterClientTakeover: () => Promise<void> | void;
    leaveClientTakeover: () => Promise<void> | void;
    /** Reports a command the client did not take, e.g. a failed pause that leaves it audible. */
    onCommandError?: (error: ClientTakeoverError) => void;
};

type DeckShim = {
    element: HTMLAudioElement;
    shim: RemoteAudioDeckShim;
};

// The client plays catalogue tracks by number; the shim needs the same id the queue controller uses.
const takeoverSongId = (): number | null => {
    const song = usePlaybackStore.getState().currentSong;
    return song && isClientTakeoverSong(song)
        ? Number(getPlaybackSourceRef(song).mediaId)
        : null;
};

export const useClientTakeoverBridge = ({
    deckElementsRef,
    enterClientTakeover,
    leaveClientTakeover,
    onCommandError,
}: UseClientTakeoverBridgeParams): void => {
    const playbackEngine = useAudioSettingsStore(state => state.playbackEngine);
    const currentSong = usePlaybackStore(state => state.currentSong);
    const playbackEngineRef = useRef(playbackEngine);
    playbackEngineRef.current = playbackEngine;
    const previousEngineRef = useRef(playbackEngine);
    const aligningRef = useRef<Promise<void> | null>(null);
    const deckShimsRef = useRef<Partial<Record<'A' | 'B', DeckShim>>>({});

    const getQueueIds = useCallback(() => {
        const songId = takeoverSongId();
        return songId === null
            ? []
            : buildClientTakeoverQueueIds(usePlaybackStore.getState().playQueue, songId);
    }, []);

    const align = useCallback((): Promise<void> => {
        if (aligningRef.current) return aligningRef.current;
        const task = (async () => {
            if (playbackEngineRef.current !== CLIENT_TAKEOVER_ENGINE) return;
            const status = await clientTakeoverService.getStatus();
            if (playbackEngineRef.current !== CLIENT_TAKEOVER_ENGINE) return;
            if (status.status !== 'connected') return;
            const song = usePlaybackStore.getState().currentSong;
            if (song && isClientTakeoverSong(song)) {
                await enterClientTakeover();
            } else {
                // The client may hold a track from an earlier session: nothing in Folia is on it.
                await clientTakeoverService.pause();
            }
            const settings = useAudioSettingsStore.getState();
            await clientTakeoverService.setVolume(settings.isMuted ? 0 : settings.volume);
            if (playbackEngineRef.current !== CLIENT_TAKEOVER_ENGINE) return;
            useClientTakeoverStore.getState().setArmed(true);
        })().finally(() => {
            aligningRef.current = null;
        });
        aligningRef.current = task;
        return task;
    }, [enterClientTakeover]);

    // One subscription for the whole main window: the settings panel connects and disconnects
    // through the same service, and its status has to reach the runtime store either way.
    useEffect(() => {
        if (!isMainAppSurface || playbackEngine !== CLIENT_TAKEOVER_ENGINE) return;
        let lastStatus: ClientTakeoverStatus['status'] | null = null;
        const applyStatus = (status: ClientTakeoverStatus) => {
            lastStatus = status.status;
            useClientTakeoverStore.getState().applyStatus(status);
        };
        const applySnapshot = (snapshot: ClientTakeoverSnapshot) => {
            useClientTakeoverStore.getState().applySnapshot(snapshot);
        };
        const removeStatus = clientTakeoverService.subscribeStatus((status) => {
            const wasConnected = lastStatus === 'connected';
            applyStatus(status);
            // Only a fresh connection aligns. A capability degrading keeps the status at
            // `connected` and must not re-send the song at its current position.
            if (status.status === 'connected' && !wasConnected && playbackEngineRef.current === CLIENT_TAKEOVER_ENGINE) {
                void align();
            } else if (status.status !== 'connected') {
                useClientTakeoverStore.getState().setArmed(false);
            }
        });
        const removeSnapshot = clientTakeoverService.subscribe(applySnapshot);
        void clientTakeoverService.getStatus().then(applyStatus);
        return () => {
            removeStatus();
            removeSnapshot();
        };
    }, [align, playbackEngine]);

    // The engine switch is the controller's entry / leave point. The queue controller keeps the
    // source and position; this decides when the client is connected and aligned.
    useEffect(() => {
        if (!isMainAppSurface) return;
        const previous = previousEngineRef.current;
        previousEngineRef.current = playbackEngine;

        if (playbackEngine === CLIENT_TAKEOVER_ENGINE) {
            useClientTakeoverStore.getState().setArmed(false);
            void clientTakeoverService.connect().then((status) => {
                if (status.status === 'connected' && playbackEngineRef.current === CLIENT_TAKEOVER_ENGINE) void align();
            });
            return;
        }

        if (previous === CLIENT_TAKEOVER_ENGINE) {
            useClientTakeoverStore.getState().setArmed(false);
            void leaveClientTakeover();
            void clientTakeoverService.disconnect({ pauseFirst: true });
        }
    }, [align, leaveClientTakeover, playbackEngine]);

    // Both decks carry the shim: automix may switch which one is active, and the app only trusts
    // events from the active one. Nothing is attached outside the takeover engine or for a song
    // the client cannot play, so a local file keeps the real element.
    useEffect(() => {
        if (!isMainAppSurface) return;
        const elements = deckElementsRef.current;
        const shouldAttach = playbackEngine === CLIENT_TAKEOVER_ENGINE && isClientTakeoverSong(currentSong);

        (['A', 'B'] as const).forEach((deck) => {
            const element = elements[deck];
            const existing = deckShimsRef.current[deck];
            if (existing && existing.element !== element) {
                existing.shim.detach();
                delete deckShimsRef.current[deck];
            }
            if (!element) return;
            if (!shouldAttach) {
                deckShimsRef.current[deck]?.shim.detach();
                return;
            }
            let entry = deckShimsRef.current[deck];
            if (!entry) {
                entry = {
                    element,
                    shim: createRemoteAudioDeckShim(element, {
                        service: clientTakeoverService,
                        getCurrentTakeoverSongId: takeoverSongId,
                        getQueueIds,
                        onCommandError,
                    }),
                };
                deckShimsRef.current[deck] = entry;
            }
            if (!entry) return;
            entry.shim.attach();
        });
    }, [currentSong, deckElementsRef, getQueueIds, onCommandError, playbackEngine]);

    // Attaching the shim gives the deck a volume of its own, but the client keeps the volume it
    // had from an earlier session. Put Folia's current volume on it when the remote deck appears;
    // later slider moves go through App's syncOutputGain into the shim setter.
    useEffect(() => {
        if (playbackEngine !== CLIENT_TAKEOVER_ENGINE || !isClientTakeoverSong(currentSong)) return;
        if (!clientTakeoverService.isConnected()) return;
        const settings = useAudioSettingsStore.getState();
        void clientTakeoverService.setVolume(settings.isMuted ? 0 : settings.volume);
    }, [currentSong, playbackEngine]);

    useEffect(() => () => {
        (['A', 'B'] as const).forEach((deck) => {
            deckShimsRef.current[deck]?.shim.detach();
        });
        deckShimsRef.current = {};
    }, []);
};
