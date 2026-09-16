/* ============================================================================
   Subit — User History Page
   Loads the signed-in user's video_history from Supabase and renders it.
   ============================================================================ */

// ── Helpers ───────────────────────────────────────────────────────
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function truncateFilename(name, max = 46) {
  if (!name || name.length <= max) return name;
  const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '';
  return name.slice(0, max - ext.length - 1) + '…' + ext;
}

function srtLineCount(srt) {
  if (!srt) return 0;
  return (srt.match(/^\d+$/gm) || []).length;
}

// ── Download SRT from stored content ──────────────────────────────
function downloadHistorySRT(entry) {
  const baseName = (entry.filename || 'subtitles').replace(/\.[^.]+$/, '');
  const content = entry.srt_content || '';
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}.srt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Delete entry ──────────────────────────────────────────────────
async function deleteEntry(id, cardEl) {
  if (!confirm('למחוק רשומה זו מההיסטוריה?')) return;
  const { error } = await sb.from('video_history').delete().eq('id', id);
  if (error) {
    alert('מחיקה נכשלה: ' + error.message);
    return;
  }
  cardEl.style.transition = 'opacity .3s, max-height .4s';
  cardEl.style.opacity = '0';
  cardEl.style.maxHeight = '0';
  cardEl.style.overflow = 'hidden';
  setTimeout(() => cardEl.remove(), 400);
  // Update empty state if no more cards
  setTimeout(() => {
    const remaining = document.querySelectorAll('.hist-card').length;
    if (remaining === 0) showEmpty();
  }, 450);
}

// ── Render one card ───────────────────────────────────────────────
function renderCard(entry) {
  const card = document.createElement('div');
  card.className = 'hist-card';
  card.dataset.id = entry.id;

  const lines = srtLineCount(entry.srt_content);
  const creditsText = entry.credits_used ? `${entry.credits_used} קרדיט` : '';

  card.innerHTML = `
    <div class="hist-card-top">
      <div class="hist-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <line x1="10" y1="9" x2="8" y2="9"/>
        </svg>
      </div>
      <div class="hist-meta">
        <div class="hist-filename" title="${entry.filename || ''}">${truncateFilename(entry.filename || 'קובץ ללא שם')}</div>
        <div class="hist-details">
          <span class="hist-date">${formatDate(entry.created_at)}</span>
          ${lines ? `<span class="hist-badge">${lines} כתוביות</span>` : ''}
          ${creditsText ? `<span class="hist-badge hist-badge-credits">${creditsText}</span>` : ''}
        </div>
      </div>
    </div>
    <div class="hist-card-actions">
      <button class="hist-btn hist-btn-primary" onclick="continueEditing('${entry.id}')">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
        המשך עריכה
      </button>
      <button class="hist-btn hist-btn-ghost" onclick="downloadHistorySRT(histEntries['${entry.id}'])">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        SRT
      </button>
      <button class="hist-btn hist-btn-icon" title="מחק" onclick="deleteEntry('${entry.id}', this.closest('.hist-card'))">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
          <path d="M10 11v6M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
      </button>
    </div>
  `;
  return card;
}

// ── Continue editing: stash the entry and jump to the editor ───────
function continueEditing(id) {
  const entry = histEntries[id];
  if (!entry) return;
  if (!entry.segments || !entry.segments.length) {
    alert('אין כתוביות שמורות לרשומה זו');
    return;
  }
  try {
    localStorage.setItem('subit_edit_entry', JSON.stringify({
      video_id: entry.video_id,
      filename: entry.filename,
      segments: entry.segments,
    }));
  } catch (e) {
    alert('לא ניתן לפתוח בעורך: ' + e.message);
    return;
  }
  window.location.href = 'index.html';
}

// ── Empty / loading states ─────────────────────────────────────────
function showEmpty() {
  document.getElementById('hist-list').innerHTML = '';
  document.getElementById('hist-empty').style.display = 'flex';
}

function showLoading(yes) {
  document.getElementById('hist-loading').style.display = yes ? 'flex' : 'none';
  document.getElementById('hist-list').style.display = yes ? 'none' : '';
}

// ── Global map so onclick closures can access full entry data ──────
const histEntries = {};

// ── Load history from Supabase ─────────────────────────────────────
async function loadHistory() {
  showLoading(true);
  document.getElementById('hist-empty').style.display = 'none';

  const { data, error } = await sb
    .from('video_history')
    .select('id, video_id, filename, credits_used, srt_content, segments, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(100);

  showLoading(false);

  if (error) {
    // Show the friendly empty state rather than a raw DB error, but keep the
    // real error in the console so it's still debuggable.
    console.error('loadHistory failed:', error);
    showEmpty();
    return;
  }

  if (!data || data.length === 0) {
    showEmpty();
    return;
  }

  const list = document.getElementById('hist-list');
  list.innerHTML = '';
  data.forEach(entry => {
    histEntries[entry.id] = entry;
    list.appendChild(renderCard(entry));
  });
}

// ── Init ───────────────────────────────────────────────────────────
// auth.js fires onAuthStateChange synchronously on load; we also run the
// IIFE that restores an existing session. By the time user.js executes,
// currentUser may already be set. We watch for auth state changes to
// handle both first-load and sign-in-while-on-page scenarios.
sb.auth.onAuthStateChange((event, session) => {
  const user = session ? session.user : null;
  const guestMsg = document.getElementById('hist-guest');
  const mainSection = document.getElementById('hist-main');

  if (user) {
    if (guestMsg) guestMsg.style.display = 'none';
    if (mainSection) mainSection.style.display = 'block';
    loadHistory();
  } else {
    if (guestMsg) guestMsg.style.display = 'flex';
    if (mainSection) mainSection.style.display = 'none';
  }
});

// Also check immediately for an already-resolved session (IIFE in auth.js
// runs before this file but may finish after DOMContentLoaded).
(async () => {
  const { data } = await sb.auth.getSession();
  if (data.session && currentUser) {
    document.getElementById('hist-guest').style.display = 'none';
    document.getElementById('hist-main').style.display = 'block';
    loadHistory();
  }
})();
