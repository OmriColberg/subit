/* ============================================================================
   SUBIT — AUTH (Supabase + Google)
   ----------------------------------------------------------------------------
   Frontend auth ONLY. This layer manages sign-in and shows the user + balance.
   It does NOT enforce credits - that happens in the backend (it must, because
   anything here is bypassable from the console). The gating below is UX, not
   security: it steers users to sign in, nothing more.
   ============================================================================ */

// Public anon key - safe to ship in the client (RLS protects the data).
const SUPABASE_URL = 'https://czhijdtnfbjxdycroiqv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6aGlqZHRuZmJqeGR5Y3JvaXF2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNTMxNzksImV4cCI6MjEwMDgyOTE3OX0.U5hn4WTcTx421nEbYekBxezItL8NN0D08hL6gZY_RSA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Current auth state, readable by app.js
let currentUser = null;       // Supabase user object, or null
let currentCredits = null;    // integer balance, or null

function isLoggedIn() { return !!currentUser; }

// ── Sign in / out ────────────────────────────────────────────────
async function signInWithGoogle() {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname },
  });
  if (error) { console.error(error); toast('error', 'ההתחברות נכשלה, נסה שוב'); }
}

async function signOut() {
  await sb.auth.signOut();
  // onAuthStateChange handles the UI reset
}

// ── Load the signed-in user's credit balance ─────────────────────
async function loadCredits() {
  if (!currentUser) { currentCredits = null; return; }
  const { data, error } = await sb
    .from('users')
    .select('credits_balance')
    .eq('id', currentUser.id)
    .single();
  if (error) {
    // The row is created by a DB trigger on signup; on the very first login
    // there can be a brief window before it exists. Retry once shortly.
    console.warn('credits load failed, retrying once', error);
    await new Promise(r => setTimeout(r, 1200));
    const retry = await sb.from('users').select('credits_balance').eq('id', currentUser.id).single();
    currentCredits = retry.data ? retry.data.credits_balance : null;
  } else {
    currentCredits = data.credits_balance;
  }
  renderAuthUI();
}

// exposed so app.js can refresh the balance after a job runs
async function refreshCredits() { await loadCredits(); }

// ── Render the header UI + gate the start button ─────────────────
function renderAuthUI() {
  const loginBtn = document.getElementById('auth-login-btn');
  const chip     = document.getElementById('user-chip');

  if (currentUser) {
    loginBtn.style.display = 'none';
    chip.style.display = 'flex';
    document.getElementById('user-email').textContent = currentUser.email || '';
    document.getElementById('user-credits').textContent =
      currentCredits == null ? '—' : currentCredits;
  } else {
    loginBtn.style.display = 'flex';
    chip.style.display = 'none';
  }
  updateStartButton();
}

// Relabel the "צור לי כתוביות" button based on auth state
function updateStartButton() {
  const label = document.getElementById('start-btn-label');
  if (!label) return;
  label.textContent = currentUser ? 'צור לי כתוביות' : 'התחבר כדי ליצור כתוביות';
}

function toggleUserMenu() {
  const m = document.getElementById('user-menu');
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
// close the menu when clicking elsewhere
document.addEventListener('click', (e) => {
  const chip = document.getElementById('user-chip');
  if (chip && !chip.contains(e.target)) {
    const m = document.getElementById('user-menu');
    if (m) m.style.display = 'none';
  }
});

// ── React to auth changes (login, logout, token refresh, page load) ──
sb.auth.onAuthStateChange((event, session) => {
  currentUser = session ? session.user : null;
  renderAuthUI();
  if (currentUser) loadCredits();
  else currentCredits = null;
});

// On first load, pick up an existing session (e.g. returning from Google)
(async () => {
  const { data } = await sb.auth.getSession();
  currentUser = data.session ? data.session.user : null;
  renderAuthUI();
  if (currentUser) loadCredits();
})();
