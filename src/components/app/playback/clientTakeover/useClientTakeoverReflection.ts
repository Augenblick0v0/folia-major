import { useEffect } from 'react';
import { clientTakeoverService } from '../../../../services/clientTakeover';
import type { ClientTakeoverTrack } from '../../../../services/clientTakeover';
import { useAudioSettingsStore } from '../../../../stores/useAudioSettingsStore';
import { useClientTakeoverStore } from '../../../../stores/useClientTakeoverStore';

// src/components/app/playback/clientTakeover/useClientTakeoverReflection.ts
//
// Reflects a track change made in the desktop client back into Folia. It only decides WHICH change
// is a reflection; the queue controller owns the song, queue, lyrics and cover work. `armed` is
// read by the caller: before the first alignment the store may still carry an old client snapshot,
// and acting on it would move Folia to a song nobody asked it for.

export type ClientTrackChangeDecision = 'ignore' | 'reflect' | 'resend';

/**
 * `expected`: Folia asked for this track, so the UI already moved and the snapshot is the echo of
 * that request. `loopOne`: Folia owns single-loop, so a client-side advance has to be undone by
 * asking for the old song again instead of following it.
 */
export const decideClientTrackChange = ({
    expected,
    loopOne,
}: {
    expected: boolean;
    loopOne: boolean;
}): ClientTrackChangeDecision => {
    if (expected) return 'ignore';
    return loopOne ? 'resend' : 'reflect';
};

type UseClientTakeoverReflectionParams = {
    /** The bridge has completed the first alignment (or a reconnect) and the engine is in use. */
    enabled: boolean;
    onTrackChange: (track: ClientTakeoverTrack) => void;
    /** Single loop: ask Folia to send the old song to the client again. */
    onResendCurrent?: () => void;
};

export const useClientTakeoverReflection = ({
    enabled,
    onTrackChange,
    onResendCurrent,
}: UseClientTakeoverReflectionParams): void => {
    useEffect(() => {
        if (!enabled) return;
        // The snapshot already in the store belongs to the alignment; only a later id is a change.
        const initialTrackId = useClientTakeoverStore.getState().track?.id ?? null;
        if (initialTrackId !== null) clientTakeoverService.consumeExpectedTrack(initialTrackId);
        let previousTrackId = initialTrackId;
        return useClientTakeoverStore.subscribe((state) => {
            const track = state.track;
            const trackId = track?.id ?? null;
            if (trackId === previousTrackId) return;
            previousTrackId = trackId;
            if (!track) return;

            const decision = decideClientTrackChange({
                expected: clientTakeoverService.consumeExpectedTrack(track.id),
                loopOne: useAudioSettingsStore.getState().loopMode === 'one',
            });
            if (decision === 'reflect') onTrackChange(track);
            else if (decision === 'resend') onResendCurrent?.();
        });
    }, [enabled, onResendCurrent, onTrackChange]);
};
