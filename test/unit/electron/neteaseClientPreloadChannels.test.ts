import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// test/unit/electron/neteaseClientPreloadChannels.test.ts
// preload.cjs is sandboxed and cannot require the main-process channel module, so it carries an
// inline copy. This test reads both files and compares the fourteen strings one by one.

const require = createRequire(import.meta.url);
const rootDir = path.resolve(__dirname, '../../../');
const CHANNELS = require(path.join(rootDir, 'electron/netease/clientIpcChannels.cjs')) as Record<string, string>;
const preload = readFileSync(path.join(rootDir, 'electron/preload.cjs'), 'utf8');

describe('netease client preload channels', () => {
    it('matches the main-process channel table one string at a time', () => {
        expect(Object.keys(CHANNELS)).toEqual([
            'connect',
            'disconnect',
            'getStatus',
            'getSnapshot',
            'playSong',
            'play',
            'pause',
            'toggle',
            'next',
            'prev',
            'seek',
            'setVolume',
            'status',
            'snapshot',
        ]);
        expect(new Set(Object.values(CHANNELS)).size).toBe(14);

        const block = preload.match(/const CLIENT_CHANNELS = Object\.freeze\(\{([\s\S]*?)\}\);/);
        expect(block).not.toBeNull();
        const inlined = [...block![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
        expect(inlined).toEqual(Object.values(CHANNELS));
    });

    it('exposes the namespace and both push subscriptions', () => {
        expect(preload).toContain('neteaseClient: {');
        expect(preload).toContain('onStatusChanged: (callback) => {');
        expect(preload).toContain('onSnapshot: (callback) => {');
        expect(preload).toContain('seek: (positionSec) => ipcRenderer.invoke(CLIENT_CHANNELS.seek, { positionSec })');
        expect(preload).toContain('setVolume: (volume) => ipcRenderer.invoke(CLIENT_CHANNELS.setVolume, { volume })');
    });
});
