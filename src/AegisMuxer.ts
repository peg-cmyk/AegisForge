"use strict";

export interface BufferLike {
    byteLength: number;
    buffer?: ArrayBufferLike;
    byteOffset?: number;
    copyTo?(dst: Uint8Array): void;
}

export interface Sink {
    write(d: Uint8Array): void | Promise<void>;
    close?(): void;
}

export interface MuxerColorSpace {
    primaries?: string | null;
    transfer?: string | null;
    matrix?: string | null;
    fullRange?: boolean | null;
}

export interface TrackConfig {
    codec?: string;
    width?: number;
    height?: number;
    framerate?: number;
    sampleRate?: number;
    numberOfChannels?: number;
    rotation?: number;
    colorSpace?: MuxerColorSpace;
    description?: AllowSharedBufferSource;
}

export interface QueueEntry {
    d: Uint8Array | null;
    k: boolean;
    p: number;
    dt: number;
    du: number;
    c: number;
}

export interface SttsEntry { c: number; d: number; }
export interface CttsEntry { c: number; o: number; }
export interface StscEntry { f: number; n: number; i: number; }
export interface StackEntry { s: number; m: string; }

export interface MuxerChunk {
    timestamp?: number;
    duration?: number | null;
    byteLength: number;
    type?: string;
    copyTo?(dst: Uint8Array): void;
    close?(): void;
}

export interface MuxerMeta {
    compositionTimeOffset?: number;
    decoderConfig?: {
        description?: AllowSharedBufferSource;
        colorSpace?: MuxerColorSpace;
    };
}

export interface EngineOptions {
    format?: string;
    mode?: string;
    autoSync?: boolean;
    maxFragDur?: number;
    sink: Sink;
    video?: TrackConfig;
    audio?: TrackConfig;
    onError?: (e: Error) => void;
}

const AegisMuxer = (() => {
    const TS_FREQ = 90000;
    const EPOCH_OFFSET = 2082844800;
    const MAX_U32 = 0xFFFFFFFF;

    const CPRI: Record<string, number> = { "bt709": 1, "bt470bg": 5, "smpte170m": 6, "bt2020": 9, "smpte432": 12 };

    const CTRC: Record<string, number> = { "bt709": 1, "smpte170m": 6, "iec61966-2-1": 13, "smpte2084": 16, "pq": 16, "hlg": 18 };

    const CMAT: Record<string, number> = { "rgb": 0, "bt709": 1, "bt470bg": 5, "smpte170m": 6, "bt2020": 9, "smpte2084": 9 };

    const guard = (cond: boolean, msg: string, errCb?: (e: Error) => void) => {
        if (!cond) {
            const e = new Error(`[AegisMuxer] ${msg}`);
            if (errCb) errCb(e); else throw e;
            return false;
        }
        return true;
    };


    class MemSink implements Sink {
        chunks: Uint8Array[]; len: number;
        constructor() { this.chunks = []; this.len = 0; }
        write(d: Uint8Array) { if (d && d.byteLength) { this.chunks.push(d); this.len += d.byteLength; } }
        get buffer(): ArrayBuffer {
            if (this.chunks.length === 0) return new ArrayBuffer(0);
            if (this.chunks.length === 1) {
                const c = this.chunks[0];
                return c.buffer ? (c.buffer as ArrayBuffer).slice(c.byteOffset, c.byteOffset + c.byteLength) : c.buffer as ArrayBuffer;
            }
            const out = new Uint8Array(this.len);
            let off = 0;
            for (const c of this.chunks) {
                out.set(c, off);
                off += c.byteLength;
            }
            return out.buffer;
        }
    }

    class StreamSink implements Sink {
        cb: (data: Uint8Array, pos: number) => void; pos: number;
        constructor(cb: (data: Uint8Array, pos: number) => void) { this.cb = cb; this.pos = 0; }
        write(d: Uint8Array) { if (d && d.byteLength) { this.cb(d, this.pos); this.pos += d.byteLength; } }
    }

    class FileSink implements Sink {
        handle: FileSystemSyncAccessHandle; pos: number; errCb: ((e: Error) => void) | undefined;
        constructor(handle: FileSystemSyncAccessHandle, errCb?: (e: Error) => void) {
            this.handle = handle;
            this.pos = 0;
            this.errCb = errCb;
        }
        write(d: Uint8Array) {
            if (!d || !d.byteLength) return;
            try {
                this.handle.write(d, { at: this.pos });
                this.pos += d.byteLength;
            } catch (e: unknown) {
                if (this.errCb) this.errCb(new Error("FileSink IO Error: " + (e instanceof Error ? e.message : String(e))));
            }
        }
        close() {
            try {
                this.handle.flush();
                this.handle.close();
            } catch (e) { console.warn('[AegisMuxer] FileSink close error:', e); }
        }
    }

    class WebStreamSink {
        writer: WritableStreamDefaultWriter; errCb: ((e: Error) => void) | undefined;
        constructor(stream: WritableStream, errCb?: (e: Error) => void) {
            this.writer = stream.getWriter();
            this.errCb = errCb;
        }
        async write(d: Uint8Array) {
            if (!d || !d.byteLength) return;
            try {
                await this.writer.write(d);
            } catch (e: unknown) {
                if (this.errCb) this.errCb(new Error("WebStreamSink IO Error: " + (e instanceof Error ? e.message : String(e))));
            }
        }
        close() {
            try { this.writer.close(); } catch (e) { console.warn('[AegisMuxer] WebStreamSink close error:', e); }
        }
    }

    class Scribe {
        err: (e: Error) => void; cap: number; buf: Uint8Array; view: DataView; p: number; stack: StackEntry[]; _te: TextEncoder;

        constructor(errCb: (e: Error) => void, initialCap: number = 4 * 1024 * 1024) {
            this.err = errCb;
            this.cap = initialCap;
            this.buf = new Uint8Array(this.cap);
            this.view = new DataView(this.buf.buffer);
            this.p = 0; this.stack = []; this._te = new TextEncoder();
        }
        ensure(n: number) {
            if (this.p + n > this.cap) {
                let nCap = this.cap; while (this.p + n > nCap) nCap = Math.floor(nCap * 1.5);
                try {
                    const nBuf = new Uint8Array(nCap); nBuf.set(this.buf.subarray(0, this.p));
                    this.buf = nBuf; this.view = new DataView(this.buf.buffer); this.cap = nCap;
                } catch (e) {
                    throw new Error(`[AegisMuxer] OOM: failed to allocate ${(nCap / (1024 * 1024)).toFixed(1)}MB buffer. ` +
                        `Current usage: ${(this.p / (1024 * 1024)).toFixed(1)}MB. Reduce output resolution or use streaming mode.`);
                }
            }
        }
        u8(x: number) { this.ensure(1); this.buf[this.p++] = x; }
        u16(x: number) { this.ensure(2); this.view.setUint16(this.p, x); this.p += 2; }
        u24(x: number) { this.ensure(3); this.view.setUint16(this.p, x >> 8); this.buf[this.p + 2] = x & 0xff; this.p += 3; }
        u32(x: number) { this.ensure(4); this.view.setUint32(this.p, x); this.p += 4; }
        i16(x: number) { this.ensure(2); this.view.setInt16(this.p, x); this.p += 2; }
        i32(x: number) { this.ensure(4); this.view.setInt32(this.p, x); this.p += 4; }
        u64(x: number) { this.ensure(8); this.view.setUint32(this.p, Math.floor(x / 4294967296)); this.view.setUint32(this.p + 4, x >>> 0); this.p += 8; }
        f32(x: number) { this.ensure(4); this.view.setFloat32(this.p, x); this.p += 4; }
        str(s: string) {
            const encoded = this._te.encode(s);
            this.ensure(encoded.length);
            this.buf.set(encoded, this.p);
            this.p += encoded.length;
        }
        bytes(d: BufferLike) { this.ensure(d.byteLength); this.buf.set(new Uint8Array(d.buffer || (d as unknown as ArrayBuffer), d.byteOffset || 0, d.byteLength), this.p); this.p += d.byteLength; }
        chunk(c: BufferLike) {
            this.ensure(c.byteLength);
            if (c.copyTo) c.copyTo(this.buf.subarray(this.p, this.p + c.byteLength));
            else this.buf.set(new Uint8Array(c.buffer || (c as unknown as ArrayBuffer), c.byteOffset || 0, c.byteLength), this.p);
            this.p += c.byteLength;
        }
        zero(n: number) { if (n <= 0) return; this.ensure(n); this.buf.fill(0, this.p, this.p + n); this.p += n; }

        static _hexCache = new Map<string, Uint8Array>();
        static _hex(hex: string): Uint8Array {
            let r = Scribe._hexCache.get(hex);
            if (!r) { r = new Uint8Array(hex.length >> 1); for (let i = 0; i < r.length; i++) r[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16); Scribe._hexCache.set(hex, r); }
            return r;
        }
        ebv(x: number) {
            let l = 1; while (x >= Math.pow(2, 7 * l) - 1) l++;
            this.ensure(l);
            for (let i = l - 1; i >= 0; i--) { let b = Math.floor(x / Math.pow(2, 8 * i)) & 0xff; if (i === l - 1) b |= (1 << (8 - l)); this.buf[this.p++] = b; }
        }
        ebm(hex: string) { const h = Scribe._hex(hex); this.ensure(h.length + 8); this.buf.set(h, this.p); this.p += h.length; const s = this.p; this.p += 8; this.stack.push({ s, m: 'e' }); }
        ebu(hex: string) { const h = Scribe._hex(hex); this.ensure(h.length + 8); this.buf.set(h, this.p); this.p += h.length; this.buf[this.p++] = 0x01; for (let i = 0; i < 7; i++) this.buf[this.p++] = 0xff; }

        box(t: string) { this.ensure(8); const s = this.p; this.p += 4; this.str(t); this.stack.push({ s, m: 'm' }); }
        box64(t: string) { this.ensure(16); const s = this.p; this.u32(1); this.str(t); this.p += 8; this.stack.push({ s, m: 'm64' }); }
        rif(t: string) { this.ensure(8); const s = this.p; this.str(t); this.p += 4; this.stack.push({ s, m: 'r' }); }

        end() {
            if (!guard(this.stack.length > 0, "Stack underflow", this.err)) return;
            const n = this.stack.pop()!; const sz = this.p - n.s;
            if (n.m === 'm') {
                if (!guard(sz <= MAX_U32, "Box exceeds 4GB, use box64", this.err)) return;
                this.view.setUint32(n.s, sz);
            }
            else if (n.m === 'm64') { this.view.setUint32(n.s + 8, Math.floor(sz / 4294967296)); this.view.setUint32(n.s + 12, sz >>> 0); }
            else if (n.m === 'r') { this.view.setUint32(n.s + 4, sz - 8, true); if ((sz - 8) % 2) this.u8(0); }
            else if (n.m === 'e') { const d = sz - 8; for (let i = 7; i >= 0; i--) { let b = Math.floor(d / Math.pow(2, 8 * i)) & 0xff; if (i === 7) b |= 1; this.buf[n.s + (7 - i)] = b; } }
        }
        get data() { return this.buf.subarray(0, this.p); }
        reset() { this.p = 0; this.stack.length = 0; }
        u32le(v: number) { this.ensure(4); this.view.setUint32(this.p, v, true); this.p += 4; }
        u16le(v: number) { this.ensure(2); this.view.setUint16(this.p, v, true); this.p += 2; }
    }

    class Track {
        id: number; isV: boolean; codec: string; scale: number; fps: number;
        w: number; h: number; sr: number; ch: number;
        rot: number; cs: MuxerColorSpace | null; cfgData: Uint8Array | null;
        queue: QueueEntry[]; stts: SttsEntry[]; ctts: CttsEntry[]; stss: number[]; stsc: StscEntry[]; stsz: number[]; stco: number[];
        lastDts: number; lastPts: number; minPts: number;
        audioCount: number; hasNegCto: boolean;

        constructor(id: number, isVideo: boolean, config: TrackConfig) {
            this.id = id; this.isV = isVideo; this.codec = String(config.codec || "").toLowerCase();
            this.scale = isVideo ? TS_FREQ : (config.sampleRate || 48000);
            this.w = config.width! | 0; this.h = config.height! | 0;
            this.fps = config.framerate || 30;
            this.sr = config.sampleRate! | 0; this.ch = config.numberOfChannels! | 0;
            this.rot = config.rotation! | 0; this.cs = config.colorSpace || null;
            if (config.description) {
                const d = config.description;
                if (d instanceof Uint8Array) this.cfgData = new Uint8Array(d);
                else if (d instanceof ArrayBuffer) this.cfgData = new Uint8Array(d);
                else this.cfgData = new Uint8Array(d as unknown as ArrayBuffer);
            } else this.cfgData = null;

            this.queue = []; this.stts = []; this.ctts = []; this.stss = []; this.stsc = []; this.stsz = []; this.stco = [];
            this.lastDts = -1; this.lastPts = -1; this.minPts = Infinity;
            this.audioCount = 0; this.hasNegCto = false;
        }
    }

    class Engine {
        opt: Required<Pick<EngineOptions, 'format' | 'mode' | 'autoSync' | 'maxFragDur'>> & EngineOptions;
        err: (e: Error) => void; fmt!: string; sink!: Sink; sc!: Scribe;
        vt!: Track | null; at!: Track | null;
        sealed!: boolean; cTime!: number; dataOff!: number; seq!: number; tBase!: number; wClus!: number;
        _aviIdx!: { tag: string; flags: number; offset: number; size: number }[];
        _aviChunks!: Uint8Array[];
        _oggSerial!: number; _oggPageSeq!: number; _oggGranule!: number;


        constructor(options: EngineOptions) {
            this.opt = { format: "mp4", mode: "fragmented", autoSync: true, maxFragDur: 2.0, ...options };
            this.err = this.opt.onError || ((e: Error) => console.error(e));
            if (!guard(!!(this.opt.sink), "Sink output required", this.err)) return;

            this.fmt = String(this.opt.format).toLowerCase();
            const SUPPORTED_FMTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'ogg', 'mp3'];
            if (!guard(SUPPORTED_FMTS.includes(this.fmt), `Unsupported format '${this.fmt}'. Supported: ${SUPPORTED_FMTS.join(', ')}`, this.err)) return;
            this.sink = this.opt.sink;
            this.sc = new Scribe(this.err, this.opt.mode === 'fragmented' ? 64 * 1024 : 1024 * 1024);
            this.vt = null; this.at = null;
            this.sealed = false; this.cTime = Math.floor(Date.now() / 1000) + EPOCH_OFFSET;
            this.dataOff = 0; this.seq = 1; this.tBase = -1; this.wClus = -1;
            this._aviIdx = []; this._aviChunks = [];
            this._oggSerial = (Math.random() * 0x7FFFFFFF) >>> 0; this._oggPageSeq = 0; this._oggGranule = 0;

            if (this.opt.video) {
                this.vt = new Track(1, true, this.opt.video);
            }
            if (this.opt.audio) {
                this.at = new Track(this.vt ? 2 : 1, false, this.opt.audio);
                if (this.at.codec.includes("aac") || this.at.codec.includes("mp4a")) {
                    const freqs = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
                    let idx = freqs.indexOf(this.at.sr); if (idx < 0) idx = 4;
                    this.at.cfgData = new Uint8Array([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (this.at.ch << 3)]);
                }
            }
            if (!guard(!!(this.vt || this.at), "No valid tracks configured", this.err)) return;
            this._initHdr();
        }

        _initHdr() {
            try {
                if (this.fmt === "mp4" || this.fmt === "mov") {
                    this.sc.box("ftyp");
                    if (this.fmt === "mov") { this.sc.str("qt  "); this.sc.u32(512); this.sc.str("qt  "); }
                    else {
                        this.sc.str(this.opt.mode === "fragmented" ? "iso5" : "isom");
                        this.sc.u32(512);
                        this.sc.str(this.opt.mode === "fragmented" ? "iso5iso6mp41" : "isomiso2avc1mp41");
                    }
                    this.sc.end();
                } else if (this.fmt === "webm" || this.fmt === "mkv") {
                    this.sc.ebm("1A45DFA3"); this.sc.ebm("4286"); this.sc.u8(1); this.sc.end(); this.sc.ebm("42F7"); this.sc.u8(1); this.sc.end();
                    this.sc.ebm("42F2"); this.sc.u8(4); this.sc.end(); this.sc.ebm("42F3"); this.sc.u8(8); this.sc.end();
                    this.sc.ebm("4282"); this.sc.str(this.fmt === "mkv" ? "matroska" : "webm"); this.sc.end(); this.sc.ebm("4287"); this.sc.u8(4); this.sc.end();
                    this.sc.ebm("4285"); this.sc.u8(2); this.sc.end(); this.sc.end();

                    this.sc.ebu("18538067");
                    this.sc.ebm("1549A966");
                    this.sc.ebm("2AD7B1"); this.sc.u32(1000000); this.sc.end();
                    this.sc.ebm("4D80"); this.sc.str("AegisMuxer"); this.sc.end();
                    this.sc.end();

                    this.sc.ebm("1654AE6B");
                    if (this.vt) {
                        this.sc.ebm("AE"); this.sc.ebm("D7"); this.sc.u8(this.vt.id); this.sc.end(); this.sc.ebm("83"); this.sc.u8(1); this.sc.end();
                        const cName = (this.vt.codec.includes("vp9") || this.vt.codec.includes("vp09")) ? "V_VP9" : (this.vt.codec.includes("vp8") ? "V_VP8" : (this.vt.codec.includes("av1") || this.vt.codec.includes("av01") ? "V_AV1" : (this.vt.codec.includes("hevc") || this.vt.codec.includes("hvc1") || this.vt.codec.includes("hev1") ? "V_MPEGH/ISO/HEVC" : "V_MPEG4/ISO/AVC")));
                        this.sc.ebm("86"); this.sc.str(cName); this.sc.end();

                        if (this.vt.cfgData) {
                            this.sc.ebm("63A2"); this.sc.bytes(this.vt.cfgData); this.sc.end();
                        }
                        this.sc.ebm("E0"); this.sc.ebm("B0"); this.sc.u16(this.vt.w); this.sc.end(); this.sc.ebm("BA"); this.sc.u16(this.vt.h); this.sc.end(); this.sc.end(); this.sc.end();
                    }
                    if (this.at) {
                        this.sc.ebm("AE"); this.sc.ebm("D7"); this.sc.u8(this.at.id); this.sc.end(); this.sc.ebm("83"); this.sc.u8(2); this.sc.end();
                        this.sc.ebm("86"); this.sc.str(this.at.codec.includes("opus") ? "A_OPUS" : (this.at.codec.includes("vorbis") ? "A_VORBIS" : "A_AAC")); this.sc.end();
                        if (this.at.codec.includes("opus")) {

                            this.sc.ebm("63A2");
                            this.sc.str("OpusHead");
                            this.sc.u8(1);
                            this.sc.u8(this.at.ch);

                            this.sc.u8(0x00); this.sc.u8(0x0F);

                            const sr = this.at.sr;
                            this.sc.u8(sr & 0xFF); this.sc.u8((sr >> 8) & 0xFF); this.sc.u8((sr >> 16) & 0xFF); this.sc.u8((sr >> 24) & 0xFF);

                            this.sc.u8(0); this.sc.u8(0);
                            this.sc.u8(0);
                            this.sc.end();
                        }
                        if (this.at.codec.includes("aac") || this.at.codec.includes("mp4a")) {

                            if (this.at.cfgData) {
                                this.sc.ebm("63A2"); this.sc.bytes(this.at.cfgData); this.sc.end();
                            }
                        }
                        this.sc.ebm("E1"); this.sc.ebm("B5"); this.sc.f32(this.at.sr); this.sc.end(); this.sc.ebm("9F"); this.sc.u8(this.at.ch); this.sc.end(); this.sc.end(); this.sc.end();
                    }
                    this.sc.end();
                } else if (this.fmt === "avi") {
                    this._initAVI();
                } else if (this.fmt === "ogg") {
                    this._initOGG();
                } else if (this.fmt === "mp3") {

                }
                this._flushSc();
            } catch (e: unknown) { this.err(e instanceof Error ? e : new Error(String(e))); }
        }

        _flushSc() {
            if (this.sc.p > 0) {
                const d = new Uint8Array(this.sc.buf.buffer.slice(0, this.sc.p));
                try { this.sink.write(d); } catch (e: unknown) { this.err(e instanceof Error ? e : new Error(String(e))); }
                if (this.opt.mode !== "fragmented" || this.fmt === "avi") this.dataOff += d.byteLength;
                this.sc.reset();
            }
        }

        addVideo(chunk: MuxerChunk, meta?: MuxerMeta) {
            if (this.sealed || !this.vt || !chunk) return;
            try {
                let ts = (chunk.timestamp || 0) / 1e6, dur = (chunk.duration || 0) / 1e6, cto = (meta?.compositionTimeOffset || 0) / 1e6;

                if (dur <= 0.0) dur = 1.0 / this.vt.fps;
                if (isNaN(ts) || isNaN(dur) || ts < 0) return;

                if (meta?.decoderConfig) {
                    if (meta.decoderConfig.description && !this.vt.cfgData) this.vt.cfgData = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
                    if (meta.decoderConfig.colorSpace && !this.vt.cs) this.vt.cs = meta.decoderConfig.colorSpace;
                }

                let raw = new Uint8Array(chunk.byteLength);
                if (chunk.copyTo) chunk.copyTo(raw); else raw.set(new Uint8Array(chunk as unknown as ArrayBuffer));

                this._push(this.vt, raw, chunk.type === "key", ts, ts - cto, dur, cto);
            } catch (e) {
                console.warn("[AegisMuxer] Recovered from corrupted video chunk: ", e);
            } finally {
                try { if (chunk && typeof chunk.close === "function") chunk.close(); } catch (e) { console.warn('[AegisMuxer] chunk.close() error:', e); }
            }
        }

        addAudio(chunk: MuxerChunk, meta?: MuxerMeta) {
            if (this.sealed || !this.at || !chunk) return;
            try {
                let ts = (chunk.timestamp || 0) / 1e6, dur = (chunk.duration || 0) / 1e6;

                if (isNaN(ts) || isNaN(dur) || ts < 0) return;

                if (this.opt.autoSync) {
                    let exactDur = (this.at.codec.includes("aac") || this.at.codec.includes("mp4a")) ? 1024 / this.at.sr : (dur || (this.at.codec.includes("opus") ? 960 / this.at.sr : 0.02));
                    ts = this.at.audioCount * exactDur;
                    dur = exactDur;
                    this.at.audioCount++;
                }

                let raw = new Uint8Array(chunk.byteLength);
                if (chunk.copyTo) chunk.copyTo(raw); else raw.set(new Uint8Array(chunk as unknown as ArrayBuffer));

                if (meta?.decoderConfig?.description && !this.at.cfgData) this.at.cfgData = new Uint8Array(meta.decoderConfig.description as ArrayBuffer);
                this._push(this.at, raw, true, ts, ts, dur, 0);
            } catch (e) {
                console.warn("[AegisMuxer] Recovered from corrupted audio chunk: ", e);
            } finally {
                try { if (chunk && typeof chunk.close === "function") chunk.close(); } catch (e) { console.warn('[AegisMuxer] chunk.close() error:', e); }
            }
        }

        _push(trk: Track, data: Uint8Array, isKey: boolean, pts: number, dts: number, dur: number, cto: number) {
            if (this.tBase === -1) this.tBase = 0;
            pts -= this.tBase; dts -= this.tBase;

            if (dts < trk.lastDts) dts = trk.lastDts + 0.000001;
            if (pts < trk.lastPts && !trk.isV) pts = trk.lastPts + 0.000001;

            trk.lastDts = dts; trk.lastPts = pts;
            if (pts < trk.minPts) trk.minPts = pts;

            let dU = Math.max(1, Math.round(dur * trk.scale));
            let cU = Math.round((pts - dts) * trk.scale);
            if (cU < 0) trk.hasNegCto = true;

            if (this.opt.mode !== "fragmented") {
                let lastSt = trk.stts[trk.stts.length - 1];
                if (lastSt && lastSt.d === dU) lastSt.c++; else trk.stts.push({ c: 1, d: dU });

                if (trk.isV) {
                    let lastCt = trk.ctts[trk.ctts.length - 1];
                    if (lastCt && lastCt.o === cU) lastCt.c++; else trk.ctts.push({ c: 1, o: cU });
                    if (isKey) trk.stss.push(trk.stsz.length + 1);
                }
                trk.stsz.push(data.byteLength);
            }

            trk.queue.push({ d: data, k: isKey, p: pts, dt: dts, du: dU, c: cU });

            if (this.opt.mode === "fragmented") {
                this._checkFrag();
            } else if (this.fmt === "webm" || this.fmt === "mkv" || this.fmt === "avi") {
                this._flushInterleaved();
            } else if (this.fmt === "ogg") {
                this._flushOGG();
            } else if (this.fmt === "mp3") {
                this._flushMP3();
            } else {

            }
        }

        _flushInterleaved() {
            for (let t of [this.vt, this.at].filter(Boolean) as Track[]) {
                if (t.queue.length === 0) continue;
                if (this.fmt === "webm" || this.fmt === "mkv") {

                    let shouldCluster = false;
                    if (this.wClus === -1) {
                        this.wClus = t.queue[0].p;
                        shouldCluster = true;
                    } else if (t.queue[t.queue.length - 1].p - this.wClus >= this.opt.maxFragDur) {
                        shouldCluster = true;
                    }

                    if (shouldCluster) {

                        let tc = Math.round(t.queue[0].p * 1000);
                        this.sc.ebu("1F43B675");
                        this.sc.ebm("E7"); this.sc.u32(tc); this.sc.end();
                        this.wClus = t.queue[0].p;
                    }

                    while (t.queue.length) {
                        const f = t.queue.shift()!;
                        let relTs = Math.round(f.p * 1000) - Math.round(this.wClus * 1000);
                        if (relTs < -32768) relTs = -32768; else if (relTs > 32767) relTs = 32767;
                        this.sc.ebm("A3"); this.sc.ebv(t.id); this.sc.i16(relTs); this.sc.u8(f.k ? 0x80 : 0x00); this.sc.chunk(f.d!); this.sc.end();
                        f.d = null;
                    }

                } else if (this.fmt === "avi") {
                    while (t.queue.length) {
                        const f = t.queue.shift()!;
                        const tag = t.id === 1 ? "00dc" : "01wb";
                        this._aviIdx.push({ tag, flags: f.k ? 0x10 : 0, offset: 0, size: f.d!.byteLength });
                        const chunkSz = f.d!.byteLength;
                        const padded = chunkSz % 2 ? chunkSz + 1 : chunkSz;
                        const chunk = new Uint8Array(8 + padded);
                        const dv = new DataView(chunk.buffer);
                        const _te = new TextEncoder();
                        chunk.set(_te.encode(tag), 0);
                        dv.setUint32(4, chunkSz, true);
                        chunk.set(f.d!, 8);
                        this._aviChunks.push(chunk);
                        f.d = null;
                    }
                }
            }
            if (this.fmt !== "avi") this._flushSc();
        }

        _checkFrag() {
            if (this.fmt !== "mp4" && this.fmt !== "mov") { this._flushInterleaved(); return; }
            let primary = (this.vt && this.vt.queue.length) ? this.vt : ((this.at && this.at.queue.length) ? this.at : null);
            if (primary) {
                let curDur = primary.queue[primary.queue.length - 1].p - primary.queue[0].p;
                if (curDur >= this.opt.maxFragDur && (!this.vt || this.vt.queue[this.vt.queue.length - 1].k)) {
                    this._writeFrag();
                }
            }
        }

        _writeFrag() {
            if (this.seq === 1) { this._writeMoov(true); this._flushSc(); }
            let tks = [this.vt, this.at].filter(t => t && t.queue.length) as Track[];
            if (!tks.length) return;

            this.sc.box("moof");
            this.sc.box("mfhd"); this.sc.u32(0); this.sc.u32(this.seq++); this.sc.end();

            let trunOffs: { p: number; t: Track }[] = [];
            for (let t of tks) {
                this.sc.box("traf");
                this.sc.box("tfhd"); this.sc.u32(0x020000); this.sc.u32(t.id); this.sc.end();
                this.sc.box("tfdt"); this.sc.u32(0x01000000); this.sc.u64(Math.round(t.queue[0].dt * t.scale)); this.sc.end();

                let hasCto = t.isV && t.queue.some(x => x.c !== 0);
                let flags = t.isV ? 0x00000701 : 0x00000301;
                if (hasCto) flags |= 0x00000800;

                this.sc.box("trun");
                this.sc.u8(t.hasNegCto ? 1 : 0);
                this.sc.u24(flags);
                this.sc.u32(t.queue.length);

                let ptr = this.sc.p; this.sc.u32(0);
                for (let f of t.queue) {
                    this.sc.u32(f.du);
                    this.sc.u32(f.d!.byteLength);
                    if (t.isV) this.sc.u32(f.k ? 0x02000000 : (0x01010000 | 0x00010000));
                    if (hasCto) {
                        if (t.hasNegCto) this.sc.i32(f.c); else this.sc.u32(f.c);
                    }
                }
                this.sc.end();
                this.sc.end();
                trunOffs.push({ p: ptr, t });
            }
            this.sc.end();

            let moofSize = this.sc.p;

            let totalMdatPayload = 0;
            for (let x of trunOffs) for (let f of x.t.queue) totalMdatPayload += f.d!.byteLength;

            let trackDataStart = moofSize + 8;
            for (let x of trunOffs) {
                this.sc.view.setUint32(x.p, trackDataStart);
                for (let f of x.t.queue) trackDataStart += f.d!.byteLength;
            }
            this._flushSc();

            this.sc.u32(totalMdatPayload + 8); this.sc.str("mdat"); this._flushSc();

            for (let t of tks) {
                for (let f of t.queue) {
                    this.sc.chunk(f.d!);
                    this._flushSc();
                    f.d = null;
                }
                t.queue.length = 0;
            }
        }

        finalize() {
            if (this.sealed) return; this.sealed = true;
            try {
                if (this.fmt === "avi") {
                    this._finalizeAVI();
                } else if (this.fmt === "ogg") {
                    this._flushOGG(); this._writeOGGPage(new Uint8Array(0), true);
                } else if (this.fmt === "mp3") {
                    this._flushMP3();
                } else if (this.opt.mode === "fragmented") {
                    if (this.fmt === "mp4" || this.fmt === "mov") {
                        this._writeFrag();
                        let tks = [this.vt, this.at].filter(Boolean) as Track[];
                        this.sc.box("mfra");
                        for (let t of tks) {
                            this.sc.box("tfra"); this.sc.u32(0x01000000); this.sc.u32(t.id); this.sc.u32(0x3F); this.sc.u32(0); this.sc.end();
                        }
                        this.sc.box("mfro"); this.sc.u32(0); this.sc.u32(16 + (tks.length * 32)); this.sc.end();
                        this.sc.end(); this._flushSc();
                    } else this._flushInterleaved();

                } else if (this.fmt === "mp4" || this.fmt === "mov") {
                    let tks = [this.vt, this.at].filter(Boolean) as Track[], ofs = this.dataOff;
                    for (let t of tks) {
                        t.stsc = [{ f: 1, n: 1, i: 1 }];
                        for (let i = 0; i < t.queue.length; i++) {
                            t.stco.push(ofs); ofs += t.queue[i].d!.byteLength;
                            if (i > 0) t.stsc.push({ f: i + 1, n: 1, i: 1 });
                        }
                        let cp = [];
                        for (let c of t.stsc) { if (!cp.length || cp[cp.length - 1].n !== c.n) cp.push(c); }
                        t.stsc = cp;
                    }
                    let mPos = this.sc.p; this._writeMoov(false); let hdrSize = this.sc.p - mPos; this.sc.reset();

                    let fixOff = hdrSize + 8, dataSize = ofs - this.dataOff, is64 = dataSize + 16 > MAX_U32;
                    if (is64) fixOff += 8;
                    for (let t of tks) for (let i = 0; i < t.stco.length; i++) t.stco[i] += fixOff;

                    this._writeMoov(false); this._flushSc();

                    if (is64) { this.sc.u32(1); this.sc.str("mdat"); this.sc.u64(dataSize + 16); }
                    else { this.sc.u32(dataSize + 8); this.sc.str("mdat"); }
                    this._flushSc();

                    for (let t of tks) {
                        for (let f of t.queue) {
                            this.sc.chunk(f.d!);
                            this._flushSc();
                            f.d = null;
                        }
                        t.queue.length = 0;
                    }
                }
            } catch (e: unknown) { this.err(e instanceof Error ? e : new Error(String(e))); }
        }

        _writeMoov(isFrag: boolean) {
            this.sc.box("moov"); this.sc.box("mvhd");
            this.sc.u32(0); this.sc.u32(this.cTime); this.sc.u32(this.cTime); this.sc.u32(TS_FREQ);
            let maxDur = 0;
            if (!isFrag) {
                for (let t of [this.vt, this.at].filter(Boolean) as Track[]) {
                    let d = 0; for (let s of t.stts) d += (s.c * s.d);
                    let r = (d / t.scale) * TS_FREQ; if (r > maxDur) maxDur = r;
                }
            }
            this.sc.u32(Math.round(maxDur)); this.sc.u32(0x00010000); this.sc.u16(0x0100); this.sc.zero(10);
            let mat = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000]; for (let x of mat) this.sc.u32(x);
            this.sc.zero(24); this.sc.u32((this.vt && this.at) ? 3 : 2); this.sc.end();

            if (this.vt) this._writeTrak(this.vt, isFrag);
            if (this.at) this._writeTrak(this.at, isFrag);

            if (isFrag) {
                this.sc.box("mvex");
                for (let t of [this.vt, this.at].filter(Boolean) as Track[]) {
                    this.sc.box("trex"); this.sc.u32(0); this.sc.u32(t.id); this.sc.u32(1); this.sc.zero(12); this.sc.end();
                }
                this.sc.end();
            }
            this.sc.end();
        }

        _writeTrak(t: Track, isFrag: boolean) {
            this.sc.box("trak"); this.sc.box("tkhd");
            this.sc.u32(t.isV ? 0x00000003 : 0x00000007); this.sc.u32(this.cTime); this.sc.u32(this.cTime); this.sc.u32(t.id); this.sc.u32(0);
            let d = 0; if (!isFrag) for (let s of t.stts) d += (s.c * s.d);
            this.sc.u32(Math.round((d / t.scale) * TS_FREQ)); this.sc.zero(8); this.sc.u16(0); this.sc.u16(0); this.sc.u16(t.isV ? 0 : 0x0100); this.sc.u16(0);
            let rm = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
            if (t.isV && t.rot) {
                let r = t.rot * Math.PI / 180;
                rm[0] = Math.round(Math.cos(r) * 65536) >>> 0; rm[1] = Math.round(Math.sin(r) * 65536) >>> 0;
                rm[3] = Math.round(-Math.sin(r) * 65536) >>> 0; rm[4] = Math.round(Math.cos(r) * 65536) >>> 0;
            }
            for (let x of rm) this.sc.u32(x);
            this.sc.u32(t.isV ? (t.w << 16) : 0); this.sc.u32(t.isV ? (t.h << 16) : 0); this.sc.end();

            if (!isFrag && t.isV && t.minPts !== Infinity && t.minPts > 0) {
                this.sc.box("edts"); this.sc.box("elst"); this.sc.u32(0); this.sc.u32(1);
                this.sc.u32(Math.round((d / t.scale) * TS_FREQ));
                this.sc.u32(Math.round(t.minPts * t.scale));
                this.sc.u32(0x00010000);
                this.sc.end(); this.sc.end();
            }

            this.sc.box("mdia"); this.sc.box("mdhd");
            this.sc.u32(0); this.sc.u32(this.cTime); this.sc.u32(this.cTime); this.sc.u32(t.scale); this.sc.u32(d); this.sc.u16(0x55c4); this.sc.u16(0); this.sc.end();
            this.sc.box("hdlr"); this.sc.u32(0); this.sc.str("mhlr"); this.sc.str(t.isV ? "vide" : "soun"); this.sc.zero(12); this.sc.str("Aegis\0"); this.sc.end();
            this.sc.box("minf");
            if (t.isV) { this.sc.box("vmhd"); this.sc.u32(0x00000001); this.sc.zero(8); this.sc.end(); }
            else { this.sc.box("smhd"); this.sc.u32(0); this.sc.zero(4); this.sc.end(); }
            this.sc.box("dinf"); this.sc.box("dref"); this.sc.u32(0); this.sc.u32(1); this.sc.box("url "); this.sc.u32(0x00000001); this.sc.end(); this.sc.end(); this.sc.end();

            this.sc.box("stbl"); this._wStsd(t);
            if (!isFrag) {
                this.sc.box("stts"); this.sc.u32(0); this.sc.u32(t.stts.length); for (let s of t.stts) { this.sc.u32(s.c); this.sc.u32(s.d); } this.sc.end();
                if (t.isV && t.stss.length) { this.sc.box("stss"); this.sc.u32(0); this.sc.u32(t.stss.length); for (let s of t.stss) this.sc.u32(s); this.sc.end(); }
                if (t.isV && t.ctts.some((c: CttsEntry) => c.o !== 0)) {
                    this.sc.box("ctts");
                    this.sc.u8(t.hasNegCto ? 1 : 0);
                    this.sc.u24(0); this.sc.u32(t.ctts.length);
                    for (let c of t.ctts) {
                        this.sc.u32(c.c);
                        if (t.hasNegCto) this.sc.i32(c.o); else this.sc.u32(c.o);
                    }
                    this.sc.end();
                }
                this.sc.box("stsc"); this.sc.u32(0); this.sc.u32(t.stsc.length); for (let s of t.stsc) { this.sc.u32(s.f); this.sc.u32(s.n); this.sc.u32(s.i); } this.sc.end();
                let stsz = t.stsz;
                if (stsz.length) {
                    this.sc.box("stsz"); this.sc.u32(0); this.sc.u32(0); this.sc.u32(stsz.length);
                    for (let i = 0; i < stsz.length; i++) this.sc.u32(stsz[i]);
                    this.sc.end();
                }
                let i64 = t.stco.some((c: number) => c > MAX_U32);
                this.sc.box(i64 ? "co64" : "stco"); this.sc.u32(0); this.sc.u32(t.stco.length);
                for (let c of t.stco) { if (i64) this.sc.u64(c); else this.sc.u32(c); }
                this.sc.end();
            } else {
                ["stts", "stsc", "stsz", "stco"].forEach(x => { this.sc.box(x); this.sc.u32(0); this.sc.u32(0); if (x === "stsz") this.sc.u32(0); this.sc.end(); });
            }
            this.sc.end(); this.sc.end(); this.sc.end(); this.sc.end();
        }

        _wStsd(t: Track) {
            this.sc.box("stsd"); this.sc.u32(0); this.sc.u32(1);
            if (t.isV) {
                let nP = t.codec.split('.')[0];
                let bName = "avc1";
                if (nP.startsWith("avc")) bName = "avc1";
                else if (nP.startsWith("hvc") || nP.startsWith("hev")) bName = "hvc1";
                else if (nP.startsWith("av01")) bName = "av01";
                else if (nP.startsWith("vp09")) bName = "vp09";

                this.sc.box(bName); this.sc.zero(6); this.sc.u16(1); this.sc.zero(16); this.sc.u16(t.w); this.sc.u16(t.h);
                this.sc.u32(0x00480000); this.sc.u32(0x00480000); this.sc.u32(0); this.sc.u16(1); this.sc.zero(32); this.sc.u16(0x0018); this.sc.u16(0xffff);
                if (t.cfgData) {
                    if (nP.startsWith("avc")) { this.sc.box("avcC"); this.sc.bytes(t.cfgData); this.sc.end(); }
                    else if (nP.startsWith("hvc") || nP.startsWith("hev")) { this.sc.box("hvcC"); this.sc.bytes(t.cfgData); this.sc.end(); }
                    else if (nP.startsWith("av01")) { this.sc.box("av1C"); this.sc.bytes(t.cfgData); this.sc.end(); }
                    else if (nP.startsWith("vp09")) {
                        this.sc.box("vpcC"); this.sc.u32(0x01000000);
                        this.sc.u8(t.cfgData[0] || 0); this.sc.u8(t.cfgData[1] || 10);
                        this.sc.u8(0x08); this.sc.u8(1); this.sc.u8(1); this.sc.u8(1); this.sc.u16(0);
                        this.sc.end();
                    }
                }
                if (t.cs) {
                    this.sc.box("colr"); this.sc.str("nclx");
                    this.sc.u16(CPRI[t.cs.primaries!] || 2);
                    this.sc.u16(CTRC[t.cs.transfer!] || 2);
                    this.sc.u16(CMAT[t.cs.matrix!] || 2);
                    this.sc.u8(t.cs.fullRange ? 0x80 : 0x00);
                    this.sc.end();
                }
                this.sc.end();
            } else {
                let bName = t.codec.includes("opus") ? "Opus" : "mp4a";
                this.sc.box(bName); this.sc.zero(6); this.sc.u16(1); this.sc.zero(8); this.sc.u16(t.ch); this.sc.u16(16); this.sc.zero(4); this.sc.u32(t.sr << 16);
                if (t.codec.includes("aac") || t.codec.includes("mp4a")) {
                    this.sc.box("esds"); this.sc.u32(0); let c = t.cfgData || new Uint8Array([0x11, 0x90]);
                    this.sc.u8(0x03); this.sc.u8(23 + c.byteLength); this.sc.u16(1); this.sc.u8(0);
                    this.sc.u8(0x04); this.sc.u8(15 + c.byteLength); this.sc.u8(0x40); this.sc.u8(0x15); this.sc.u24(0); this.sc.u32(128000); this.sc.u32(128000);
                    this.sc.u8(0x05); this.sc.u8(c.byteLength); this.sc.bytes(c); this.sc.u8(0x06); this.sc.u8(1); this.sc.u8(2); this.sc.end();
                } else if (t.codec.includes("opus")) {
                    this.sc.box("dOps"); this.sc.u8(0); this.sc.u8(t.ch); this.sc.u16(3840); this.sc.u32(t.sr); this.sc.u16(0); this.sc.u8(0); this.sc.end();
                }
                this.sc.end();
            }
            this.sc.end();
        }

        _initAVI() {
        }

        _finalizeAVI() {
            this._flushInterleaved();
            const tks = [this.vt, this.at].filter(t => t);
            const fps = this.vt ? this.vt.fps : 25;
            const usPerFrame = Math.round(1e6 / fps);
            const vFrames = this.vt ? this.vt.stsz.length : 0;
            const aFrames = this.at ? this.at.stsz.length : 0;
            const w = this.vt ? this.vt.w : 0, h = this.vt ? this.vt.h : 0;

            let totalChunkSize = 0;
            for (const c of this._aviChunks) totalChunkSize += c.byteLength;
            const moviData = new Uint8Array(totalChunkSize);
            let wPos = 0;
            for (const c of this._aviChunks) { moviData.set(c, wPos); wPos += c.byteLength; }
            this._aviChunks = [];
            const sc = this.sc; sc.reset();

            sc.rif("RIFF"); sc.str("AVI ");
            sc.rif("LIST"); sc.str("hdrl");
            sc.rif("avih");
            sc.u32le(usPerFrame); sc.u32le(0); sc.u32le(0); sc.u32le(0x10 | 0x20);
            sc.u32le(Math.max(vFrames, aFrames)); sc.u32le(0); sc.u32le(tks.length); sc.u32le(1024 * 1024);
            sc.u32le(w); sc.u32le(h); sc.u32le(0); sc.u32le(0); sc.u32le(0); sc.u32le(0);
            sc.end();
            if (this.vt) {
                sc.rif("LIST"); sc.str("strl");
                sc.rif("strh"); sc.str("vids");
                const vc = this.vt.codec;
                const fourcc = (vc.includes('h264') || vc.includes('avc')) ? 'H264' : (vc.includes('vp09') || vc.includes('vp9')) ? 'VP90' : (vc.includes('vp8') ? 'VP80' : (vc.includes('av01') || vc.includes('av1') ? 'AV01' : 'MJPG'));
                sc.str(fourcc); sc.u32le(0); sc.u16le(0); sc.u16le(0); sc.u32le(0);
                sc.u32le(1); sc.u32le(Math.round(fps)); sc.u32le(0); sc.u32le(vFrames);
                sc.u32le(1024 * 1024); sc.u32le(0xFFFFFFFF); sc.u32le(0);
                sc.u16le(0); sc.u16le(0); sc.u16le(w); sc.u16le(h);
                sc.end();
                sc.rif("strf"); sc.u32le(40); sc.u32le(w); sc.u32le(h);
                sc.u16le(1); sc.u16le(24); sc.str(fourcc); sc.u32le(w * h * 3);
                sc.u32le(0); sc.u32le(0); sc.u32le(0); sc.u32le(0);
                sc.end(); sc.end();
            }
            if (this.at) {
                sc.rif("LIST"); sc.str("strl");
                const isAAC = this.at.codec.includes('aac') || this.at.codec.includes('mp4a');
                sc.rif("strh"); sc.str("auds"); sc.u32le(isAAC ? 0xFF : 0x55);
                sc.u32le(0); sc.u16le(0); sc.u16le(0); sc.u32le(0);
                sc.u32le(1); sc.u32le(this.at.sr); sc.u32le(0); sc.u32le(aFrames);
                sc.u32le(12288); sc.u32le(0xFFFFFFFF); sc.u32le(0);
                sc.u16le(0); sc.u16le(0); sc.u16le(0); sc.u16le(0);
                sc.end();
                sc.rif("strf"); sc.u16le(isAAC ? 0xFF : 0x55);
                sc.u16le(this.at.ch); sc.u32le(this.at.sr);
                sc.u32le(isAAC ? this.at.sr * this.at.ch * 2 : 16000);
                sc.u16le(isAAC ? 1 : this.at.ch * 2); sc.u16le(isAAC ? 16 : 0);
                if (isAAC && this.at.cfgData) { sc.u16le(this.at.cfgData.byteLength); sc.bytes(this.at.cfgData); }
                else sc.u16le(0);
                sc.end(); sc.end();
            }
            sc.end();
            sc.rif("LIST"); sc.str("movi"); sc.chunk(moviData); sc.end();
            sc.rif("idx1");
            let off = 4;
            for (const e of this._aviIdx) { sc.str(e.tag); sc.u32le(e.flags); sc.u32le(off); sc.u32le(e.size); off += e.size + 8; }
            sc.end();
            sc.end();
            this._flushSc();
        }

        _initOGG() {
            const at = this.at;
            if (!at) { this.err(new Error('[AegisMuxer] OGG requires an audio track')); return; }

            const oh = new Uint8Array(19);
            oh.set([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]);
            oh[8] = 1; oh[9] = at.ch; oh[10] = 0; oh[11] = 0x0F;
            oh[12] = at.sr & 0xFF; oh[13] = (at.sr >> 8) & 0xFF; oh[14] = (at.sr >> 16) & 0xFF; oh[15] = (at.sr >> 24) & 0xFF;
            oh[16] = 0; oh[17] = 0; oh[18] = 0;
            this._writeOGGPage(oh, false, true);

            const tag = new Uint8Array(20);
            tag.set([0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);
            tag[8] = 5; tag.set([0x41, 0x65, 0x67, 0x69, 0x73], 12);
            this._writeOGGPage(tag, false, false);
        }

        _writeOGGPage(data: Uint8Array, isEOS: boolean, isBOS?: boolean) {
            const segCount = Math.max(1, Math.ceil(data.length / 255));
            const headSz = 27 + segCount;
            const page = new Uint8Array(headSz + data.length);
            const v = new DataView(page.buffer);
            page.set([0x4F, 0x67, 0x67, 0x53]);
            page[4] = 0; page[5] = (isBOS ? 0x02 : 0) | (isEOS ? 0x04 : 0);
            v.setUint32(6, this._oggGranule >>> 0, true); v.setUint32(10, 0, true);
            v.setUint32(14, this._oggSerial, true); v.setUint32(18, this._oggPageSeq++, true);
            v.setUint32(22, 0, true); page[26] = segCount;
            let rem = data.length;
            for (let i = 0; i < segCount; i++) { page[27 + i] = Math.min(rem, 255); rem -= Math.min(rem, 255); }
            page.set(data, headSz);
            let crc = 0;
            for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) & 0xFF) ^ page[i]]) >>> 0;
            v.setUint32(22, crc, true);
            try { this.sink.write(page); } catch (e) { this.err(e instanceof Error ? e : new Error(String(e))); }
        }

        _flushOGG() {
            const at = this.at;
            if (!at) return;
            while (at.queue.length) {
                const f = at.queue.shift();
                if (!f) break;
                this._oggGranule += 960;
                this._writeOGGPage(f.d!, false);
                f.d = null;
            }
        }

        _flushMP3() {
            const at = this.at;
            if (!at) return;
            while (at.queue.length) {
                const f = at.queue.shift();
                if (!f) break;
                if (f.d && f.d.byteLength > 0) {
                    try { this.sink.write(f.d); } catch (e: unknown) { this.err(e instanceof Error ? e : new Error(String(e))); }
                }
                f.d = null;
            }
        }
    }

    const OGG_CRC = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i << 24; for (let j = 0; j < 8; j++) c = (c << 1) ^ (c & 0x80000000 ? 0x04C11DB7 : 0); OGG_CRC[i] = c >>> 0; }

    return { MemSink, StreamSink, FileSink, WebStreamSink, Engine };
})();

export { AegisMuxer };
export type AegisMuxerType = typeof AegisMuxer;
