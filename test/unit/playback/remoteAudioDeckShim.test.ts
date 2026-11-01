// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAudioDeckShim } from '@/components/app/playback/clientTakeover/remoteAudioDeckShim';
import type { ClientTakeoverService, ClientTakeoverSnapshot, ClientTakeoverStatus } from '@/services/clientTakeover';

// test/unit/playback/remoteAudioDeckShim.test.ts
// The deck shim is the join between the client and App's existing <audio> handlers: it must answer
// the media properties App reads and synthesize the events App listens for, without ever touching
// the element's src (React owns that).

const capabilities = {
    playById: true,
    transport: true,
    seek: true,
    setVolume: true,
    readProgress: true,
    nativeSkip: true,
};

const snapshot = (overrides: Partial<ClientTakeoverSnapshot> = {}): ClientTakeoverSnapshot => ({
    revision: 1,
    status: 'connected',
    clientVersion: 'NeteaseMusicDesktop/3.1.0',
    track: { id: 1, name: 'Track 1', durationMs: 200_000 },
    playback: 'playing',
    positionSec: 0,
    sampledAt: 0,
    durationSec: 200,
    volume: 0.8,
    capabilities,
    error: null,
    ...overrides,
});

const status = (value: ClientTakeoverStatus['status']): ClientTakeoverStatus => ({
    status: value,
    clientVersion: 'NeteaseMusicDesktop/3.1.0',
    port: 9223,
    capabilities: value === 'connected' ? capabilities : { ...capabilities, seek: false },
    error: null,
});

class FakeClientService {
    snapshot: ClientTakeoverSnapshot | null = snapshot();
    position = 0;
    readonly snapshotListeners = new Set<(next: ClientTakeoverSnapshot) => void>();
    readonly statusListeners = new Set<(next: ClientTakeoverStatus) => void>();
    readonly playSong = vi.fn(async (_input: { songId: number; queueIds?: number[] }) => ({ ok: true as const, snapshot: snapshot({ revision: 2 }) }));
    readonly play = vi.fn(async () => ({ ok: true as const, snapshot: snapshot({ revision: 3 }) }));
    readonly pause = vi.fn(async () => ({ ok: true as const, snapshot: snapshot({ revision: 4, playback: 'paused' }) }));
    readonly seek = vi.fn(async (value: number) => {
        this.position = value;
        return { ok: true as const, snapshot: snapshot({ revision: 5, positionSec: value }) };
    });
    readonly setVolume = vi.fn(async (_value: number) => ({ ok: true as const, snapshot: snapshot({ revision: 6 }) }));

    getSnapshotSync = () => this.snapshot;
    getPositionSec = () => this.position;
    isConnected = () => this.snapshot?.status === 'connected';
    subscribe = (listener: (next: ClientTakeoverSnapshot) => void) => {
        this.snapshotListeners.add(listener);
        return () => this.snapshotListeners.delete(listener);
    };
    subscribeStatus = (listener: (next: ClientTakeoverStatus) => void) => {
        this.statusListeners.add(listener);
        return () => this.statusListeners.delete(listener);
    };

    emit(next: ClientTakeoverSnapshot) {
        this.snapshot = next;
        this.position = next.positionSec;
        this.snapshotListeners.forEach(listener => listener(next));
    }

    emitStatus(next: ClientTakeoverStatus) {
        this.statusListeners.forEach(listener => listener(next));
    }
}

const asService = (fake: FakeClientService) => fake as unknown as ClientTakeoverService;

const recordEvents = (element: HTMLAudioElement) => {
    const seen: string[] = [];
    ['loadedmetadata', 'durationchange', 'canplay', 'play', 'playing', 'pause', 'ended', 'timeupdate', 'seeking', 'seeked']
        .forEach(type => element.addEventListener(type, () => seen.push(type)));
    return seen;
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('remote audio deck shim', () => {
    it('answers media properties from the snapshot and restores the prototype on detach', () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        expect(element.duration).toBe(200);
        expect(element.paused).toBe(false);
        expect(element.ended).toBe(false);
        expect(element.readyState).toBe(4);
        expect(element.error).toBeNull();
        expect(element.volume).toBe(0.8);

        shim.detach();
        expect(Object.prototype.hasOwnProperty.call(element, 'paused')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(element, 'duration')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(element, 'play')).toBe(false);
    });

    it('asks the client for Folia’s current song before playing when the snapshot names another', async () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 22,
            getQueueIds: () => [21, 22, 23],
        });

        shim.attach();
        await element.play();

        expect(fake.playSong).toHaveBeenCalledWith({ songId: 22, queueIds: [21, 22, 23] });
        expect(fake.play).toHaveBeenCalledTimes(1);
    });

    it('does not re-ask when the snapshot already names the current song', async () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        await element.play();

        expect(fake.playSong).not.toHaveBeenCalled();
        expect(fake.play).toHaveBeenCalledTimes(1);
    });

    it('turns snapshot changes into the events the app already handles', () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const seen = recordEvents(element);
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        expect(seen).toEqual(expect.arrayContaining(['loadedmetadata', 'durationchange', 'play', 'playing']));

        seen.length = 0;
        fake.emit(snapshot({ revision: 2, track: { id: 2, name: 'Track 2', durationMs: 180_000 }, durationSec: 180, positionSec: 0 }));
        expect(seen).toEqual(expect.arrayContaining(['loadedmetadata', 'durationchange', 'canplay', 'play', 'playing']));

        seen.length = 0;
        fake.emit(snapshot({ revision: 3, track: { id: 2, name: 'Track 2', durationMs: 180_000 }, durationSec: 180, positionSec: 45, playback: 'paused' }));
        expect(seen).toContain('pause');
    });

    it('emits one pause and one ended when a track stops at its end, and cancels it on a new track', () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const seen = recordEvents(element);
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        seen.length = 0;
        fake.position = 200;
        fake.emit(snapshot({ revision: 2, playback: 'stopped', positionSec: 200 }));
        vi.advanceTimersByTime(1_199);
        expect(seen).not.toContain('ended');
        vi.advanceTimersByTime(1);
        expect(seen.filter(type => type === 'pause')).toHaveLength(1);
        expect(seen.filter(type => type === 'ended')).toHaveLength(1);

        seen.length = 0;
        fake.position = 200;
        fake.emit(snapshot({ revision: 3, playback: 'stopped', positionSec: 200 }));
        fake.emit(snapshot({ revision: 4, track: { id: 2, name: 'Next', durationMs: 100_000 }, durationSec: 100, positionSec: 0, playback: 'playing' }));
        vi.advanceTimersByTime(1_200);
        expect(seen).not.toContain('ended');
    });

    it('seeks through the client and reports seeking then seeked', async () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const seen = recordEvents(element);
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        element.currentTime = 42;
        expect(seen).toContain('seeking');
        await vi.runAllTimersAsync();
        expect(fake.seek).toHaveBeenCalledWith(42);
        expect(seen).toContain('seeked');
    });

    it('sends volume and mute to the client', () => {
        const fake = new FakeClientService();
        const element = document.createElement('audio');
        const shim = createRemoteAudioDeckShim(element, {
            service: asService(fake),
            getCurrentTakeoverSongId: () => 1,
            getQueueIds: () => [1],
        });

        shim.attach();
        element.volume = 0.5;
        expect(fake.setVolume).toHaveBeenLastCalledWith(0.5);
        element.muted = true;
        expect(fake.setVolume).toHaveBeenLastCalledWith(0);
        element.muted = false;
        expect(fake.setVolume).toHaveBeenLastCalledWith(0.5);
    });
});
