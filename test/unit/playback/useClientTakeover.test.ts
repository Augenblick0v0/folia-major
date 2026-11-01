// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decideClientTrackChange, useClientTakeoverReflection } from '@/components/app/playback/clientTakeover/useClientTakeoverReflection';
import { useAudioSettingsStore } from '@/stores/useAudioSettingsStore';
import { useClientTakeoverStore } from '@/stores/useClientTakeoverStore';
import type { ClientTakeoverTrack } from '@/services/clientTakeover';

// test/unit/playback/useClientTakeover.test.ts
// Reflection is deliberately thin: it decides whether a client track change is Folia's echo, a
// change to follow, or a loop-one change to undo. The lyrics/song work belongs to the queue
// controller and is not this hook's to test.

const facade = vi.hoisted(() => ({
    consumeExpectedTrack: vi.fn((_trackId: number) => false),
}));

vi.mock('@/services/clientTakeover', () => ({
    clientTakeoverService: { consumeExpectedTrack: facade.consumeExpectedTrack },
    isClientTakeoverAvailable: () => false,
    isClientTakeoverSong: () => false,
    buildClientTakeoverQueueIds: () => [],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const track = (id: number): ClientTakeoverTrack => ({ id, name: `Track ${id}`, durationMs: 180_000 });

let root: Root | null = null;

const renderReflection = (params: {
    enabled?: boolean;
    onTrackChange?: (track: ClientTakeoverTrack) => void;
    onResendCurrent?: () => void;
} = {}) => {
    const onTrackChange = params.onTrackChange ?? vi.fn();
    const onResendCurrent = params.onResendCurrent ?? vi.fn();
    function Probe() {
        useClientTakeoverReflection({
            enabled: params.enabled ?? true,
            onTrackChange,
            onResendCurrent,
        });
        return null;
    }
    root = createRoot(document.createElement('div'));
    act(() => root!.render(React.createElement(Probe)));
    return { onTrackChange, onResendCurrent };
};

beforeEach(() => {
    facade.consumeExpectedTrack.mockReset().mockReturnValue(false);
    useAudioSettingsStore.setState({ loopMode: 'all' });
    useClientTakeoverStore.setState({
        status: 'connected',
        track: track(1),
        playback: 'playing',
        revision: 1,
        armed: true,
    });
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
});

describe('client track change decision', () => {
    it('ignores Folia’s own echo and reflects autonomous changes', () => {
        expect(decideClientTrackChange({ expected: true, loopOne: false })).toBe('ignore');
        expect(decideClientTrackChange({ expected: false, loopOne: false })).toBe('reflect');
        expect(decideClientTrackChange({ expected: false, loopOne: true })).toBe('resend');
    });
});

describe('useClientTakeoverReflection', () => {
    it('does not reflect the snapshot present when it arms', () => {
        const { onTrackChange } = renderReflection();
        expect(onTrackChange).not.toHaveBeenCalled();
    });

    it('reflects a later client track and ignores the expected one', () => {
        const { onTrackChange } = renderReflection();

        act(() => useClientTakeoverStore.setState({ track: track(2), revision: 2 }));
        expect(onTrackChange).toHaveBeenCalledWith(track(2));

        facade.consumeExpectedTrack.mockReturnValue(true);
        act(() => useClientTakeoverStore.setState({ track: track(3), revision: 3 }));
        expect(onTrackChange).toHaveBeenCalledTimes(1);
    });

    it('re-asks for the current song instead of following a change in loop-one', () => {
        useAudioSettingsStore.setState({ loopMode: 'one' });
        const { onTrackChange, onResendCurrent } = renderReflection();

        act(() => useClientTakeoverStore.setState({ track: track(2), revision: 2 }));
        expect(onTrackChange).not.toHaveBeenCalled();
        expect(onResendCurrent).toHaveBeenCalledTimes(1);
    });

    it('does nothing while disabled', () => {
        const { onTrackChange } = renderReflection({ enabled: false });
        act(() => useClientTakeoverStore.setState({ track: track(2), revision: 2 }));
        expect(onTrackChange).not.toHaveBeenCalled();
    });
});
