# AegisForge

<p>
  <img src="https://img.shields.io/badge/v1.1-blue" alt="version">
  <img src="https://img.shields.io/badge/271KB-blueviolet" alt="size">
  <img src="https://img.shields.io/badge/deps-0-brightgreen" alt="deps">
  <img src="https://img.shields.io/badge/WTFPL-orange" alt="license">
</p>

ブラウザだけで動く動画編集エンジン。FFmpegなし、サーバーなし、外部依存ゼロ。

A browser-native video editing engine. No FFmpeg, no server, zero dependencies.

---

## 機能 / Features

### 動画編集
- マルチトラックタイムライン（マグネティックスナップ）
- キーフレームアニメーション（ベジェ曲線、CatmullRom）
- プリコンポジション、Undo/Redo（JSON Patch差分）
- マルチカム編集、プロジェクトファイル（.aegis / OPFS自動保存）

### ネイティブMuxer（AegisMuxer）
純JS/TS実装。FFmpeg不要。

| 形式 | 映像+音声 | 映像のみ | 音声のみ | 方式 |
|------|:---------:|:--------:|:--------:|------|
| MP4  | ✅ | ✅ | ✅ | fragmented / sequential |
| MOV  | ✅ | ✅ | ✅ | fragmented / sequential |
| WebM | ✅ | ✅ | — | EBML streaming |
| MKV  | ✅ | ✅ | — | EBML streaming |
| AVI  | ✅ | ✅ | — | RIFF + idx1 |
| OGG  | — | — | ✅ | Ogg pages + CRC-32 |
| MP3  | — | — | ✅ | passthrough |
| GIF  | — | ✅ | — | NeuQuant + LZW |
| APNG | — | ✅ | — | deflate |
| WAV  | — | — | ✅ | PCM |

未対応フォーマット（FLV, TS, 3GP, WMV等）は明確なエラーメッセージを返します。

### デマクサー
MP4 / WebM / MKV / AVI / FLV / OGG

### エフェクト（WebGL2/WebGPU）
Bloom, Blur, Color Grading (3D LUT), Distortion, Blend (25+モード), Fractal, Glitch, Luma Key, ASCII Art, DOM Overlay, Boomerang, Particle System

### オーディオ
AudioWorklet, バイノーラル (HRTF), チップチューン, ルームトーン, スペクトログラム, FFT/IMDCT, 自動同期 (相互相関), リサンプラー (Kaiser窓Sinc)

### AI / ML
- WebNN推論（セグメンテーション、超解像）
- オプティカルフロー（Lucas-Kanade / Farnebäck）
- 手ブレ補正、ビートシンク、VJエンジン

### テキスト
SDF (符号付き距離場), Lottie, 字幕 (SRT/ASS/VTT)

### その他
- SWARM分散レンダリング（WebRTC）
- インタラクティブ操作（パン/ズーム/クロップ）
- 画面録画（MediaRecorder）
- GPUフォールバック（WebGPU→WebGL2→WebGL1→CPU）
- 区間木（O(log n)クリップクエリ）
- フレームキャッシュ（GOP対応LRU）
- ダイレクトトランスコーダ（ストリーミング変換）
- Flipnote取り込み（KWZ/PPM）

---

## ビルド

```bash
npm install
npm run build    # dist/AegisForge.min.js (271KB)
npm run dev      # watch mode
```

### カスタムビルド

必要なモジュールだけ選んでビルド：

**[https://kikiemi.github.io/AegisForge/builder/](https://kikiemi.github.io/AegisForge/builder/)**

```bash
node build-presets.js my-preset src/core.ts src/effects/bloom.ts src/effects/glitch.ts
```

---

## 使い方

```html
<script src="AegisForge.min.js"></script>
<script>
const core = new AegisForge.AegisCore();
core.config.width = 1920;
core.config.height = 1080;
core.config.fps = 30;

const img = await AegisForge.Img.load('cat.jpg');
const aud = await AegisForge.Aud.load('bgm.mp3');

core.input(img, { start: 0, duration: 5000 });
core.input(aud, { start: 0, duration: 5000, layer: -1 });

const file = await core.save('output.mp4');
</script>
```

---

## 構造

```
src/
├── core.ts              キーフレーム、ベジェ、タイムコード
├── gl.ts                WebGL2/WebGPU レンダラー
├── media.ts             WebCodecs パイプライン
├── AegisMuxer.ts        MP4/MOV/WebM/MKV/AVI/OGG/MP3
├── encoders.ts          GIF/WebP/APNG/WAV
├── codec.ts             コーデック検出
├── interactive.ts       パン/ズーム/クロップ
├── recorder.ts          画面録画
├── worker.ts            Worker合成
├── core/
│   ├── AegisCore.ts     メインエンジン
│   ├── swarm.ts         分散レンダリング
│   ├── transcoder.ts    ストリーミング変換
│   ├── fast_pipeline.ts バッチレンダー
│   ├── frame_cache.ts   GOP対応LRUキャッシュ
│   └── interval_tree.ts AVL区間木
├── demux/               MP4, WebM, MKV, AVI, FLV, OGG
├── effects/             Bloom, Blur, Color, Glitch 等12種
├── audio/               FFT, IMDCT, Worklet 等9種
├── ml/                  WebNN, OptFlow, Segment 等7種
├── text/                SDF, Lottie, Subtitle
├── gpu/                 YUV変換, フォールバック, 色空間
├── timeline/            Magnetic, Multicam, History, Project
├── generators/          Particle
└── extensions/          Pillow (Flipnote)
```

---

## ブラウザ対応

| 機能 | Chrome | Firefox | Safari | Edge | IE |
|------|--------|---------|--------|------|------|
| コア | ✅ 94+ | ✅ 100+ | ✅ 16.4+ | ✅ 94+ | lol |
| WebCodecs | ✅ | ⚠️ Flag | ❌ | ✅ | lol |
| WebGPU | ✅ 113+ | ⚠️ Flag | ✅ 18+ | ✅ | lol |
| WebNN | ✅ 124+ | ❌ | ❌ | ✅ | lol |

---

## ライセンス

WTFPL v2 — 好きにしてください。
