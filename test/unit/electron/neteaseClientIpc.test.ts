import { describe, expect, it, vi } from 'vitest';

// test/unit/electron/neteaseClientIpc.test.ts
// The renderer-facing handlers must not trust the preload: every argument is checked here, and a
// window other than the main window gets the untrusted shape instead of an executed command.

const CHANNELS = require('../../../electron/netease/clientIpcChannels.cjs') as Record<string, string>;
const {
    NO_CAPABILITIES,
    registerNeteaseClientIpc,
} = require('../../../electron/netease/clientIpc.cjs') as {
    NO_CAPABILITIES: Record<string, boolean>;
    registerNeteaseClientIpc: (options: Record<string, unknown>) => void;
};

const SNAPSHOT = {
    revision: 4,
    status: 'connected',
    clientVersion: 'NeteaseMusicDesktop/3.1.41.205564',
    track: { id: 347230, name: '海阔天空', durationMs: 326000 },
    playback: 'playing',
    positionSec: 12,
    sampledAt: 1,
    durationSec: 326,
    volume: 0.5,
    capabilities: { playById: true, transport: true, seek: true, setVolume: true, readProgress: true, nativeSkip: true },
    error: null,
};

const STATUS = {
    status: 'connected',
    clientVersion: 'NeteaseMusicDesktop/3.1.41.205564',
    port: 9223,
    capabilities: { playById: true, transport: true, seek: true, setVolume: true, readProgress: true, nativeSkip: true },
    error: null,
};

const createSetup = () => {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const ipcMain = {
        handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
            handlers.set(channel, handler);
        }),
    };
    const controller = {
        connect: vi.fn(async () => STATUS),
        disconnect: vi.fn(async () => ({ ...STATUS, status: 'disconnected' })),
        getStatus: vi.fn(() => STATUS),
        getSnapshot: vi.fn(() => SNAPSHOT),
        playSong: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        play: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        pause: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        toggle: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        next: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        prev: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        seek: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
        setVolume: vi.fn(async () => ({ ok: true, snapshot: SNAPSHOT })),
    };
    registerNeteaseClientIpc({
        ipcMain,
        controller,
        // main.cjs passes isTrustedMainWindowContents, which takes the webContents.
        isTrusted: (sender: any) => sender?.trusted === true,
    });
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { trusted: true } }, ...args);
    const invokeUntrusted = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: { trusted: false } }, ...args);
    return { handlers, controller, invoke, invokeUntrusted };
};

const INVOKE_CHANNELS = [
    CHANNELS.connect,
    CHANNELS.disconnect,
    CHANNELS.getStatus,
    CHANNELS.getSnapshot,
    CHANNELS.playSong,
    CHANNELS.play,
    CHANNELS.pause,
    CHANNELS.toggle,
    CHANNELS.next,
    CHANNELS.prev,
    CHANNELS.seek,
    CHANNELS.setVolume,
];

describe('netease client IPC', () => {
    it('registers exactly the twelve invoke channels', () => {
        const { handlers } = createSetup();
        expect([...handlers.keys()].sort()).toEqual([...INVOKE_CHANNELS].sort());
    });

    it('validates songId and queueIds before the controller sees them', async () => {
        const { controller, invoke } = createSetup();

        await expect(invoke(CHANNELS.playSong, { songId: 0 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.playSong, { songId: 1.5 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.playSong, { songId: 1, queueIds: Array.from({ length: 101 }, (_, index) => index + 1) }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.playSong, { songId: 3, queueIds: [1, 2] }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.playSong, { songId: 1, queueIds: [1, '2'] }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.playSong, { songId: 1, startPositionSec: -1 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });

        await expect(invoke(CHANNELS.playSong, { songId: 1, queueIds: [1, 1, 2], startPositionSec: 3 }))
            .resolves.toMatchObject({ ok: true });
        expect(controller.playSong).toHaveBeenCalledWith({ songId: 1, queueIds: [1, 2], startPositionSec: 3 });
    });

    it('validates seek and volume ranges', async () => {
        const { controller, invoke } = createSetup();

        await expect(invoke(CHANNELS.seek, { positionSec: -0.5 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.seek, { positionSec: Number.NaN }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.seek, { positionSec: 60 })).resolves.toMatchObject({ ok: true });
        expect(controller.seek).toHaveBeenCalledWith(60);

        await expect(invoke(CHANNELS.setVolume, { volume: 1.2 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.setVolume, { volume: -0.1 }))
            .resolves.toMatchObject({ ok: false, error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.setVolume, { volume: 0.4 })).resolves.toMatchObject({ ok: true });
        expect(controller.setVolume).toHaveBeenCalledWith(0.4);
    });

    it('validates force and pauseFirst flags', async () => {
        const { invoke } = createSetup();
        await expect(invoke(CHANNELS.connect, { force: 'yes' }))
            .resolves.toMatchObject({ status: 'error', error: { code: 'invalid-argument' } });
        await expect(invoke(CHANNELS.disconnect, { pauseFirst: 1 }))
            .resolves.toMatchObject({ status: 'error', error: { code: 'invalid-argument' } });
    });

    it('returns the status shape for connect and the snapshot for get-snapshot', async () => {
        const { invoke } = createSetup();
        await expect(invoke(CHANNELS.connect)).resolves.toEqual(STATUS);
        await expect(invoke(CHANNELS.getSnapshot)).resolves.toEqual(SNAPSHOT);
    });

    it('rejects an untrusted sender without touching the controller', async () => {
        const { controller, invokeUntrusted } = createSetup();

        expect(invokeUntrusted(CHANNELS.connect)).toEqual({
            status: 'error',
            clientVersion: null,
            port: 9223,
            capabilities: NO_CAPABILITIES,
            error: expect.objectContaining({ code: 'untrusted' }),
        });
        expect(invokeUntrusted(CHANNELS.playSong, { songId: 1 }))
            .toEqual({ ok: false, error: expect.objectContaining({ code: 'untrusted' }) });
        expect(invokeUntrusted(CHANNELS.getSnapshot)).toBeNull();
        expect(controller.connect).not.toHaveBeenCalled();
        expect(controller.playSong).not.toHaveBeenCalled();
    });
});
