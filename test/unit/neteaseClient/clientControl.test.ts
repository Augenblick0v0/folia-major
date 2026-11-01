import { afterEach, describe, expect, it, vi } from 'vitest';

// test/unit/neteaseClient/clientControl.test.ts
// The CDP lifecycle: discovery, bootstrap injection, snapshot polling, command forwarding and
// the generation rules that keep a late connect from overwriting a newer disconnect.

const CHANNELS = require('../../../electron/netease/clientIpcChannels.cjs') as Record<string, string>;
const {
    createNeteaseClientController,
    parseClientVersion,
} = require('../../../electron/netease/clientControl.cjs') as {
    createNeteaseClientController: (options?: Record<string, unknown>) => any;
    parseClientVersion: (info: Record<string, unknown>) => string | null;
};

const BOOTSTRAP = 'BOOTSTRAP';
const INSTALL_RESULT = {
    installed: true,
    capabilities: { playById: true, transport: true, readProgress: true },
};
const SNAPSHOT = {
    track: { id: 347230, name: '海阔天空', durationMs: 326000, artists: ['Beyond'], album: '乐与怒' },
    playback: 'playing',
    positionSec: 12.5,
    durationSec: 326,
    volume: 0.5,
    capabilities: { playById: true, transport: true, readProgress: true },
};

type Listener = (...args: any[]) => void;

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static evaluate: (expression: string) => unknown = defaultEvaluate;

    static reset() {
        FakeWebSocket.instances = [];
        FakeWebSocket.evaluate = defaultEvaluate;
    }

    url: string;
    sent: Array<{ id?: number; method?: string; params?: { expression?: string } }> = [];
    closed = false;
    private listeners = new Map<string, Listener[]>();

    constructor(url: string) {
        this.url = url;
        FakeWebSocket.instances.push(this);
        queueMicrotask(() => this.emit('open'));
    }

    on(event: string, listener: Listener) {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
        return this;
    }

    removeListener(event: string, listener: Listener) {
        this.listeners.set(event, (this.listeners.get(event) ?? []).filter(item => item !== listener));
        return this;
    }

    emit(event: string, ...args: any[]) {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    send(raw: string, callback?: (error?: Error) => void) {
        const message = JSON.parse(raw);
        this.sent.push(message);
        if (message.method === 'Runtime.enable') {
            queueMicrotask(() => this.emit('message', JSON.stringify({ id: message.id, result: {} })));
        } else if (message.method === 'Runtime.evaluate') {
            const expression = message.params?.expression ?? '';
            const value = FakeWebSocket.evaluate(expression);
            if (value instanceof Error) {
                queueMicrotask(() => this.emit('message', JSON.stringify({
                    id: message.id,
                    result: { exceptionDetails: { exception: { description: value.message } } },
                })));
            } else {
                queueMicrotask(() => this.emit('message', JSON.stringify({
                    id: message.id,
                    result: { result: { value } },
                })));
            }
        }
        callback?.();
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        queueMicrotask(() => this.emit('close'));
    }

    simulateClose() {
        this.emit('close');
    }
}

function defaultEvaluate(expression: string) {
    if (expression === BOOTSTRAP) return INSTALL_RESULT;
    if (expression.includes('.readAll()')) return SNAPSHOT;
    return true;
}

const fetchImpl = vi.fn(async (url: string) => {
    if (url.endsWith('/json/version')) {
        return {
            ok: true,
            json: async () => ({
                Browser: 'Chrome/91.0.4472.169',
                'User-Agent': 'Mozilla/5.0 NeteaseMusicDesktop/3.1.41.205564',
            }),
        };
    }
    return {
        ok: true,
        json: async () => [{
            type: 'page',
            url: 'orpheus://webview/index.html',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/1',
        }],
    };
});

const controllers: any[] = [];

const createController = (overrides: Record<string, unknown> = {}) => {
    const controller = createNeteaseClientController({
        fetchImpl,
        WebSocketImpl: FakeWebSocket,
        bootstrapSource: BOOTSTRAP,
        pollIntervalMs: 60000,
        ...overrides,
    });
    controllers.push(controller);
    return controller;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 500) => {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};

afterEach(async () => {
    await Promise.all(controllers.splice(0).map(controller => controller.dispose()));
    FakeWebSocket.reset();
    fetchImpl.mockClear();
});

describe('netease client controller', () => {
    it('discovers the orpheus page, injects the bootstrap and broadcasts a snapshot', async () => {
        const broadcast = vi.fn();
        const controller = createController({ broadcast });

        const status = await controller.connect();

        expect(status).toMatchObject({
            status: 'connected',
            port: 9223,
            clientVersion: 'NeteaseMusicDesktop/3.1.41.205564',
            capabilities: {
                playById: true,
                transport: true,
                seek: true,
                setVolume: true,
                readProgress: true,
                nativeSkip: true,
            },
        });
        expect(broadcast).toHaveBeenCalledWith(CHANNELS.status, expect.objectContaining({ status: 'connected' }));
        expect(broadcast).toHaveBeenCalledWith(CHANNELS.snapshot, expect.objectContaining({
            revision: 1,
            track: expect.objectContaining({ id: 347230, name: '海阔天空', durationMs: 326000 }),
            playback: 'playing',
            positionSec: 12.5,
            durationSec: 326,
        }));

        const socket = FakeWebSocket.instances[0];
        expect(socket.url).toBe('ws://127.0.0.1:9223/devtools/page/1');
        expect(socket.sent.map(message => message.method)).toEqual([
            'Runtime.enable',
            'Runtime.evaluate',
            'Runtime.evaluate',
        ]);
        expect(socket.sent[1].params?.expression).toBe(BOOTSTRAP);
    });

    it('forwards playSong with the queue and the start position', async () => {
        const controller = createController();
        await controller.connect();
        FakeWebSocket.evaluate = (expression: string) => {
            if (expression === BOOTSTRAP) return INSTALL_RESULT;
            if (expression.includes('.readAll()')) return SNAPSHOT;
            return true;
        };

        const result = await controller.playSong({
            songId: 347230,
            queueIds: [347230, 347231],
            startPositionSec: 30,
        });

        expect(result.ok).toBe(true);
        expect(result.snapshot).toMatchObject({ revision: 2, track: expect.objectContaining({ id: 347230 }) });
        const expressions = FakeWebSocket.instances[0].sent
            .filter(message => message.method === 'Runtime.evaluate')
            .map(message => message.params?.expression ?? '');
        expect(expressions).toContain('window.__foliaNetease.playSong(347230, [347230,347231], 30)');
    });

    it('returns the error and takes the capability away when a command fails', async () => {
        const broadcast = vi.fn();
        const controller = createController({ broadcast });
        await controller.connect();
        FakeWebSocket.evaluate = (expression: string) => {
            if (expression === BOOTSTRAP) return INSTALL_RESULT;
            if (expression.includes('.readAll()')) return SNAPSHOT;
            if (expression.includes('.next()')) return new Error('client-rejected: no next track');
            return true;
        };

        const result = await controller.next();

        expect(result).toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'client-rejected' }),
        });
        expect(controller.getStatus().capabilities).toMatchObject({ nativeSkip: false, transport: true });
        expect(broadcast).toHaveBeenCalledWith(CHANNELS.status, expect.objectContaining({
            capabilities: expect.objectContaining({ nativeSkip: false }),
        }));
    });

    it('reports every failure shape of connect as a status instead of throwing', async () => {
        const broadcast = vi.fn();
        const noPage = vi.fn(async (url: string) => {
            if (url.endsWith('/json/version')) return { ok: true, json: async () => ({ Browser: 'Chrome/91.0.4472.169' }) };
            return { ok: true, json: async () => [{ type: 'worker', url: 'devtools://worker' }] };
        });
        const controller = createController({ broadcast, fetchImpl: noPage });

        const status = await controller.connect();

        expect(status).toMatchObject({
            status: 'error',
            capabilities: { playById: false, transport: false, seek: false, setVolume: false, readProgress: false, nativeSkip: false },
            error: { code: 'page-target-missing' },
        });
        expect(broadcast).toHaveBeenCalledWith(CHANNELS.status, expect.objectContaining({ status: 'connecting' }));
        expect(broadcast).toHaveBeenCalledWith(CHANNELS.status, expect.objectContaining({ status: 'error' }));
    });

    it('pauses before closing when disconnect asks for it and does not reconnect', async () => {
        const controller = createController();
        await controller.connect();
        const socket = FakeWebSocket.instances[0];
        FakeWebSocket.evaluate = (expression: string) => {
            if (expression === BOOTSTRAP) return INSTALL_RESULT;
            if (expression.includes('.readAll()')) return SNAPSHOT;
            return true;
        };

        const status = await controller.disconnect({ pauseFirst: true });

        expect(status).toMatchObject({ status: 'disconnected', clientVersion: null });
        expect(socket.sent.some(message => String(message.params?.expression).includes('.pause()'))).toBe(true);
        expect(socket.closed).toBe(true);

        await new Promise(resolve => setTimeout(resolve, 30));
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(controller.getStatus().status).toBe('disconnected');
    });

    it('reconnects after an unexpected close', async () => {
        const controller = createController({ reconnectDelays: [5] });
        await controller.connect();
        expect(controller.getStatus().status).toBe('connected');

        FakeWebSocket.instances[0].simulateClose();
        expect(controller.getStatus().status).toBe('reconnecting');

        await waitFor(() => FakeWebSocket.instances.length === 2 && controller.getStatus().status === 'connected');
        expect(FakeWebSocket.instances[1].url).toBe('ws://127.0.0.1:9223/devtools/page/1');
    });

    it('answers not-connected for commands before connect', async () => {
        const controller = createController();
        await expect(controller.play()).resolves.toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'not-connected' }),
        });
    });

    it('parses the client version from the DevTools endpoint', () => {
        expect(parseClientVersion({ 'User-Agent': 'Mozilla/5.0 NeteaseMusicDesktop/3.1.41.205564' }))
            .toBe('NeteaseMusicDesktop/3.1.41.205564');
        expect(parseClientVersion({ Browser: 'Chrome/91.0.4472.169' })).toBe('Chrome/91.0.4472.169');
        expect(parseClientVersion(null as never)).toBeNull();
    });
});
