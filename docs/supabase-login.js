(() => {
  'use strict';

  const accountStyle = document.createElement('style');
  accountStyle.textContent = `.account-panel{display:flex;align-items:center;justify-content:space-between;gap:14px;margin:0 0 18px;padding:14px 16px;background:linear-gradient(120deg,#111a25,#101923);border:1px solid #293542;border-radius:18px}.account-copy{min-width:0}.account-title{font-size:14px;font-weight:800}.account-description,.auth-message{font-size:11px;color:#92a0ae;margin:3px 0 0}.auth-message.error{color:#ff9cab}.auth-actions{display:flex;align-items:center;gap:10px}.google-login,.logout-btn{border:1px solid #3a4b59;border-radius:11px;padding:9px 13px;background:#15212b;color:#eef5f8;font:700 12px/1.2 inherit;cursor:pointer;white-space:nowrap}.google-login{background:linear-gradient(100deg,#42dfb0,#438dff);color:#07151a;border:0}.google-login:disabled,.logout-btn:disabled{opacity:.6;cursor:wait}.account-user{display:flex;align-items:center;gap:9px}.account-avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#263542}.account-user-copy{min-width:0}.account-user-name{font-size:12px;font-weight:800;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-user-email{font-size:10px;color:#92a0ae;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.account-panel [hidden]{display:none!important}@media(max-width:600px){.account-panel{align-items:flex-start;flex-direction:column}.auth-actions{width:100%;justify-content:space-between}.account-user{width:100%}}`;
  accountStyle.textContent += '.google-login,.logout-btn{font:700 12px/1.2 system-ui,sans-serif}';
  accountStyle.textContent += '.email-auth-form{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.email-field{width:150px;min-width:0;background:#0c1319;color:#f0f5f8;border:1px solid #354550;border-radius:9px;padding:8px 9px;font:12px system-ui,sans-serif}.email-auth-buttons{display:flex;gap:6px}.email-auth-form .logout-btn{background:#15212b}.email-auth-form .google-login{background:linear-gradient(100deg,#42dfb0,#438dff)}@media(max-width:600px){.email-auth-form{width:100%}.email-field{flex:1;min-width:130px}}';
  document.head.append(accountStyle);
  const hero = document.querySelector('.hero');
  if (hero && !document.getElementById('accountPanel')) {
    hero.insertAdjacentHTML('afterend', `<section class="account-panel" id="accountPanel" aria-label="Akun dan pustaka lagu">
      <div class="account-copy"><div class="account-title">Akun &amp; pustaka lagu</div><p class="account-description">Simpan prompt dan riwayat lagu—judul, status, sampul, serta tautan audio—di akun pribadi Anda.</p><p class="auth-message" id="authMessage">Masuk atau daftar dengan email.</p></div>
      <div class="auth-actions"><div id="loginArea" class="email-auth-form"><input class="email-field" id="authEmail" type="email" autocomplete="email" placeholder="Email" aria-label="Email"><input class="email-field" id="authPassword" type="password" autocomplete="current-password" placeholder="Kata sandi" aria-label="Kata sandi"><div class="email-auth-buttons"><button class="google-login" id="emailLoginBtn" type="button">Masuk</button><button class="logout-btn" id="emailSignupBtn" type="button">Buat akun</button></div></div><div class="account-user" id="profileArea" hidden><img class="account-avatar" id="userAvatar" alt="" hidden><div class="account-user-copy"><div class="account-user-name" id="userName"></div><div class="account-user-email" id="userEmail"></div></div><button class="logout-btn" id="logoutBtn" type="button">Keluar</button></div></div>
    </section>`);
  }

  const config = window.FATTAH_SUPABASE_CONFIG || {};
  const endpoint = document.querySelector('.endpoint')?.textContent.trim().replace(/\/$/, '') || 'https://musik-fattah-p.onrender.com';
  const loginButton = document.getElementById('emailLoginBtn');
  const signupButton = document.getElementById('emailSignupBtn');
  const logoutButton = document.getElementById('logoutBtn');
  const loginArea = document.getElementById('loginArea');
  const profileArea = document.getElementById('profileArea');
  const authMessage = document.getElementById('authMessage');
  let currentUser = null;
  let supabaseClient = null;

  const message = (text, isError = false) => {
    authMessage.textContent = text;
    authMessage.classList.toggle('error', isError);
  };
  const showStatus = (title, text, state = 'loading') => {
    const box = document.getElementById('statusBox');
    if (!box) return;
    box.className = 'status show' + (state === 'error' ? ' error' : '');
    document.getElementById('statusTitle').textContent = title;
    document.getElementById('statusText').textContent = text || '';
    document.getElementById('statusSpinner').style.display = state === 'loading' ? 'block' : 'none';
    document.getElementById('progress').style.display = state === 'loading' ? 'block' : 'none';
  };
  const toast = text => {
    const node = document.getElementById('toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    setTimeout(() => node.classList.remove('show'), 3000);
  };
  const readJson = async response => {
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text.slice(0, 1000) }; }
  };
  const findTaskId = obj => {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.taskId === 'string' && obj.taskId) return obj.taskId;
    if (typeof obj.task_id === 'string' && obj.task_id) return obj.task_id;
    for (const value of Object.values(obj)) {
      if (value && typeof value === 'object') { const found = findTaskId(value); if (found) return found; }
    }
    return null;
  };
  const collectTracks = (obj, taskId = '', found = []) => {
    if (!obj || typeof obj !== 'object') return found;
    if (Array.isArray(obj)) { obj.forEach(x => collectTracks(x, taskId, found)); return found; }
    const url = obj.audioUrl || obj.audio_url || obj.streamAudioUrl || obj.stream_audio_url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && !found.some(x => x.url === url)) {
      found.push({
        url,
        title: obj.title || obj.name || '',
        id: String(obj.audioId || obj.audio_id || obj.id || ''),
        taskId,
        imageUrl: obj.imageUrl || obj.image_url || obj.coverUrl || obj.cover_url || ''
      });
    }
    Object.values(obj).forEach(value => { if (value && typeof value === 'object') collectTracks(value, taskId, found); });
    return found;
  };
  const normalizeTracks = (row) => (Array.isArray(row.tracks) ? row.tracks : [])
    .map(track => ({
      url: track.audio_url || track.url || '',
      title: track.title || '',
      id: String(track.audio_id || track.id || ''),
      taskId: row.task_id,
      imageUrl: track.image_url || track.imageUrl || ''
    }))
    .filter(track => track.url && /^https?:\/\//i.test(track.url));

  function clearTrackList() {
    document.getElementById('trackList').innerHTML = '';
    document.getElementById('resultCount').textContent = '0 track';
    document.getElementById('emptyState').style.display = 'block';
  }

  function updateAccount(user) {
    currentUser = user || null;
    if (!currentUser) {
      loginArea.hidden = false;
      profileArea.hidden = true;
      clearTrackList();
      message('Masuk atau daftar menggunakan email Anda.');
      return;
    }
    const metadata = currentUser.user_metadata || {};
    document.getElementById('userName').textContent = metadata.full_name || metadata.name || currentUser.email || 'Pengguna';
    document.getElementById('userEmail').textContent = currentUser.email || '';
    const avatar = document.getElementById('userAvatar');
    const picture = metadata.avatar_url || metadata.picture || '';
    avatar.hidden = !picture;
    if (picture) { avatar.src = picture; avatar.onerror = () => { avatar.hidden = true; }; }
    loginArea.hidden = true;
    profileArea.hidden = false;
    message('Login aktif. Riwayat lagu dan prompt disimpan di Supabase.');
  }

  async function saveSong(taskId, prompt, status, tracks) {
    if (!currentUser) return;
    const safeTracks = tracks.map(track => ({
      audio_id: track.id || '',
      title: track.title || '',
      audio_url: track.url || '',
      image_url: track.imageUrl || ''
    }));
    const { error } = await supabaseClient.from('user_songs').upsert({
      user_id: currentUser.id,
      task_id: taskId,
      prompt: prompt || '',
      status,
      tracks: safeTracks,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,task_id' });
    if (error) throw error;
  }

  async function loadSavedSongs() {
    if (!currentUser) return;
    message('Memuat lagu tersimpan…');
    const { data, error } = await supabaseClient.from('user_songs')
      .select('task_id,prompt,status,tracks,created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    const restored = [];
    let pending = 0;
    for (const row of data || []) {
      let tracks = normalizeTracks(row);
      if (!tracks.length && row.task_id && ['processing', 'queued', 'audio_done'].includes(String(row.status).toLowerCase())) {
        try {
          const response = await fetch(`${endpoint}/record-info/${encodeURIComponent(row.task_id)}`, { headers: { Accept: 'application/json' } });
          const body = await readJson(response);
          if (response.ok) tracks = collectTracks(body, row.task_id);
          if (tracks.length) await saveSong(row.task_id, row.prompt, 'complete', tracks);
          else pending++;
        } catch { pending++; }
      }
      restored.push(...tracks);
    }
    const unique = restored.filter((track, i, all) => all.findIndex(x => x.taskId === track.taskId && x.id === track.id) === i);
    if (unique.length && window.renderTracks) window.renderTracks(unique);
    else clearTrackList();
    message(unique.length
      ? `${unique.length} track dari akun Anda dimuat${pending ? ` · ${pending} task masih diproses` : ''}.`
      : (pending ? `${pending} lagu masih diproses; buka kembali nanti untuk memuat hasilnya.` : 'Belum ada lagu tersimpan di akun ini.'));
  }

  async function pollAndSave(taskId, prompt) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10000));
      showStatus('Meracik lagu…', `Memeriksa hasil · ${Math.min((attempt + 1) * 10, 600)} detik`);
      const response = await fetch(`${endpoint}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Cek status HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
      const tracks = collectTracks(body, taskId);
      if (tracks.length) {
        if (window.renderTracks) window.renderTracks(tracks);
        try {
          await saveSong(taskId, prompt, 'complete', tracks);
          showStatus('Lagu selesai dan tersimpan', `${tracks.length} track masuk ke pustaka akun Supabase.`, 'done');
          message('Lagu tersimpan di akun Anda.');
        } catch (error) {
          showStatus('Lagu selesai, tetapi riwayat belum tersimpan', 'Jalankan docs/user-songs.sql di Supabase SQL Editor, lalu muat ulang halaman. ' + (error.message || ''), 'error');
          message('Login berhasil; tabel riwayat Supabase belum siap.', true);
        }
        return;
      }
      const failure = window.findFailure ? window.findFailure(body) : null;
      if (failure) throw new Error('SunoAPI gagal: ' + failure);
    }
    throw new Error('Waktu tunggu habis. Task masih diproses; riwayat sudah dicatat di akun.');
  }

  if (!window.supabase || !config.url || !config.key) {
    loginButton.disabled = true;
    signupButton.disabled = true;
    message('Konfigurasi Supabase belum tersedia untuk halaman ini.', true);
    return;
  }

  supabaseClient = window.supabase.createClient(config.url, config.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  loginButton.addEventListener('click', async () => {
    loginButton.disabled = true;
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email || !password) { loginButton.disabled = false; message('Isi email dan kata sandi terlebih dahulu.', true); return; }
    message('Memeriksa akun…');
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      loginButton.disabled = false;
      message('Login gagal: ' + error.message, true);
    } else {
      updateAccount(data.user);
      message('Login berhasil. Memuat pustaka lagu…');
      loadSavedSongs().catch(loadError => message('Tidak dapat memuat riwayat: ' + loadError.message, true));
    }
  });

  signupButton.addEventListener('click', async () => {
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    if (!email || !password) { message('Isi email dan kata sandi terlebih dahulu.', true); return; }
    if (password.length < 6) { message('Kata sandi harus terdiri dari minimal 6 karakter.', true); return; }
    signupButton.disabled = true;
    message('Membuat akun…');
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectTo }
    });
    if (error) message('Pendaftaran gagal: ' + error.message, true);
    else if (data.session && data.user) {
      updateAccount(data.user);
      message('Akun dibuat dan Anda sudah masuk.');
      loadSavedSongs().catch(loadError => message('Akun aktif, tetapi riwayat belum siap: ' + loadError.message, true));
    } else {
      message('Akun dibuat. Cek email Anda untuk tautan konfirmasi, lalu masuk di sini.');
    }
    signupButton.disabled = false;
  });

  logoutButton.addEventListener('click', async () => {
    const { error } = await supabaseClient.auth.signOut();
    if (error) { message('Tidak dapat keluar: ' + error.message, true); return; }
    updateAccount(null);
  });

  const form = document.getElementById('generatorForm');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!currentUser) {
      message('Masuk dengan email dulu agar lagu tersimpan ke akun.', true);
      document.getElementById('accountPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const prompt = document.getElementById('prompt').value.trim();
    if (!prompt) { document.getElementById('prompt').focus(); return; }
    if (!window.confirm('Permintaan ini akan memakai kuota SunoAPI. Lanjutkan?')) return;
    const button = document.getElementById('generateBtn');
    button.disabled = true;
    showStatus('Mengirim permintaan…', 'Menghubungi server Musik Fattah.');
    try {
      const response = await fetch(`${endpoint}/generate-music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt, instrumental: document.getElementById('instrumental').checked, customMode: false, model: document.getElementById('model').value })
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Generate HTTP ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
      const taskId = findTaskId(body);
      if (!taskId) throw new Error('Server belum mengirim Task ID. Respons: ' + JSON.stringify(body).slice(0, 500));
      try { localStorage.setItem('fattahmusic.lastTaskId', taskId); } catch {}
      const lookup = document.getElementById('taskLookup');
      if (lookup) lookup.value = taskId;
      showStatus('Task diterima', `ID ${taskId} · menyimpan riwayat dan menunggu audio…`);
      try { await saveSong(taskId, prompt, 'processing', []); }
      catch (error) { message('Lagu sedang dibuat, tetapi tabel riwayat belum siap. Jalankan user-songs.sql di Supabase. (' + error.message + ')', true); }
      await pollAndSave(taskId, prompt);
      document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      showStatus('Generate belum berhasil', error.message || 'Periksa koneksi server lalu coba lagi.', 'error');
    } finally { button.disabled = false; }
  }, true);

  const lookupButton = document.getElementById('lookupBtn');
  lookupButton.addEventListener('click', async event => {
    if (!currentUser) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const taskId = document.getElementById('taskLookup').value.trim();
    if (!taskId) { toast('Tempel Task ID terlebih dahulu.'); return; }
    lookupButton.disabled = true;
    showStatus('Memuat lagu…', 'Memeriksa task yang sudah ada tanpa generate baru.');
    try {
      const response = await fetch(`${endpoint}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tracks = collectTracks(body, taskId);
      if (!tracks.length) throw new Error('Audio belum tersedia untuk Task ID ini.');
      await saveSong(taskId, document.getElementById('prompt').value.trim(), 'complete', tracks);
      if (window.renderTracks) window.renderTracks(tracks);
      showStatus('Lagu ditemukan dan tersimpan', `${tracks.length} track dimuat ke akun Anda.`, 'done');
    } catch (error) { showStatus('Hasil belum dapat dimuat', error.message || 'Periksa Task ID dan koneksi server.', 'error'); }
    finally { lookupButton.disabled = false; }
  }, true);

  supabaseClient.auth.onAuthStateChange((event, session) => {
    updateAccount(session?.user || null);
    if (session?.user) setTimeout(() => loadSavedSongs().catch(error => message('Tidak dapat memuat riwayat. Jalankan SQL setup Supabase bila tabel belum dibuat. ' + error.message, true)), 0);
  });
  supabaseClient.auth.getSession().then(({ data, error }) => {
    if (error) { message('Tidak dapat membaca sesi login: ' + error.message, true); return; }
    updateAccount(data.session?.user || null);
    if (data.session?.user) loadSavedSongs().catch(error => message('Tidak dapat memuat riwayat. Jalankan SQL setup Supabase bila tabel belum dibuat. ' + error.message, true));
  });
})();
