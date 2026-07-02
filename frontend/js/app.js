/* ============================================================================
   Subit — מחולל כתוביות בעברית
   Frontend application logic
   ----------------------------------------------------------------------------
   CONTENTS
     1.  CONFIG & STATE        — API endpoint, app state, undo stack
     2.  THEME                 — dark/light toggle
     3.  MODE & TRANSCRIPT     — file-only vs with-text mode
     4.  DRAG & DROP / UPLOAD  — file selection, transcription request
     5.  TIMER                 — elapsed-time display during processing
     6.  SUBTITLE LIST         — render, insert, delete, reindex
     7.  TIME EDITING          — MM:SS.d format, cascade logic
     8.  CHANGE HANDLERS       — segment edits, plain-text sync, autosave
     9.  PERSIST & DOWNLOAD    — save SRT, download SRT
     10. AI                    — auto-fix, manual fix, align-with-transcript
     11. CLAUDE COPY/PASTE     — manual correction round-trip
     12. VIDEO PLAYER          — fullscreen, subtitle overlay, seek
     13. BURN PREVIEW/STYLES   — subtitle styling (server burn pending)
     14. UI CHROME             — tabs, steps, progress, modals, reset
     15. UTILITIES             — time conversion, toast, icons
   ============================================================================ */

const API = 'https://subit-ifhy.onrender.com';

// ── STATE ─────────────────────────────────────────────────────────
let state = { videoId:null, filename:null, segments:[], videoBlobUrl:null };
let selectedFile = null;

// ── UNDO STACK ────────────────────────────────────────────────────
const undoStack = [];
const MAX_UNDO  = 30;
let inEditSession = false, editSessionTimer = null;

function pushUndo() {
  undoStack.push(JSON.parse(JSON.stringify(state.segments)));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoBtn();
}
function undoChange() {
  if (!undoStack.length) return;
  state.segments = undoStack.pop();
  inEditSession = false;
  renderSRTList(); syncPlainText(); persistSRT(); updateUndoBtn();
  toast('info','שינוי בוטל');
}
function updateUndoBtn() {
  const btn = document.getElementById('undo-btn');
  btn.style.display = undoStack.length ? 'inline-flex' : 'none';
  if (undoStack.length)
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg> בטל שינוי${undoStack.length>1?' ('+undoStack.length+')':''}`;
}
function getPlainText() { return state.segments.map(s=>s.text).join('\n'); }

// ── THEME ─────────────────────────────────────────────────────────
const moonSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>';
const sunSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
// Default: light mode. Saved preference overrides.
let isLight = localStorage.getItem('theme') !== 'dark';
function applyTheme() {
  document.documentElement.classList.toggle('light', isLight);
  document.getElementById('theme-btn').innerHTML = isLight ? moonSvg + ' חושך על פני תהום' : sunSvg + ' יהי אור';
}
function toggleTheme() {
  isLight = !isLight;
  applyTheme();
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
}
applyTheme();
// AI powered by Gemini (key stored server-side)

// ── TRANSCRIPT HINT ───────────────────────────────────────────────
function selectMode(mode) {
  document.getElementById('mode-file-only').classList.toggle('active', mode === 'file-only');
  document.getElementById('mode-with-text').classList.toggle('active', mode === 'with-text');
  const area = document.getElementById('transcript-area');
  area.style.display = mode === 'with-text' ? 'block' : 'none';
  if (mode === 'with-text') {
    document.getElementById('transcript-hint').focus();
  }
}

// ── DRAG & DROP ───────────────────────────────────────────────────
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', e=>{e.preventDefault();dropZone.classList.add('dragover')});
dropZone.addEventListener('dragleave', ()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e=>{
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFileSelected(e.dataTransfer.files[0]);
});
document.getElementById('file-input').addEventListener('change', e=>{
  if (e.target.files.length) handleFileSelected(e.target.files[0]);
});

// File selection - show estimate box with start button
const MAX_FILE_MB = 500;

function handleFileSelected(file) {
  const sizeMB = file.size/1024/1024;
  if (sizeMB > MAX_FILE_MB) {
    toast('error', `הקובץ גדול מדי (${sizeMB.toFixed(0)}MB). מקסימום ${MAX_FILE_MB}MB.`);
    document.getElementById('file-input').value = '';
    return;
  }
  selectedFile = file;
  const safeMins = Math.max(1, Math.round(sizeMB/50));

  // Store blob URL for video player
  if (state.videoBlobUrl) URL.revokeObjectURL(state.videoBlobUrl);
  state.videoBlobUrl = URL.createObjectURL(file);

  // Hide drop zone, show file info
  document.getElementById('drop-zone').style.display = 'none';
  document.getElementById('file-selected-state').style.display = 'block';
  document.getElementById('selected-filename').textContent = file.name;
  document.getElementById('selected-filesize').textContent = sizeMB.toFixed(1) + ' MB';

  // Show estimate
  document.getElementById('est-size').textContent = sizeMB.toFixed(1)+' MB';
  document.getElementById('est-time').textContent = '-';
  document.getElementById('est-duration').textContent = '-';
  document.getElementById('estimate-box').style.display = 'block';
  document.getElementById('start-section').style.display = 'block';
  document.getElementById('timer-section').style.display = 'none';
  document.getElementById('timer-display').textContent = '0%';

  // Read video/audio duration
  const tempMedia = document.createElement(file.type.startsWith('audio') ? 'audio' : 'video');
  const blobUrl = URL.createObjectURL(file);
  tempMedia.src = blobUrl;
  tempMedia.addEventListener('loadedmetadata', () => {
    const dur = tempMedia.duration;
    URL.revokeObjectURL(blobUrl);
    if (!isFinite(dur)) return;
    const durMins = Math.floor(dur/60);
    const durSecs = Math.floor(dur%60);
    document.getElementById('est-duration').textContent =
      durMins > 0 ? `${durMins}:${String(durSecs).padStart(2,'0')} דקות` : `${durSecs} שניות`;
    // Estimate: ~0.5x realtime on CPU with medium model
    const estSecs = dur * 1.5; // ~1.5x realtime on CPU with medium model
    const estMins = Math.max(1, Math.round(estSecs/60));
    document.getElementById('est-time').textContent =
      estMins <= 1 ? '1–2 דקות' : `${estMins}–${estMins+1} דקות`;
  }, { once: true });
}

function resetSettings() {
  // Reset max words
  const mw = document.getElementById('max-words');
  if (mw) mw.value = '4';
  // Reset burn/style to defaults
  const defaults = {
    'burn-font':'Arial','burn-position':'bottom','burn-color':'white',
    'burn-outline':'none','burn-fontsize':'24','burn-style':'normal','burn-bg-opacity':'0'
  };
  Object.entries(defaults).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
  const fsv = document.getElementById('font-size-val');
  if (fsv) fsv.textContent = '24';
  const bgv = document.getElementById('bg-opacity-val');
  if (bgv) bgv.textContent = '0';
  updateBurnPreview();
  applyBurnStylesToOverlay();
}

function confirmClearFile() {
  if (state.segments.length > 0) {
    document.getElementById('confirm-modal').classList.add('show');
  } else {
    clearFileSelection();
    resetSettings();
  }
}

function clearFileSelection() {
  // Abort ongoing upload if any
  if (uploadAbortController) {
    uploadAbortController.abort();
    uploadAbortController = null;
    stopTimer();
    showProgress(false);
    setStep(1);
  }
  selectedFile = null;
  document.getElementById('drop-zone').style.display = 'block';
  document.getElementById('file-selected-state').style.display = 'none';
  document.getElementById('estimate-box').style.display = 'none';
  document.getElementById('file-input').value = '';
  document.getElementById('start-section').style.display = 'block';
  document.getElementById('timer-section').style.display = 'none';
  const clearBtn = document.querySelector('[onclick="clearFileSelection()"]');
  if (clearBtn) clearBtn.disabled = false;
  resetSettings();
}

// ── TIMER ─────────────────────────────────────────────────────────
let timerInterval = null;
function startTimer() {
  const t0 = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    const bar = document.getElementById('progress-bar');
    const el  = document.getElementById('timer-display');
    if (bar && el) el.textContent = Math.round(parseFloat(bar.style.width)||0) + '%';
  }, 200);
}
function stopTimer() {
  clearInterval(timerInterval); timerInterval = null;
  const el = document.getElementById('timer-display');
  if (el) el.textContent = '100%';
}

// ── START TRANSCRIPTION (called by button) ────────────────────────
function startTranscription() {
  if (!selectedFile) return;
  // Hide start button, show timer
  document.getElementById('start-section').style.display = 'none';
  document.getElementById('timer-section').style.display = 'block';
  document.getElementById('timer-display').textContent = '0%';
  uploadFile(selectedFile);
}

// ── UPLOAD ────────────────────────────────────────────────────────
let uploadAbortController = null;

async function uploadFile(file) {
  uploadAbortController = new AbortController();
  const clearBtn = document.querySelector('[onclick="clearFileSelection()"]');
  if (clearBtn) clearBtn.disabled = true;
  setStep(2); showProgress(true,'מעלה קובץ...'); animateProgress(0,12,1200); startTimer();
  const form = new FormData();
  form.append('file', file);
  const hint = document.getElementById('transcript-hint').value.trim();
  if (hint) form.append('initial_prompt', hint);
  const maxWordsRaw = document.getElementById('max-words').value.trim();
  const maxWords = maxWordsRaw !== '' ? parseInt(maxWordsRaw) : 0;
  if (maxWords > 0) {
    form.append('max_words_per_line', String(maxWords));
  }

  try {
    showProgress(true,'מתמלל...'); animateProgressSlow(15,70);
    const res = await fetch(`${API}/transcribe`,{method:'POST',body:form});
    if (!res.ok){const e=await res.json().catch(()=>({detail:res.statusText}));throw new Error(e.detail);}
    const data = await res.json();
animateProgress(85,92,400); await sleep(400);
    uploadAbortController = null;
    const clearBtnOk = document.querySelector('[onclick="clearFileSelection()"]');
    if (clearBtnOk) clearBtnOk.disabled = false;
    state.videoId  = data.video_id;
    state.filename = data.filename;
    state.segments = data.segments;

    if (hint) {
      showProgress(true, 'מעדכן לפי הטקסט שסיפקת...');
      animateProgressSlow(92, 98);
      await runAlignWithTranscript(hint, true);
    } else {
      showProgress(true, 'משפר דיוק כתוביות...');
      animateProgressSlow(92, 98);
      await autoAiFix(true);
    }

    animateProgress(98,100,300); await sleep(300);
    stopTimer();
    showProgress(false);
    document.getElementById('estimate-box').style.display='none';
    showResults();
    setStep(3);
  } catch(err){
    stopTimer(); showProgress(false); setStep(1);
    document.getElementById('start-section').style.display = 'block';
  document.getElementById('timer-section').style.display = 'none';

    toast('error',`שגיאה: ${err.message}`);
  }
}

// ── RENDER ────────────────────────────────────────────────────────
function showResults() {
  undoStack.length = 0;  // clean slate for new results
  document.getElementById('results-section').style.display='block';
  document.getElementById('action-row').style.display='flex';

  // Show align btn if transcript was provided
  const hasTranscript = document.getElementById('transcript-hint').value.trim().length > 0;
  // align runs automatically — no button needed
  renderSRTList(); syncPlainText();
  document.getElementById('srt-count').textContent=`${state.segments.length} כתוביות`;
  // Load video player
  if (state.videoBlobUrl) {
    const player = document.getElementById('video-player');
    player.src = state.videoBlobUrl;
    document.getElementById('video-no-file').style.display = 'none';
    document.getElementById('video-wrap').style.display = 'flex';
    document.getElementById('download-row').style.display = 'block';
    document.getElementById('video-wrap').classList.add('has-video');  // enables hover-show of fs-btn
    // Detect orientation → portrait gets special handling; landscape stays
    // class-less so it behaves exactly like the original layout.
    player.addEventListener('loadedmetadata', () => {
      const wrap = document.getElementById('video-wrap');
      const isPortrait = player.videoHeight > player.videoWidth;
      wrap.classList.toggle('is-portrait', isPortrait);
    }, { once: true });
    setTimeout(applyBurnStylesToOverlay, 100);
  }

}

function formatTimeDisplay(ts) {
  // SRT "HH:MM:SS,mmm" → display "MM:SS.d" (total minutes, no hours)
  // e.g. "00:01:23,456" → "1:23.4"  |  "01:30:45,200" → "90:45.2"
  // Work in integer ms to avoid floating-point artifacts (0.2s ≠ 0.19999...)
  const totalMs  = Math.round(srtToSec(ts) * 1000);
  const totalSec = Math.floor(totalMs / 1000);
  const tenths   = Math.floor((totalMs % 1000) / 100);
  const totalMin = Math.floor(totalSec / 60);
  const secs     = totalSec % 60;
  return `${totalMin}:${String(secs).padStart(2,'0')}.${tenths}`;
}

function parseTimeInput(val) {
  // "MM:SS.d" or "MM:SS,d" → SRT "HH:MM:SS,mmm"
  // Accepts: "1:23.4"  "90:45"  "90:45.2"  "1:23,456"
  val = val.trim().replace(',', '.');
  const m = val.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (!m) return null;
  const totalMin = parseInt(m[1], 10);
  const sec      = parseInt(m[2], 10);
  const fracStr  = (m[3] || '0').padEnd(3, '0').slice(0, 3);
  const h        = Math.floor(totalMin / 60);
  const mins     = totalMin % 60;
  return `${String(h).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(sec).padStart(2,'0')},${fracStr}`;
}

function renderSRTList() {
  const trashSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>';
  const plusSvg  = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
  const cntEl = document.getElementById('srt-count'); if(cntEl) cntEl.textContent = `${state.segments.length} כתוביות`;
  document.getElementById('srt-list').innerHTML = state.segments.map((seg, i) => {
    const isEmpty = !seg.text.trim();
    return `
    <div class="srt-item${isEmpty ? ' is-empty' : ''}" onclick="seekToSubtitleIfNotFocused(event,${i})" style="cursor:pointer">
      <div class="srt-num-col">
        <div class="srt-num">${seg.index}</div>
        <div class="srt-btn-area">
          <button class="srt-delete-btn" data-delete-idx="${i}">${trashSvg}<span>מחק</span></button>
          <button class="srt-insert-after-btn" data-insert-after="${i}" title="הוסף כתובית אחרי זו">${plusSvg}<span>הוסף</span></button>
        </div>
      </div>
      <div>
        <div class="srt-time">
          <input class="time-input" value="${formatTimeDisplay(seg.start)}" data-idx="${i}" data-field="start" oninput="onSegChange(this)" onblur="normalizeTimeInput(this)" onkeydown="if(event.key==='Enter'){this.blur();event.preventDefault()}"/>
          <span style="color:var(--muted);margin:0 4px;font-size:16px;font-weight:700">←</span>
          <input class="time-input" value="${formatTimeDisplay(seg.end)}" data-idx="${i}" data-field="end" oninput="onSegChange(this)" onblur="normalizeTimeInput(this)" onkeydown="if(event.key==='Enter'){this.blur();event.preventDefault()}"/>
        </div>
        <textarea class="text-input" rows="2" data-idx="${i}" data-field="text"
          oninput="onSegChange(this);this.closest('.srt-item').classList.toggle('is-empty',!this.value.trim())"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){this.blur();event.preventDefault()}"
        >${seg.text}</textarea>
      </div>
    </div>`;
  }).join('');
}

// ── INSERT / DELETE — event delegation on srt-list ──────────────
// Script is at bottom of body so DOM is ready — no DOMContentLoaded needed
document.getElementById('srt-list').addEventListener('click', function(e) {
  const insertBtn = e.target.closest('[data-insert-after]');
  if (insertBtn) {
    e.stopPropagation();
    insertSegmentAfter(+insertBtn.dataset.insertAfter);
    return;
  }
  const deleteBtn = e.target.closest('[data-delete-idx]');
  if (deleteBtn) {
    e.stopPropagation();
    deleteSegmentAt(+deleteBtn.dataset.deleteIdx);
  }
});

function insertSegmentAfter(i) {
  pushUndo();
  const segs = state.segments;
  const curr = segs[i];
  const next = segs[i + 1];
  // Times stored as SRT strings → convert to seconds for math
  const startSec = srtToSec(curr.end);
  const endSec   = next ? srtToSec(next.start) : startSec + 2;
  const midSec   = (startSec + endSec) / 2;
  segs.splice(i + 1, 0, {
    index: 0,
    start: curr.end,           // new subtitle starts where prev ends
    end:   secToSrt(midSec),   // ends at midpoint of the gap
    text:  ''
  });
  reindexSegments();
  renderSRTList(); syncPlainText(); persistSRT();
  setTimeout(() => {
    const textareas = document.querySelectorAll('#srt-list .text-input');
    if (textareas[i + 1]) {
      textareas[i + 1].focus();
      textareas[i + 1].closest('.srt-item').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, 40);
}

function deleteSegmentAt(i) {
  pushUndo();
  state.segments.splice(i, 1);
  reindexSegments();
  renderSRTList(); syncPlainText(); persistSRT(); updateUndoBtn();
}

// ── REINDEX ───────────────────────────────────────────────────────
function reindexSegments() {
  state.segments.forEach((s, i) => s.index = i + 1);
}

// Plain text: one line per subtitle
function syncPlainText() {
  document.getElementById('plain-text-area').value = getPlainText();
}

// ── CHANGE HANDLERS ───────────────────────────────────────────────
let autoSaveTimer=null, plainSyncTimer=null;

// ── TIME EDITING LOGIC ───────────────────────────────────────────
// cascadeForward: push subtitles idx+1, idx+2, ... forward as needed
// to eliminate overlaps, preserving each subtitle's duration.
function cascadeForward(idx, fromSec) {
  const segs = state.segments;
  let frontier = fromSec;
  for (let i = idx + 1; i < segs.length; i++) {
    const startSec = srtToSec(segs[i].start);
    if (startSec >= frontier - 0.001) break; // no overlap → done
    const dur = Math.max(srtToSec(segs[i].end) - startSec, 0.1);
    segs[i].start = secToSrt(frontier);
    segs[i].end   = secToSrt(frontier + dur);
    frontier      = frontier + dur;
  }
}

function normalizeTimeInput(el) {
  const field = el.dataset.field;
  if (field !== 'start' && field !== 'end') return;

  const idx  = +el.dataset.idx;
  const segs = state.segments;
  const seg  = segs[idx];

  // Parse input → SRT string
  const srtVal = parseTimeInput(el.value);
  if (!srtVal) {
    el.value = formatTimeDisplay(seg[field]);
    toast('error', 'פורמט זמן לא תקין — השתמש ב-MM:SS.d');
    return;
  }
  const newSec = srtToSec(srtVal);

  if (field === 'end') {
    const startSec = srtToSec(seg.start);

    // ── Rule: end must be > start + 0.1s ──────────────────────────
    if (newSec <= startSec + 0.1) {
      seg.end  = secToSrt(startSec + 0.1);
      el.value = formatTimeDisplay(seg.end);
      toast('error', 'זמן סיום חייב להיות אחרי זמן התחלה');
      renderSRTList();
      scheduleAutoSave();
      return;
    }

    // Apply, then cascade forward if overlapping next subtitle
    seg.end = srtVal;
    cascadeForward(idx, newSec);

  } else { // field === 'start'
    const prevEndSec   = idx > 0 ? srtToSec(segs[idx - 1].end)   : 0;
    const prevStartSec = idx > 0 ? srtToSec(segs[idx - 1].start) : 0;
    const curEndSec    = srtToSec(seg.end);
    const dur          = Math.max(curEndSec - srtToSec(seg.start), 0.1);

    // ── Rule: start cannot go before previous subtitle's START ─────
    //    Reject the edit entirely — revert the input, change nothing.
    if (idx > 0 && newSec < prevStartSec - 0.001) {
      el.value = formatTimeDisplay(seg.start);  // restore original, no change
      toast('error', 'לא ניתן לחפוף עם תחילת הכתובית הקודמת');
      return;
    }

    // ── If new start overlaps previous subtitle's END (but not start):
    //    Shorten previous subtitle's end to match. ───────────────────
    if (idx > 0 && newSec < prevEndSec - 0.001) {
      segs[idx - 1].end = srtVal;
    }

    seg.start = srtVal;

    if (newSec < curEndSec) {
      // ── Moving start forward but before current end:
      //    Just shorten the subtitle (end stays). ─────────────────
    } else {
      // ── Moving start past current end:
      //    Preserve duration, compute new end, cascade if needed. ──
      const newEndSec = newSec + dur;
      seg.end = secToSrt(newEndSec);
      cascadeForward(idx, newEndSec);
    }
  }

  el.value = formatTimeDisplay(seg[field]);
  renderSRTList();
  scheduleAutoSave();
}

function onSegChange(el) {
  if (!inEditSession) { pushUndo(); inEditSession=true; }
  clearTimeout(editSessionTimer);
  editSessionTimer = setTimeout(()=>{ inEditSession=false; }, 2000);
  const field = el.dataset.field;
  const idx   = +el.dataset.idx;
  if (field === 'text') {
    state.segments[idx][field] = el.value;
    syncPlainText();
    scheduleAutoSave();
  }
  // Time fields: only save on blur via normalizeTimeInput, NOT here
}

function onPlainTextChange() {
  clearTimeout(plainSyncTimer);
  plainSyncTimer = setTimeout(()=>{
    if (!inEditSession) { pushUndo(); inEditSession=true; }
    clearTimeout(editSessionTimer);
    editSessionTimer = setTimeout(()=>{ inEditSession=false; }, 2000);
    distributePlainText(document.getElementById('plain-text-area').value);
    renderSRTList();
    scheduleAutoSave();
  }, 600);
}

function distributePlainText(raw) {
  // Split by newlines first - each line = one subtitle
  const lines = raw.split('\n').map(l=>l.trim()).filter(Boolean);

  if (lines.length === state.segments.length) {
    // Perfect 1:1 mapping
    lines.forEach((line,i)=>{ state.segments[i].text = line; });
  } else if (lines.length > 1) {
    // More lines than segments - merge or redistribute by time
    const totalDur = state.segments.reduce((s,seg)=>s+segDur(seg),0)||1;
    // Distribute line-groups proportionally
    const allText = lines.join(' ');
    const words = allText.split(/\s+/).filter(Boolean);
    let wi=0;
    state.segments.forEach((seg,i)=>{
      const count = i===state.segments.length-1
        ? words.length-wi
        : Math.round((segDur(seg)/totalDur)*words.length);
      seg.text = words.slice(wi,wi+count).join(' ');
      wi+=count;
    });
  } else {
    // Single paragraph - distribute by time
    const words = raw.split(/\s+/).filter(Boolean);
    const totalDur = state.segments.reduce((s,seg)=>s+segDur(seg),0)||1;
    let wi=0;
    state.segments.forEach((seg,i)=>{
      const count = i===state.segments.length-1
        ? words.length-wi
        : Math.round((segDur(seg)/totalDur)*words.length);
      seg.text = words.slice(wi,wi+count).join(' ');
      wi+=count;
    });
  }
}

function scheduleAutoSave(){
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async()=>{ await persistSRT(); showAutosaved(); }, 1500);
}
function showAutosaved(){
  const el=document.getElementById('autosave-indicator');
  el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2500);
}

// ── FULLSCREEN: custom button on .video-wrap ──────────────────────
function toggleVideoFullscreen() {
  const wrap = document.getElementById('video-wrap');
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  if (!isFs) {
    const req = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (req) req.call(wrap);
  } else {
    const ex = document.exitFullscreen || document.webkitExitFullscreen;
    if (ex) ex.call(document);
  }
}
// Toggle icon when fullscreen changes
function onFsChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const expand   = document.getElementById('fs-icon-expand');
  const compress = document.getElementById('fs-icon-compress');
  if (expand)   expand.style.display   = isFs ? 'none'  : 'block';
  if (compress) compress.style.display = isFs ? 'block' : 'none';
}
document.addEventListener('fullscreenchange',       onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

// ── PERSIST ───────────────────────────────────────────────────────
async function persistSRT(){
  if (!state.videoId) return;
  await fetch(`${API}/save-srt`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({video_id:state.videoId,segments:state.segments})}).catch(()=>{});
}

// ── DOWNLOAD SRT ──────────────────────────────────────────────────
async function downloadSRT(){
  if (!state.videoId) return;
  const baseName=(state.filename||'subtitles').replace(/\.[^.]+$/,'');
  const srtContent=state.segments.map(s=>`${s.index}\n${s.start} --> ${s.end}\n${s.text}\n`).join('\n');
  if (window.showSaveFilePicker){
    try{
      const h=await window.showSaveFilePicker({suggestedName:`${baseName}.srt`,types:[{description:'SRT',accept:{'text/plain':['.srt']}}]});
      const w=await h.createWritable(); await w.write(srtContent); await w.close();
      setStepDone(3); toast('success',`${baseName}.srt נשמר`); return;
    }catch(e){ if(e.name==='AbortError') return; }
  }
  const blob=new Blob([srtContent],{type:'text/plain;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=`${baseName}.srt`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  setStepDone(3); toast('success',`${baseName}.srt הורד`);
}

// ── COPY ──────────────────────────────────────────────────────────
function copyText(){
  navigator.clipboard.writeText(getPlainText())
    .then(()=>toast('success','הטקסט הועתק ללוח'))
    .catch(()=>toast('error','שגיאה בהעתקה'));
}

// ── SEND TO CLAUDE (copy prompt) ─────────────────────────────────
// ── AI PROGRESS ──────────────────────────────────────────────────
let aiTimerInterval = null;

function startAIProgress(label) {
  // Show progress bar
  document.getElementById('ai-progress').style.display = 'block';
  document.getElementById('ai-progress-label').textContent = label;
  document.getElementById('ai-progress-bar').style.width = '5%';
  document.getElementById('ai-timer-display').textContent = '60s';
  // Lock editor with overlay
  const overlay = document.getElementById('srt-loading-overlay');
  document.getElementById('srt-loading-label').textContent = label;
  overlay.classList.add('show');
  // Disable AI buttons
  const pBtn=document.getElementById('paste-btn'); if(pBtn) pBtn.disabled=true;
  let displayed = 0;
  let countdown = 60;
  const tau = 20;
  const s0 = Date.now();
  aiTimerInterval = setInterval(() => {
    const elapsed = (Date.now()-s0)/1000;
    const target = Math.min(90, Math.round(90*(1-Math.exp(-elapsed/tau))));
    if (displayed < target) displayed++;
    document.getElementById('ai-progress-bar').style.width = displayed + '%';
    // Countdown from 60
    countdown = Math.max(0, 60 - Math.floor(elapsed));
    document.getElementById('ai-timer-display').textContent = countdown > 0 ? countdown + 's' : '...';
  }, 500);
}

function stopAIProgress() {
  clearInterval(aiTimerInterval);
  aiTimerInterval = null;
  const bar = document.getElementById('ai-progress-bar');
  bar.style.width = '100%';
  // Unlock editor
  document.getElementById('srt-loading-overlay').classList.remove('show');
  // Re-enable AI buttons
  const pBtnR=document.getElementById('paste-btn'); if(pBtnR) pBtnR.disabled=false;
  setTimeout(() => {
    document.getElementById('ai-progress').style.display = 'none';
    bar.style.width = '5%';
  }, 600);
}

async function autoAiFix(silent = false) {
  // Runs automatically after transcription - silent, shows status
  // silent=true: called as part of the unified upload progress bar
  //   (uploadFile manages its own progress UI, so skip the separate overlay)
  if (!silent) startAIProgress('משפר דיוק כתוביות...');
  try {
    const res = await fetch(`${API}/ai-fix`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ segments: state.segments, video_id: state.videoId || '-' }),
    });
    if (!res.ok) throw new Error('AI fix failed silently');
    const data = await res.json();
    state.segments = data.segments;
    undoStack.length = 0;
    updateUndoBtn();
    renderSRTList(); syncPlainText(); await persistSRT();
    toast('success', `תמלול הושלם ותוקן - ${state.segments.length} כתוביות`);
  } catch(err) {
    toast('success', `תמלול הושלם - ${state.segments.length} כתוביות`);
  } finally {
    if (!silent) stopAIProgress();
  }
}

async function aiFixText(){
  // ai-btn removed from UI; AI fix runs via autoAiFix
  startAIProgress('AI סורק ומתקן שגיאות...');
  try {
    const res = await fetch(`${API}/ai-fix`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ segments: state.segments, video_id: state.videoId || '-' }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.detail || 'שגיאה'); }
    const data = await res.json();
    state.segments = data.segments;
    renderSRTList(); syncPlainText(); await persistSRT();
    toast('success', 'AI תיקן את הכתוביות ✨');
  } catch(err) {
    toast('error', `שגיאה: ${err.message}`);
  } finally {
    stopAIProgress();
    // ai-btn removed
  }
}

function copyForClaude(){
  const lines = state.segments.map(s=>`${s.index}. ${s.text}`).join('\n');
  const maxW  = parseInt(document.getElementById('max-words').value)||0;
  const maxWLine = maxW>0 ? `\nחשוב: כל כתובית יכולה להכיל לכל היותר ${maxW} מילים. אם שורה ארוכה יותר - חלק אותה לשורות נפרדות בשיקול דעת לפי ההקשר, ועדכן את המספור בהתאם.` : '';
  const prompt = `להלן כתוביות בעברית שנוצרו אוטומטית ועלולות להכיל שגיאות תמלול.
תשמור על הטקסט בדיוק כמו שהוא, רק תתקן מילים שברור שאינן נכונות למילים הנכונות.
אם אתה לא בטוח - אל תיגע. החזר בדיוק אותן שורות עם אותם מספרים בפורמט: מספר. טקסט${maxWLine}

${lines}`;
  navigator.clipboard.writeText(prompt).then(()=>{
    toast('success','הבקשה הועתקה! הדבק ב-Claude.ai וקבל תיקון');
    document.getElementById('paste-btn').style.display='inline-flex';
    document.getElementById('action-row').style.display='flex';
  }).catch(()=>toast('error','שגיאה בהעתקה'));
}

// ── PASTE FROM CLAUDE ─────────────────────────────────────────────
function pasteFromClaude(){
  document.getElementById('paste-area').value='';
  document.getElementById('paste-modal').classList.add('show');
}
function applyPastedCorrection(){
  const raw=document.getElementById('paste-area').value.trim();
  if (!raw) return;
  pushUndo();
  const newSegs = [];
  for (const line of raw.split('\n')){
    const m = line.trim().match(/^(\d+)\.\s*(.+)/);
    if (m) newSegs.push({ index:parseInt(m[1]), text:m[2].trim() });
  }
  if (newSegs.length > 0){
    // If count matches - update text only
    if (newSegs.length === state.segments.length){
      newSegs.forEach((ns,i)=>{ state.segments[i].text=ns.text; });
    } else {
      // More segments (e.g. after splitting long lines) - rebuild with interpolated timestamps
      const totalDur = state.segments.reduce((s,seg)=>s+segDur(seg),0)||1;
      const totalWords = newSegs.reduce((s,ns)=>s+ns.text.split(' ').length,0)||1;
      let t=srtToSec(state.segments[0]?.start||'00:00:00,000');
      const end=srtToSec(state.segments[state.segments.length-1]?.end||'00:00:01,000');
      state.segments = newSegs.map((ns,i)=>{
        const wFrac=ns.text.split(' ').length/totalWords;
        const dur=(end-t)*(i===newSegs.length-1?1:wFrac/(1-(i*wFrac/newSegs.length)));
        const segEnd=i===newSegs.length-1?end:t+totalDur*wFrac;
        const seg={ index:i+1, start:secToSrt(t), end:secToSrt(Math.min(segEnd,end)), text:ns.text };
        t=segEnd;
        return seg;
      });
    }
  }
  renderSRTList(); syncPlainText(); persistSRT();
  closeModal('paste-modal');
  toast('success','התיקון הוחל ✨');
}

// ── ALIGN WITH TRANSCRIPT (called automatically after transcription) ──
async function runAlignWithTranscript(transcript, silent = false) {
  if (!transcript) transcript = document.getElementById('transcript-hint').value.trim();
  if (!transcript) { toast('error', 'לא נמצא טקסט'); return; }
  if (!silent) startAIProgress('מעדכן כתוביות לפי הטקסט שסיפקת...');
  try {
    const res = await fetch(`${API}/align-with-transcript`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ segments: state.segments, transcript, video_id: state.videoId || '-' }),
    });
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.detail || 'שגיאה'); }
    const data = await res.json();
    state.segments = data.segments;
    renderSRTList(); syncPlainText(); await persistSRT();
    toast('success', 'הכתוביות עודכנו לפי הטקסט שסיפקת ✨');
  } catch(err) {
    toast('error', err.message);
  } finally {
    if (!silent) stopAIProgress();
  }
}

// ── ALIGN FROM PLAIN TEXT (uses Gemini align endpoint) ─────────────
async function alignFromPlainText() {
  const transcript = document.getElementById('transcript-hint').value.trim();
  if (!transcript) {
    toast('error', 'לא הוזן טקסט מקורי - פתח את תיבת הטקסט למעלה והדבק');
    return;
  }
  const btn = document.getElementById('align-plain-btn');
  btn.disabled = true;
  await runAlignWithTranscript(transcript);
  btn.disabled = false;
}

// ── VIDEO SUBTITLE SYNC ──────────────────────────────────────────
// ── VIDEO SUBTITLE OVERLAY ───────────────────────────────────────
let _lastActiveIdx = -1;

function setActiveSubtitle(idx) {
  if (idx === _lastActiveIdx) return;
  _lastActiveIdx = idx;
  document.querySelectorAll('.srt-item').forEach((el, i) => {
    el.classList.toggle('active-sub', i === idx);
  });
  if (idx >= 0 && document.activeElement?.closest('.srt-item') === null) {
    const el = document.querySelectorAll('.srt-item')[idx];
    if (el) el.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
}
function syncOverlaySubtitle() {
  const video   = document.getElementById('video-player');
  const overlay = document.getElementById('video-sub-overlay');
  if (!video || !overlay || !state.segments.length) return;
  const t = video.currentTime;
  const t2 = Math.round(t * 10) / 10; // round to 0.1s for better matching
  const segIdx = state.segments.findIndex(s => t2 >= srtToSec(s.start) && t2 <= srtToSec(s.end) + 0.05);
  overlay.textContent = segIdx >= 0 ? state.segments[segIdx].text : '';

  // Highlight active subtitle
  if (segIdx !== _lastActiveIdx) {
    setActiveSubtitle(segIdx);
  }
}

// Track which srt-item index is currently "active" (was previously clicked)
let activeSrtIdx = null;



function seekToSubtitleIfNotFocused(e, idx) {
  if (e.target.closest('[data-insert-after],[data-delete-idx]')) return;
  if (activeSrtIdx === idx) return;
  activeSrtIdx = idx;
  const seg    = state.segments[idx];
  const player = document.getElementById('video-player');
  if (!seg || !player || !player.src) return;
  const wasEnded = player.ended;
  const startSec = srtToSec(seg.start);
  const endSec = srtToSec(seg.end);
  player.currentTime = startSec + (endSec - startSec) / 2;
  if (wasEnded) player.play().catch(()=>{});
  // Highlight immediately - timeupdate will confirm same subtitle
  setActiveSubtitle(idx);
  document.getElementById('video-wrap').scrollIntoView({behavior:'smooth', block:'nearest'});
}

// Reset activeSrtIdx when clicking outside srt-list
document.addEventListener('click', e => {
  if (!e.target.closest('.srt-item')) activeSrtIdx = null;
});




let _applyStylesTimer = null;
function scheduleApplyStyles() {
  clearTimeout(_applyStylesTimer);
  _applyStylesTimer = setTimeout(applyBurnStylesToOverlay, 150);
}

function applyBurnStylesToOverlay() {
  const overlay = document.getElementById('video-sub-overlay');
  if (!overlay) return;

  const font    = document.getElementById('burn-font')?.value || 'Arial';
  const color   = document.getElementById('burn-color')?.value || 'white';
  const outline = document.getElementById('burn-outline')?.value || 'none';
  const size    = parseInt(document.getElementById('burn-fontsize')?.value || 24);
  const style   = document.getElementById('burn-style')?.value || 'normal';
  const pos     = document.getElementById('burn-position')?.value || 'bottom';
  const bgOp    = parseInt(document.getElementById('burn-bg-opacity')?.value || 0);

  const colorMap = {white:'#fff',yellow:'#ff0',black:'#000',cyan:'#0ff',lime:'#0f8',red:'#f44',orange:'#f90',pink:'#f8c'};
  const txtColor = colorMap[color] || '#fff';

  let shadow = '';
  if (outline === 'black')            shadow = '2px 2px 3px #000,-1px -1px 2px #000,1px -1px 2px #000,-1px 1px 2px #000';
  else if (outline === 'white')       shadow = '2px 2px 3px #fff,-1px -1px 2px #fff';
  else if (outline === 'dark-shadow') shadow = '3px 4px 8px rgba(0,0,0,.9)';

  overlay.style.fontFamily  = font + ',sans-serif';
  overlay.style.color       = txtColor;
  overlay.style.textShadow  = shadow;
  overlay.style.fontSize    = size + 'px';
  overlay.style.fontWeight  = style.includes('bold') ? '700' : '400';
  overlay.style.fontStyle   = style.includes('italic') ? 'italic' : 'normal';
  overlay.style.background  = bgOp > 0 ? `rgba(0,0,0,${bgOp/100})` : 'transparent';
  overlay.style.borderRadius= bgOp > 0 ? '4px' : '0';
  overlay.style.padding     = bgOp > 0 ? '4px 12px' : '0';

  // Position
  overlay.style.top = overlay.style.bottom = overlay.style.transform = '';
  const posMap = {
    'very-bottom':{bottom:'4px'},'bottom':{bottom:'18px'},'center-bottom':{bottom:'28%'},
    'center':{top:'50%',transform:'translate(-50%,-50%)'},
    'center-top':{top:'28%'},'top':{top:'18px'},'very-top':{top:'4px'},
  };
  overlay.style.left = '50%';
  const pm = posMap[pos] || posMap['bottom'];
  if (!pm.transform) overlay.style.transform = 'translateX(-50%)';
  Object.entries(pm).forEach(([k,v]) => overlay.style[k] = v);
}

function resetBurnDefaults() {
  document.getElementById('burn-font').value       = 'Arial';
  document.getElementById('burn-position').value   = 'bottom';
  document.getElementById('burn-color').value      = 'white';
  document.getElementById('burn-outline').value    = 'none';
  document.getElementById('burn-fontsize').value   = '24';
  document.getElementById('font-size-val').textContent = '24';
  document.getElementById('burn-style').value      = 'normal';
  document.getElementById('burn-bg-opacity').value = '0';
  document.getElementById('bg-opacity-val').textContent = '0';
  updateBurnPreview();
  applyBurnStylesToOverlay();
}

function openBurnSettings() {
  document.getElementById('burn-settings-modal').classList.add('show');
}

// ── BURN PREVIEW ─────────────────────────────────────────────────
function updateBurnPreview() {
  const el    = document.getElementById('burn-preview-text');
  const box   = document.getElementById('burn-preview');
  if (!el) return;

  const font    = document.getElementById('burn-font').value;
  const color   = document.getElementById('burn-color').value;
  const outline = document.getElementById('burn-outline').value;
  const size    = document.getElementById('burn-fontsize').value;
  const style   = document.getElementById('burn-style')?.value || 'normal';
  const pos     = document.getElementById('burn-position').value;
  const bgOp    = parseInt(document.getElementById('burn-bg-opacity')?.value || 0);

  // Color map
  const colorMap = {
    white:'#ffffff', yellow:'#ffff00', black:'#000000',
    cyan:'#00ffff', lime:'#00ff88', red:'#ff4444',
    orange:'#ff9900', pink:'#ff88cc'
  };
  const txtColor = colorMap[color] || '#ffffff';

  // Text shadow / outline
  let shadow = '';
  if (outline === 'black')       shadow = '2px 2px 3px #000, -1px -1px 2px #000, 1px -1px 2px #000, -1px 1px 2px #000';
  else if (outline === 'white')  shadow = '2px 2px 3px #fff, -1px -1px 2px #fff';
  else if (outline === 'dark-shadow') shadow = '3px 4px 8px rgba(0,0,0,.9)';

  // Font style
  const isBold   = style.includes('bold');
  const isItalic = style.includes('italic');

  el.style.fontFamily  = font + ',sans-serif';
  el.style.color       = txtColor;
  el.style.textShadow  = shadow;
  el.style.fontSize    = size + 'px';
  el.style.fontWeight  = isBold ? '700' : '400';
  el.style.fontStyle   = isItalic ? 'italic' : 'normal';

  // Background
  el.style.background  = bgOp > 0 ? `rgba(0,0,0,${bgOp/100})` : 'transparent';
  el.style.borderRadius = bgOp > 0 ? '4px' : '0';
  el.style.padding      = bgOp > 0 ? '4px 12px' : '6px 16px';

  // Position (5 levels)
  el.style.left = el.style.right = '';
  el.style.width = '100%'; el.style.textAlign = 'center';
  el.style.transform = '';
  const posMap2 = {
    'very-bottom': {bottom:'2px', top:'auto'},
    'bottom':      {bottom:'10px', top:'auto'},
    'center-bottom':{bottom:'30%', top:'auto'},
    'center':      {top:'50%', bottom:'auto', transform:'translateY(-50%)'},
    'center-top':  {top:'30%', bottom:'auto'},
    'top':         {top:'10px', bottom:'auto'},
    'very-top':    {top:'2px', bottom:'auto'},
  };
  const pm = posMap2[pos] || posMap2['bottom'];
  el.style.bottom    = pm.bottom || 'auto';
  el.style.top       = pm.top    || 'auto';
  if (pm.transform)  el.style.transform = pm.transform;
}

// ── BURN ──────────────────────────────────────────────────────────
async function burnSubtitles(){
  if (!state.videoId) return;
  document.getElementById('burn-btn').disabled=true;
  document.getElementById('burn-progress').style.display='block';
  animateBurnProgress();
  const posRaw = document.getElementById('burn-position').value;
  const posMap = {
    'very-bottom':'very-bottom','bottom':'bottom','center-bottom':'center-bottom',
    'center':'center','center-top':'center-top','top':'top','very-top':'very-top'
  };
  const styleVal = document.getElementById('burn-style')?.value || 'normal';
  const bgOp = parseInt(document.getElementById('burn-bg-opacity')?.value || 0);
  const payload={
    video_id:state.videoId, srt_lines:state.segments,
    font_name:document.getElementById('burn-font').value,
    font_size:parseInt(document.getElementById('burn-fontsize').value),
    font_color:document.getElementById('burn-color').value,
    outline_color:document.getElementById('burn-outline').value,
    position:posMap[posRaw]||'bottom',
    font_style:styleVal,
    bg_opacity:bgOp,
  };
  try{
    const res=await fetch(`${API}/burn`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if (!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e?.detail||'שגיאה');}
    const blob=await res.blob(); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download=`עם_כתוביות_${state.filename||'video.mp4'}`;
    a.click(); URL.revokeObjectURL(url);
    toast('success','הוידאו עם כתוביות הורד!');
  }catch(err){ toast('error',`שגיאה: ${err.message}`); }
  finally{ document.getElementById('burn-btn').disabled=false; document.getElementById('burn-progress').style.display='none'; }
}

// ── TABS ──────────────────────────────────────────────────────────
function switchTab(name){
  const n=['editor','text','burn'];
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',n[i]===name));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if(name==='text') syncPlainText();
  if(name==='editor') applyBurnStylesToOverlay();
}

// ── STEPS ─────────────────────────────────────────────────────────
function setStep(n){
  for(let i=1;i<=3;i++){
    const el=document.getElementById(`step-${i}`);
    el.classList.remove('active','done');
    if(i<n) el.classList.add('done'); else if(i===n) el.classList.add('active');
  }
}
function setStepDone(n){ const el=document.getElementById(`step-${n}`); el.classList.remove('active'); el.classList.add('done'); }

// ── PROGRESS ──────────────────────────────────────────────────────
function showProgress(show,label=''){
  document.getElementById('progress-section').style.display=show?'block':'none';
  if(label) document.getElementById('progress-label').textContent=label;
  if(!show) document.getElementById('progress-bar').style.width='0%';
}
function animateProgress(from,to,dur){
  const bar=document.getElementById('progress-bar'),s=performance.now();
  (function f(now){ const t=Math.min((now-s)/dur,1); bar.style.width=(from+(to-from)*(t<.5?2*t*t:-1+(4-2*t)*t))+'%'; if(t<1)requestAnimationFrame(f); })(performance.now());
}
// Asymptotic crawl - moves fast at first, then slows to a near-stop (never reaches cap)
function animateProgressSlow(start, cap) {
  const bar = document.getElementById('progress-bar');
  const t0  = Date.now();
  // Formula: pct = cap * (1 - e^(-elapsed/tau))
  // tau=25s → at 10s it's at ~33%, at 30s ~70%, at 60s ~91% of cap
  const tau = 55;
  bar.style.width = start + '%';
  (function tick() {
    if (!document.getElementById('progress-section') ||
        document.getElementById('progress-section').style.display === 'none') return;
    const elapsed = (Date.now() - t0) / 1000;
    const pct = start + (cap - start) * (1 - Math.exp(-elapsed / tau));
    bar.style.width = pct + '%';
    requestAnimationFrame(tick);
  })();
}
function animateBurnProgress(){
  let p=10; const bar=document.getElementById('burn-bar');
  const iv=setInterval(()=>{ p=Math.min(p+Math.random()*4,90); bar.style.width=p+'%'; if(p>=90)clearInterval(iv); },600);
}

// ── MODALS ────────────────────────────────────────────────────────
function confirmReset(){ document.getElementById('confirm-modal').classList.add('show'); }
function openSettingsModal(){
  // Sync modal value with hidden input
  document.getElementById('max-words-modal').value = document.getElementById('max-words').value || 4;
  document.getElementById('settings-modal').classList.add('show');
}
function closeModal(id){ document.getElementById(id).classList.remove('show'); }
document.querySelectorAll('.modal-overlay').forEach(el=>{
  el.addEventListener('click',e=>{ if(e.target===e.currentTarget) el.classList.remove('show'); });
});

// ── RESET ─────────────────────────────────────────────────────────
function resetAll(){
  closeModal('confirm-modal'); stopTimer(); undoStack.length=0;
  state={videoId:null,filename:null,segments:[]}; selectedFile=null;
  document.getElementById('results-section').style.display='none';
  document.getElementById('estimate-box').style.display='none';
  document.getElementById('drop-zone').style.display='block';
  document.getElementById('file-selected-state').style.display='none';
  // Reset video player
  const player = document.getElementById('video-player');
  if (player) { player.src=''; player.load(); }
  const ov = document.getElementById('video-sub-overlay'); if(ov) ov.textContent='';
  document.getElementById('video-wrap').style.display='none';
  document.getElementById('video-no-file').style.display='block';
  if (state.videoBlobUrl) { URL.revokeObjectURL(state.videoBlobUrl); state.videoBlobUrl=null; }
  document.getElementById('file-input').value='';
  document.getElementById('transcript-hint').value='';
  document.getElementById('transcript-area').style.display='none';
  selectMode('file-only');
  document.getElementById('undo-btn').style.display='none';
  document.getElementById('video-wrap').classList.remove('has-video');
  document.getElementById('video-wrap').classList.remove('is-portrait');
  document.getElementById('action-row').style.display='none';

  document.getElementById('paste-btn').style.display='none';
  document.getElementById('paste-btn').style.display='none';
  showProgress(false); setStep(1);
  window.scrollTo({top:0,behavior:'smooth'});
}

// ── HELPERS ───────────────────────────────────────────────────────
function segDur(seg){ return srtToSec(seg.end)-srtToSec(seg.start); }
function srtToSec(ts){ try{ const[h,m,r]=ts.split(':');const[s,ms]=r.replace(',','.').split('.');return+h*3600+ +m*60+ +s+(+ms||0)/1000; }catch{return 0;} }
function secToSrt(s){ const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=Math.floor(s%60),ms=Math.round((s-Math.floor(s))*1000); return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')},${String(ms).padStart(3,'0')}`; }
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── LUCIDE ICONS INIT ────────────────────────────────────────────
function initIcons() {
  if (typeof lucide !== 'undefined') lucide.createIcons();
}
initIcons(); // Script is at bottom so DOM is ready

let toastTimer;
function toast(type,msg){
  const el=document.getElementById('toast');
  el.className=`show ${type}`;
  document.getElementById('toast-msg').textContent=msg;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.remove('show'),3200);
}
