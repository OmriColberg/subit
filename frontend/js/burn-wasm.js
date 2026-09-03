/* ============================================================================
   burn-wasm.js — ffmpeg.wasm subtitle burn-in (runs entirely in the browser)
   Loaded lazily when the user clicks "הורד סרטון עם כתוביות".
   Requires COOP/COEP headers (set in vercel.json).
   ============================================================================ */

// ffmpeg.js and its worker chunk (814.ffmpeg.js) are self-hosted under /js/vendor/
// so the Worker URL resolves to the same origin — cross-origin Workers are blocked
// by browsers even with CORP headers. Core wasm stays on CDN (loaded via fetch).
const FFMPEG_LOCAL_BASE = '/js/vendor';
const FFMPEG_CORE_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd';

let _ffmpeg = null;
let _loaded = false;
let _onProgress = null;

// ── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * Burn subtitles into the video.
 * @param {string}   videoBlobUrl  – state.videoBlobUrl
 * @param {Array}    segments      – state.segments  [{index,start,end,text}]
 * @param {string}   filename      – original filename (for output name)
 * @param {Object}   style         – burn style settings
 * @param {Function} onProgress    – (pct:number, label:string) => void
 * @returns {Promise<Blob>}        – output video blob
 */
async function burnSubtitlesWasm(videoBlobUrl, segments, filename, style, onProgress) {
  onProgress(2, 'טוען מנוע FFmpeg...');

  const ffmpeg = await loadFFmpeg(onProgress);

  onProgress(18, 'מכין קבצים...');

  // Fetch the video blob
  const videoResp = await fetch(videoBlobUrl);
  const videoData = new Uint8Array(await videoResp.arrayBuffer());

  // Detect extension from filename
  const ext = (filename || 'video.mp4').match(/\.([^.]+)$/)?.[1]?.toLowerCase() || 'mp4';
  const inputName = `input.${ext}`;
  const outputName = `output.mp4`;
  const srtName = 'subs.srt';

  // Write files into ffmpeg's virtual FS
  await ffmpeg.writeFile(inputName, videoData);
  await ffmpeg.writeFile(srtName, buildSRTString(segments));

  // libass (used by the subtitles filter) needs at least one font in the FS
  // to render text; without fonts the subtitle layer is invisible.
  await ensureFontInFS(ffmpeg);

  onProgress(25, 'צורב כתוביות...');

  // Build the subtitles filter string
  const filterStr = buildSubtitlesFilter(srtName, style);

  _onProgress = onProgress;
  // -vf subtitles=... burns the SRT into the video stream
  // -c:a copy keeps audio untouched (fast)
  // -preset ultrafast keeps encoding fast at the cost of slightly larger file
  await ffmpeg.exec([
    '-i', inputName,
    '-vf', filterStr,
    '-c:a', 'copy',
    '-preset', 'ultrafast',
    '-movflags', '+faststart',
    outputName
  ]);

  _onProgress = null;
  onProgress(92, 'מוריד...');

  const outData = await ffmpeg.readFile(outputName);

  // Clean up FS to free memory
  try { await ffmpeg.deleteFile(inputName); } catch {}
  try { await ffmpeg.deleteFile(outputName); } catch {}
  try { await ffmpeg.deleteFile(srtName); } catch {}
  try { await ffmpeg.deleteFile('/fonts/DejaVuSans.ttf'); } catch {}

  return new Blob([outData.buffer], { type: 'video/mp4' });
}

// ── INTERNAL ───────────────────────────────────────────────────────────────

async function loadFFmpeg(onProgress) {
  if (_ffmpeg && _loaded) return _ffmpeg;

  // Dynamically load the self-hosted ffmpeg UMD bundle (same-origin so Worker works)
  if (!window.FFmpegWASM) {
    await loadScript(`${FFMPEG_LOCAL_BASE}/ffmpeg.js`);
  }

  const { FFmpeg } = window.FFmpegWASM;
  _ffmpeg = new FFmpeg();

  _ffmpeg.on('progress', ({ progress }) => {
    // ffmpeg reports 0–1; map to 25–90 on our bar
    const pct = Math.round(25 + Math.min(progress, 1) * 65);
    if (_onProgress) _onProgress(pct, `צורב כתוביות... ${Math.round(progress * 100)}%`);
  });

  onProgress(8, 'מוריד ליבת FFmpeg (פעם ראשונה בלבד)...');

  await _ffmpeg.load({
    coreURL: `${FFMPEG_CORE_CDN}/ffmpeg-core.js`,
    wasmURL: `${FFMPEG_CORE_CDN}/ffmpeg-core.wasm`,
  });

  _loaded = true;
  return _ffmpeg;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureFontInFS(ffmpeg) {
  // libass requires at least one font in the virtual FS to render subtitle text.
  // We self-host DejaVuSans.ttf (Hebrew-capable) and write it to /fonts/ each run.
  try {
    await ffmpeg.createDir('/fonts');
  } catch {}
  const resp = await fetch('/js/vendor/DejaVuSans.ttf');
  const data = new Uint8Array(await resp.arrayBuffer());
  await ffmpeg.writeFile('/fonts/DejaVuSans.ttf', data);
}

function buildSRTString(segments) {
  return segments.map(s =>
    `${s.index}\n${s.start} --> ${s.end}\n${s.text}\n`
  ).join('\n');
}

function buildSubtitlesFilter(srtPath, style) {
  // Map our color names to FFmpeg color format
  const colorMap = {
    white: '&Hffffff', yellow: '&H00ffff', black: '&H000000',
    cyan: '&Hffff00', lime: '&H88ff00', red: '&H4444ff',
    orange: '&H0099ff', pink: '&Hcc88ff'
  };
  // FFmpeg subtitle colors use BGR hex with & prefix (&Hbbggrr)
  const primaryColor = colorMap[style.color] || '&Hffffff';

  // Outline / shadow color
  const outlineColorMap = {
    black: '&H000000', white: '&Hffffff',
    'dark-shadow': '&H000000', none: '&H000000'
  };
  const outlineColor = outlineColorMap[style.outline] || '&H000000';
  const hasShadow = style.outline === 'dark-shadow';
  const hasOutline = style.outline !== 'none';

  // libass uses PlayResY=288 as its virtual coordinate space for SRT input.
  // A FontSize of X in that space renders as X * (native_video_height / 288) px.
  // We want the burned font to occupy the same fraction of video height as the
  // browser CSS font (size px) occupies of the rendered video element height.
  // => fontSizeAss = fontSize * 288 / cssVideoHeight
  const cssVideoHeight = style.cssVideoHeight || 400;
  const fontSize = Math.max(1, Math.round((style.fontSize || 24) * 288 / cssVideoHeight));

  // VTT uses line:X% (top of cue from top of video).
  // ASS Alignment=2: MarginV is distance (in PlayResY=288 units) from bottom to bottom of text.
  // To match: bottom-of-text fraction from bottom = (1 - X/100) - fontSize/288
  // => MarginV = (1 - X/100) * 288 - fontSize
  const linePctMap = {
    'very-bottom': 96, 'bottom': 88, 'center-bottom': 72,
    'center': 50, 'center-top': 30, 'top': 12, 'very-top': 5,
  };
  const linePct = linePctMap[style.position] ?? 88;
  const marginV = Math.max(0, Math.round((1 - linePct / 100) * 288 - fontSize));

  // Bold / italic
  const bold = style.fontStyle?.includes('bold') ? 1 : 0;
  const italic = style.fontStyle?.includes('italic') ? 1 : 0;

  // Background box opacity (0–80 → alpha 0–128 in hex)
  const bgAlpha = style.bgOpacity > 0
    ? Math.round((1 - style.bgOpacity / 100) * 255).toString(16).padStart(2, '0').toUpperCase()
    : 'FF';
  const backColor = style.bgOpacity > 0 ? `&H${bgAlpha}000000` : '&H00000000';

  const force_style = [
    `FontName=DejaVu Sans`,
    `FontSize=${fontSize}`,
    `PrimaryColour=${primaryColor}`,
    `OutlineColour=${outlineColor}`,
    `BackColour=${backColor}`,
    `Bold=${bold}`,
    `Italic=${italic}`,
    `Outline=${hasOutline ? 2 : 0}`,
    `Shadow=${hasShadow ? 3 : 0}`,
    `Alignment=2`,  // bottom-center in SSA
    `MarginV=${marginV}`,
  ].join(',');

  // Escape the path for ffmpeg filter (colons must be escaped)
  const escapedPath = srtPath.replace(/:/g, '\\:');
  // fontsdir points to where we wrote DejaVuSans.ttf in the virtual FS
  return `subtitles=${escapedPath}:fontsdir=/fonts:force_style='${force_style}'`;
}
