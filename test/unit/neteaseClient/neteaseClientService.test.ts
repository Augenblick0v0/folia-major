import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNeteaseClientService } from '../../../src/services/onlineMusic/netease/client/neteaseClientService';
import type {
    NeteaseClientCommandResult,
    NeteaseClientPreloadApi,
    NeteaseClientSnapshot,
    NeteaseClientStatus,
} from '../../../src/services/onlineMusic/netease/client/types';

const capabilities = {
    playById: true,
    transport: true,
    seek: true,
    setVolume: true,
    readProgress: true,
    nativeSkip: true,
};

const status = (patch: Partial<NeteaseClientStatus> = {}): NeteaseClientStatus => ({
    status: 'connected',
    clientVersion: '3.1.0',
    port: 9223,
    capabilities,
    error: null,
    ...patch,
});

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

const ok = (patch: Partial<NeteaseClientSnapshot> = {}): NeteaseClientCommandResult => ({
    ok: true,
    snapshot: snapshot(patch),
});

const createFakeBridge = () => {
    let snapshotListener: ((snapshot: NeteaseClientSnapshot) => void) | null = null;
    let statusListener: ((status: NeteaseClientStatus) => void) | null = null;
    const seekCalls: number[] = [];
    const volumeCalls: number[] = [];
    let seekResult: NeteaseClientCommandResult | null = null;
    let connectCalls = 0;

    const bridge: NeteaseClientPreloadApi = {
        connect: async () => {
            connectCalls += 1;
            return status();
        },
        disconnect: async () => status({ status: 'disconnected' }),
        getStatus: async () => status(),
        getSnapshot: async () => snapshot(),
        playSong: async input => ok({
            revision: 2,
            track: { id: input.songId, name: 'Requested', durationMs: 180_000 },
        }),
        play: async () => ok(),
        pause: async () => ok({ playback: 'paused' }),
        toggle: async () => ok(),
        next: async () => ok({ revision: 2, track: { id: 43, name: 'Next', durationMs: 180_000 } }),
        prev: async () => ok({ revision: 2, track: { id: 41, name: 'Prev', durationMs: 180_000 } }),
        seek: async (positionSec) => {
            seekCalls.push(positionSec);
            return seekResult ?? ok({ revision: 2, positionSec });
        },
        setVolume: async (volume) => {
            volumeCalls.push(volume);
            return ok({ revision: 2, volume });
        },
        onStatusChanged: (listener) => {
            statusListener = listener;
            return () => { statusListener = null; };
        },
        onSnapshot: (listener) => {
            snapshotListener = listener;
            return () => { snapshotListener = null; };
        },
    };

    return {
        bridge,
        emitSnapshot: (value: NeteaseClientSnapshot) => snapshotListener?.(value),
        emitStatus: (value: NeteaseClientStatus) => statusListener?.(value),
        setSeekResult: (result: NeteaseClientCommandResult | null) => { seekResult = result; },
        seekCalls,
        volumeCalls,
        connectCalls: () => connectCalls,
    };
};

afterEach(() => {
    vi.useRealTimers();
});

describe('client takeover service', () => {
    it('extrapolates a playing snapshot and freezes it while paused', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        service.subscribe(() => {});

        fake.emitSnapshot(snapshot({ positionSec: 10 }));
        vi.advanceTimersByTime(2_500);
        expect(service.getPositionSec()).toBeCloseTo(12.5, 5);

        fake.emitSnapshot(snapshot({ revision: 2, playback: 'paused', positionSec: 13 }));
        vi.advanceTimersByTime(5_000);
        expect(service.getPositionSec()).toBe(13);
    });

    it('drops a snapshot with an older revision', () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        const revisions: number[] = [];
        service.subscribe(value => revisions.push(value.revision));

        fake.emitSnapshot(snapshot({ revision: 2, positionSec: 20 }));
        fake.emitSnapshot(snapshot({ revision: 1, positionSec: 90 }));

        expect(revisions).toEqual([2]);
        expect(service.getSnapshotSync()?.positionSec).toBe(20);
    });

    it('re-anchors on a new track', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        service.subscribe(() => {});

        fake.emitSnapshot(snapshot({ track: { id: 42, name: 'First', durationMs: 180_000 }, positionSec: 10 }));
        vi.advanceTimersByTime(2_000);
        fake.emitSnapshot(snapshot({
            revision: 2,
            track: { id: 43, name: 'Second', durationMs: 180_000 },
            positionSec: 3,
        }));

        expect(service.getClockAnchor()?.trackId).toBe(43);
        expect(service.getPositionSec()).toBe(3);
    });

    it('re-anchors when the client seeks', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        service.subscribe(() => {});

        fake.emitSnapshot(snapshot({ positionSec: 10 }));
        vi.advanceTimersByTime(1_000);
        fake.emitSnapshot(snapshot({ revision: 2, positionSec: 30 }));

        expect(service.getClockAnchor()?.positionSec).toBe(30);
        expect(service.getClockAnchor()?.anchoredAtMs).toBe(1_001_000);
    });

    it('clamps a seek to the current duration', async () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        service.subscribe(() => {});
        fake.emitSnapshot(snapshot({ durationSec: 180 }));

        await service.seek(500);

        expect(fake.seekCalls).toEqual([180]);
    });

    it('restores the clock anchor when a seek fails', async () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        const statuses: NeteaseClientStatus[] = [];
        service.subscribeStatus(value => statuses.push(value));
        fake.emitSnapshot(snapshot({ positionSec: 10 }));
        const before = service.getClockAnchor();

        fake.setSeekResult({ ok: false, error: { code: 'client-rejected', message: 'no seek' } });
        const result = await service.seek(50);

        expect(result.ok).toBe(false);
        expect(service.getClockAnchor()).toEqual(before);
        expect(statuses.at(-1)?.capabilities.seek).toBe(false);
    });

    it('clamps volume to 0..1', async () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);

        await service.setVolume(1.7);
        await service.setVolume(-2);

        expect(fake.volumeCalls).toEqual([1, 0]);
    });

    it('marks the song it asked for until that track arrives', async () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);

        await service.playSong({ songId: 100, queueIds: [100] });

        expect(service.consumeExpectedTrack(100)).toBe(true);
        expect(service.consumeExpectedTrack(100)).toBe(false);
    });

    it('merges concurrent connect calls into one', async () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);

        const first = service.connect();
        const second = service.connect();
        expect(first).toBe(second);
        await first;
        expect(fake.connectCalls()).toBe(1);
    });

    it('applies a status pushed by the bridge', () => {
        const fake = createFakeBridge();
        const service = createNeteaseClientService(fake.bridge);
        const statuses: NeteaseClientStatus[] = [];
        service.subscribeStatus(value => statuses.push(value));

        fake.emitStatus(status({ status: 'connected', clientVersion: '3.2.0' }));

        expect(statuses.at(-1)?.clientVersion).toBe('3.2.0');
        expect(service.isConnected()).toBe(true);
    });
});
