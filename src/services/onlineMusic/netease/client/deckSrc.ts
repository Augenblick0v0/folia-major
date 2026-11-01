// src/services/onlineMusic/netease/client/deckSrc.ts
// The source the two real <audio> decks are given while the desktop client owns the sound.
//
// Each song gets its own tiny silent WAV. React writes it into the deck's `src`, so a track change
// still runs the element's normal load lifecycle — `loadedmetadata`, `durationchange`, `canplay` —
// which the shim turns into the events App's existing handlers already understand. A shared
// constant URI would leave the element on the same source and those events would never fire.

const SAMPLE_RATE = 8000;
const SAMPLE_COUNT = 80; // 10 ms of silence: long enough to decode, too short to hear.
const BYTES_PER_SAMPLE = 2;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const base64Of = (bytes: Uint8Array): string => {
    let out = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
        const chunk = (first << 16) | (second << 8) | third;
        out += BASE64_ALPHABET[(chunk >> 18) & 63];
        out += BASE64_ALPHABET[(chunk >> 12) & 63];
        out += index + 1 < bytes.length ? BASE64_ALPHABET[(chunk >> 6) & 63] : '=';
        out += index + 2 < bytes.length ? BASE64_ALPHABET[chunk & 63] : '=';
    }
    return out;
};

const asciiBytes = (text: string): number[] => [...text].map(character => character.charCodeAt(0) & 0xff);

const uint32le = (value: number): number[] => [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
];

const uint16le = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];

/**
 * A silent PCM WAV whose JUNK chunk carries the song id, so the data URI is different for every
 * song while the decoded audio stays exactly the same.
 */
const silentWavBytes = (songId: number): Uint8Array => {
    const dataSize = SAMPLE_COUNT * BYTES_PER_SAMPLE;
    const junkText = `folia:${songId}`;
    const junkPayload = asciiBytes(junkText);
    if (junkPayload.length % 2 === 1) junkPayload.push(0);
    const riffSize = 4 + (8 + 16) + (8 + junkPayload.length) + (8 + dataSize);
    const bytes = [
        ...asciiBytes('RIFF'), ...uint32le(riffSize), ...asciiBytes('WAVE'),
        ...asciiBytes('fmt '), ...uint32le(16),
        ...uint16le(1), ...uint16le(1),
        ...uint32le(SAMPLE_RATE), ...uint32le(SAMPLE_RATE * BYTES_PER_SAMPLE),
        ...uint16le(BYTES_PER_SAMPLE), ...uint16le(16),
        ...asciiBytes('JUNK'), ...uint32le(junkPayload.length), ...junkPayload,
        ...asciiBytes('data'), ...uint32le(dataSize),
        ...new Array<number>(dataSize).fill(0),
    ];
    return Uint8Array.from(bytes);
};

const cache = new Map<number, string>();

/** The silent deck source for one song (null before a song is known). */
export const buildSilentDeckSrc = (songId: number | null | undefined): string => {
    const id = Number.isInteger(songId) && Number(songId) > 0 ? Number(songId) : 0;
    const cached = cache.get(id);
    if (cached) return cached;
    const src = `data:audio/wav;base64,${base64Of(silentWavBytes(id))}`;
    cache.set(id, src);
    return src;
};

/** Named for the engine at its call site; the same function. */
export const buildClientTakeoverDeckSrc = buildSilentDeckSrc;

/** Alias kept for call sites that describe the value rather than its use. */
export const createSilentDeckSrc = buildSilentDeckSrc;
