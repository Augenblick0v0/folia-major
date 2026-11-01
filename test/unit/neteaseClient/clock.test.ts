import { describe, expect, it } from 'vitest';
import {
    anchorFromSnapshot,
    extrapolatePosition,
    reanchor,
    type NeteaseClientClockAnchor,
} from '../../../src/services/onlineMusic/netease/client/clock';
import type { NeteaseClientSnapshot } from '../../../src/services/onlineMusic/netease/client/types';

const capabilities = {
    playById: true,
    transport: true,
    seek: true,
    setVolume: true,
    readProgress: true,
    nativeSkip: true,
};

const snapshot = (patch: Partial<NeteaseClientSnapshot> = {}): NeteaseClientSnapshot => ({
    revision: 1,
    status: 'connected',
    clientVersion: '3.1.0',
    track: { id: 42, name: 'Track', durationMs: 180_000 },
    playback: 'playing',
    positionSec: 10,
    sampledAt: 1_000,
    durationSec: 180,
    volume: 0.8,
    capabilities,
    error: null,
    ...patch,
});

const anchor = (patch: Partial<NeteaseClientClockAnchor> = {}): NeteaseClientClockAnchor => ({
    trackId: 42,
    positionSec: 10,
    anchoredAtMs: 1_000,
    playing: true,
    durationSec: 180,
    ...patch,
});

describe('client takeover clock', () => {
    it('extrapolates a playing position', () => {
        expect(extrapolatePosition(anchor(), 3_500)).toBe(12.5);
    });

    it('freezes a paused position', () => {
        expect(extrapolatePosition(anchor({ playing: false }), 60_000)).toBe(10);
    });

    it('clamps at the duration', () => {
        expect(extrapolatePosition(anchor({ positionSec: 10, durationSec: 12 }), 5_000)).toBe(12);
    });

    it('does not clamp when the duration is unknown', () => {
        expect(extrapolatePosition(anchor({ positionSec: 10, durationSec: 0 }), 5_000)).toBe(14);
    });

    it('starts over on a track change', () => {
        const next = reanchor(anchor(), snapshot({ track: { id: 43, name: 'Next', durationMs: 200_000 }, positionSec: 3 }), 5_000);
        expect(next).toEqual({
            trackId: 43,
            positionSec: 3,
            anchoredAtMs: 5_000,
            playing: true,
            durationSec: 180,
        });
    });

    it('keeps the old anchor while the drift is sampling jitter', () => {
        const next = reanchor(anchor(), snapshot({ positionSec: 11.2 }), 2_000);
        expect(next.anchoredAtMs).toBe(1_000);
        expect(next.positionSec).toBe(10);
    });

    it('re-anchors when the client seeks beyond the tolerance', () => {
        const next = reanchor(anchor(), snapshot({ positionSec: 30 }), 2_000);
        expect(next.anchoredAtMs).toBe(2_000);
        expect(next.positionSec).toBe(30);
    });

    it('re-anchors when playback starts or stops', () => {
        const next = reanchor(anchor(), snapshot({ playback: 'paused', positionSec: 11 }), 2_000);
        expect(next.anchoredAtMs).toBe(2_000);
        expect(next.playing).toBe(false);
        expect(next.positionSec).toBe(11);
    });

    it('builds an anchor from a snapshot', () => {
        expect(anchorFromSnapshot(snapshot(), 7_000)).toEqual(anchor({ anchoredAtMs: 7_000 }));
    });
});
