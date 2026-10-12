(() => {
  'use strict';

  const API_BASE = 'https://musik-fattah-p.onrender.com';
  const $ = (id) => document.getElementById(id);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const config = window.FATTAH_SUPABASE_CONFIG || {};
  const supabaseReady = Boolean(window.supabase && config.url && config.key);
  let supabaseClient = null;
  let currentUser = null;
  let selectedGenre = 'Pop';
  let isInstrumental = false;
  let isCustom = true;
  let activeTab = 'create';
  let allTracks = [];
  let toastTimer = 0;
  let historyRequest = 0;
  let favoriteIds = new Set();

  try {
    const saved = JSON.parse(localStorage.getItem('fattahmusic.favorites') || '[]');
    if (Array.isArray(saved)) favoriteIds = new Set(saved.map(String));
  } catch {}

  function toast(text) {
    const node = $('toast');
    if (!node) return;
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 3500);
  }

  function authNotice(text, isError = false) {
    const node = $('authMessage');
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('error', isError);
    node.classList.add('show');
  }

  function showGenerationStatus(title, text = '', state = 'loading') {
    const box = $('generationStatus');
    if (!box) return;
    box.className = `generation-status show${state === 'error' ? ' error' : ''}`;
    $('generationTitle').textContent = title;
    $('generationText').textContent = text;
    $('generationSpinner').style.display = state === 'loading' ? 'block' : 'none';
    $('generationProgress').style.display = state === 'loading' ? 'block' : 'none';
  }

  async function readJson(response) {
    const text = await response.text();
    try { return text ? JSON.parse(text) : {}; }
    catch { return { raw: text.slice(0, 1200) }; }
  }

  function findTaskId(value) {
    if (!value || typeof value !== 'object') return null;
    if (typeof value.taskId === 'string' && value.taskId) return value.taskId;
    if (typeof value.task_id === 'string' && value.task_id) return value.task_id;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const found = findTaskId(child);
        if (found) return found;
      }
    }
    return null;
  }

  function collectTracks(value, taskId = '', found = []) {
    if (!value || typeof value !== 'object') return found;
    if (Array.isArray(value)) {
      value.forEach((child) => collectTracks(child, taskId, found));
      return found;
    }
    const url = value.audioUrl || value.audio_url || value.streamAudioUrl || value.stream_audio_url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url) && !found.some((track) => track.url === url)) {
      found.push({
        url,
        title: value.title || value.name || '',
        id: String(value.audioId || value.audio_id || value.id || ''),
        taskId: taskId || String(value.taskId || value.task_id || ''),
        imageUrl: value.imageUrl || value.image_url || value.coverUrl || value.cover_url || ''
      });
    }
    Object.values(value).forEach((child) => {
      if (child && typeof child === 'object') collectTracks(child, taskId, found);
    });
    return found;
  }

  function findFailure(value) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const child of value) {
        const error = findFailure(child);
        if (error) return error;
      }
      return null;
    }
    const state = String(value.status || value.state || value.callbackType || value.callback_type || '').toLowerCase();
    if (['failed', 'error', 'failure'].includes(state)) return value.msg || value.errorMessage || value.error || state;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const error = findFailure(child);
        if (error) return error;
      }
    }
    return null;
  }

  function extractLyrics(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        const time = item.time || item.timestamp || item.startTime || '';
        const words = item.text || item.lyric || item.content || item.line || item.words || '';
        return words ? `${time ? `[${time}] ` : ''}${words}` : '';
      }).filter(Boolean).join('\n').trim();
    }
    if (value && typeof value === 'object') {
      for (const key of ['lyrics', 'lyric', 'lyricText', 'plainLyrics', 'syncedLyrics', 'lines', 'segments', 'text']) {
        if (value[key] !== undefined) {
          const result = extractLyrics(value[key]);
          if (result) return result;
        }
      }
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
          const result = extractLyrics(child);
          if (result) return result;
        }
      }
    }
    return '';
  }

  function trackKey(track) {
    return `${track.taskId || ''}:${track.id || track.url || ''}`;
  }

  function mergeTracks(incoming) {
    const merged = [...incoming, ...allTracks];
    allTracks = merged.filter((track, index, list) => list.findIndex((item) => trackKey(item) === trackKey(track)) === index);
  }

  function setEmptyMessage(text) {
    const node = $('emptyMessage');
    if (node) node.textContent = text;
  }

  function renderTracks() {
    const list = $('tracks');
    if (!list) return;
    list.replaceChildren();
    const visible = activeTab === 'liked'
      ? allTracks.filter((track) => favoriteIds.has(trackKey(track)))
      : allTracks;
    $('resultCount').textContent = `${visible.length} ${visible.length === 1 ? 'lagu' : 'lagu'}`;
    $('emptyState').style.display = visible.length ? 'none' : 'block';
    if (!visible.length && activeTab === 'liked') setEmptyMessage('Belum ada lagu yang disukai. Tandai lagu dengan tombol ♡ untuk menyimpannya di sini.');
    else if (!visible.length) setEmptyMessage(currentUser ? 'Belum ada lagu tersimpan. Tulis ide, lalu tekan Buat Musik.' : 'Masuk atau buat akun agar karya dan riwayat lagu tersimpan.');

    visible.forEach((track, index) => {
      const card = document.createElement('article');
      card.className = 'track';
      const top = document.createElement('div');
      top.className = 'track-top';
      const cover = document.createElement('div');
      cover.className = 'track-cover';
      cover.setAttribute('aria-label', 'Sampul lagu');
      cover.textContent = '♫';
      if (track.imageUrl && /^https?:\/\//i.test(track.imageUrl)) {
        const image = document.createElement('img');
        image.src = track.imageUrl;
        image.alt = `Sampul ${track.title || 'lagu'}`;
        image.loading = 'lazy';
        image.onerror = () => { image.remove(); cover.textContent = '♫'; };
        cover.textContent = '';
        cover.append(image);
      }
      const info = document.createElement('div');
      info.className = 'track-info';
      const title = document.createElement('b');
      title.className = 'track-title';
      title.textContent = track.title || `Lagu AI · Versi ${index + 1}`;
      const meta = document.createElement('small');
      meta.className = 'track-meta';
      meta.textContent = track.id ? `Audio ID: ${track.id}` : 'Hasil SunoAPI';
      info.append(title, meta);
      const badge = document.createElement('span');
      badge.className = 'track-badge';
      badge.textContent = 'Selesai';
      top.append(cover, info, badge);

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = track.url;
      audio.setAttribute('aria-label', `Putar ${track.title || 'lagu AI'}`);

      const actions = document.createElement('div');
      actions.className = 'track-actions';
      const mp3 = document.createElement('button');
      mp3.type = 'button';
      mp3.className = 'download';
      mp3.textContent = '↓ Unduh MP3';
      mp3.addEventListener('click', () => downloadMp3(track, mp3, index));
      actions.append(mp3);

      if (track.taskId) {
        const mp4 = document.createElement('button');
        mp4.type = 'button';
        mp4.className = 'download';
        mp4.textContent = '▣ Unduh MP4';
        mp4.title = 'Video dibuat otomatis setelah audio selesai diproses.';
        mp4.addEventListener('click', () => downloadMp4(track, mp4));
        actions.append(mp4);
      }

      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'download favorite-button';
      const key = trackKey(track);
      const setFavoriteLabel = () => {
        const liked = favoriteIds.has(key);
        favorite.textContent = liked ? '♥ Disukai' : '♡ Suka';
        favorite.setAttribute('aria-pressed', String(liked));
      };
      setFavoriteLabel();
      favorite.addEventListener('click', () => {
        if (favoriteIds.has(key)) favoriteIds.delete(key);
        else favoriteIds.add(key);
        try { localStorage.setItem('fattahmusic.favorites', JSON.stringify([...favoriteIds])); } catch {}
        setFavoriteLabel();
        if (activeTab === 'liked') renderTracks();
      });
      actions.append(favorite);

      const lyrics = document.createElement('details');
      lyrics.className = 'lyrics';
      const summary = document.createElement('summary');
      summary.textContent = 'Lihat lirik';
      const lyricsContent = document.createElement('div');
      lyricsContent.className = 'lyrics-content';
      lyricsContent.textContent = 'Buka untuk mengambil lirik dari server.';
      lyrics.append(summary, lyricsContent);
      lyrics.addEventListener('toggle', () => {
        if (lyrics.open && !lyrics.dataset.requested) {
          lyrics.dataset.requested = '1';
          loadLyrics(track, lyricsContent);
        }
      });
      card.append(top, audio, actions, lyrics);
      list.append(card);
    });
  }

  async function downloadMp3(track, button, index) {
    if (!track.taskId) { toast('Task ID tidak tersedia untuk unduhan.'); return; }
    const audioQuery = track.id ? `?audioId=${encodeURIComponent(track.id)}` : '';
    button.disabled = true;
    button.textContent = 'Mengunduh…';
    try {
      const response = await fetch(`${API_BASE}/download/${encodeURIComponent(track.taskId)}${audioQuery}`);
      if (!response.ok) {
        const body = await readJson(response);
        throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Berkas audio kosong.');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `FattahMusic-${index + 1}.mp3`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      toast('Unduhan MP3 dimulai.');
    } catch (error) {
      toast(`Unduhan MP3 gagal: ${error.message || 'periksa koneksi server.'}`);
    } finally {
      button.disabled = false;
      button.textContent = '↓ Unduh MP3';
    }
  }

  async function downloadMp4(track, button) {
    button.disabled = true;
    button.textContent = 'Memeriksa…';
    try {
      const response = await fetch(`${API_BASE}/video-status/${encodeURIComponent(track.taskId)}`, { cache: 'no-store' });
      const state = await readJson(response);
      if (!response.ok) throw new Error(typeof state.detail === 'string' ? state.detail : `HTTP ${response.status}`);
      if (!state.ready) {
        toast('MP4 masih diproses otomatis. Coba lagi beberapa saat lagi.');
        return;
      }
      window.location.assign(`${API_BASE}/download-video/${encodeURIComponent(track.taskId)}`);
    } catch (error) {
      toast(`MP4 belum dapat diunduh: ${error.message || 'periksa koneksi server.'}`);
    } finally {
      button.disabled = false;
      button.textContent = '▣ Unduh MP4';
    }
  }

  async function loadLyrics(track, content) {
    if (!track.taskId || !track.id) {
      content.className = 'lyrics-content error';
      content.textContent = 'ID audio belum tersedia, sehingga lirik belum bisa diminta.';
      return;
    }
    content.className = 'lyrics-content loading';
    content.textContent = 'Memuat lirik dari server…';
    try {
      const url = `${API_BASE}/lyrics/${encodeURIComponent(track.taskId)}?audioId=${encodeURIComponent(track.id)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
      const text = extractLyrics(body);
      if (!text) throw new Error('Server belum mengembalikan teks lirik untuk lagu ini.');
      content.className = 'lyrics-content';
      content.textContent = text;
    } catch (error) {
      content.className = 'lyrics-content error';
      content.textContent = `Lirik belum dapat dimuat: ${error.message || 'periksa koneksi server.'}`;
    }
  }

  function normalizeTracks(row) {
    return (Array.isArray(row.tracks) ? row.tracks : []).map((track) => ({
      url: track.audio_url || track.url || '',
      title: track.title || '',
      id: String(track.audio_id || track.id || ''),
      taskId: row.task_id,
      imageUrl: track.image_url || track.imageUrl || ''
    })).filter((track) => track.url && /^https?:\/\//i.test(track.url));
  }

  async function saveSong(taskId, prompt, status, tracks) {
    if (!currentUser || !supabaseClient) throw new Error('Sesi login tidak aktif; masuk kembali untuk menyimpan riwayat.');
    const safeTracks = tracks.map((track) => ({
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
    if (!currentUser || !supabaseClient) return;
    const userId = currentUser.id;
    const requestId = ++historyRequest;
    try {
      authNotice('Memuat riwayat lagu…');
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
            const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(row.task_id)}`, { headers: { Accept: 'application/json' } });
            const body = await readJson(response);
            if (response.ok) tracks = collectTracks(body, row.task_id);
            if (tracks.length) await saveSong(row.task_id, row.prompt, 'complete', tracks);
            else pending++;
          } catch { pending++; }
        }
        restored.push(...tracks);
      }
      if (requestId !== historyRequest || currentUser?.id !== userId) return;
      allTracks = restored.filter((track, index, list) => list.findIndex((item) => trackKey(item) === trackKey(track)) === index);
      renderTracks();
      authNotice(allTracks.length
        ? `${allTracks.length} lagu dari akun Anda dimuat${pending ? ` · ${pending} task masih diproses` : ''}.`
        : (pending ? `${pending} lagu masih diproses. Buka kembali pustaka beberapa saat lagi.` : 'Login aktif. Belum ada lagu tersimpan di akun ini.'));
    } catch (error) {
      authNotice(`Riwayat belum dapat dimuat: ${error.message || 'periksa tabel Supabase.'}`, true);
      toast('Riwayat lagu belum dapat dimuat. Pastikan tabel user_songs sudah dibuat di Supabase.');
    }
  }

  async function pollTask(taskId, prompt) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(10000);
      showGenerationStatus('Meracik lagu…', `Memeriksa hasil · ${(attempt + 1) * 10} detik`);
      const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Cek status HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
      const tracks = collectTracks(body, taskId);
      if (tracks.length) {
        mergeTracks(tracks);
        renderTracks();
        let historySaved = true;
        try { await saveSong(taskId, prompt, 'complete', tracks); }
        catch (error) { historySaved = false; }
        showGenerationStatus(
          historySaved ? 'Lagu selesai dan tersimpan' : 'Lagu selesai, riwayat belum tersimpan',
          historySaved ? `${tracks.length} hasil masuk ke pustaka akun Anda. MP4 tersedia setelah diproses.` : 'Hasil sudah tersedia; periksa tabel user_songs dan izin Supabase.',
          historySaved ? 'done' : 'error'
        );
        toast(historySaved ? 'Lagu selesai dan masuk ke koleksi Anda.' : 'Lagu selesai, tetapi riwayat Supabase belum tersimpan.');
        return;
      }
      const failure = findFailure(body);
      if (failure) throw new Error(`SunoAPI gagal: ${failure}`);
    }
    throw new Error('Waktu tunggu habis. Task masih berjalan; buka Koleksi Saya beberapa saat lagi.');
  }

  async function generateMusic(event) {
    event.preventDefault();
    if (!supabaseClient) {
      openAuth();
      authNotice('Konfigurasi Supabase belum siap. Muat ulang halaman atau periksa koneksi.', true);
      return;
    }
    if (!currentUser) {
      openAuth();
      authNotice('Masuk atau buat akun terlebih dahulu agar riwayat lagu tersimpan.', true);
      return;
    }
    const idea = $('idea').value.trim();
    if (!idea) { $('idea').focus(); return; }
    const lyrics = $('lyrics').disabled ? '' : $('lyrics').value.trim();
    const instrumental = isInstrumental || $('vocal').value === 'Instrumental';
    const vocal = instrumental ? 'Instrumental' : $('vocal').value;
    const style = [selectedGenre, $('mood').value, vocal, idea].filter(Boolean).join(', ');
    const prompt = lyrics && isCustom && !instrumental ? lyrics : idea;
    const historyPrompt = lyrics && isCustom && !instrumental ? `${idea}\n\nLirik:\n${lyrics}` : idea;
    if (!window.confirm('Pembuatan lagu memakai kuota SunoAPI. Lanjutkan?')) return;

    const button = $('generate');
    button.disabled = true;
    showGenerationStatus('Mengirim permintaan…', 'Menghubungi server Musik Fattah.');
    let taskId = '';
    try {
      const response = await fetch(`${API_BASE}/generate-music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          prompt,
          style,
          title: idea.slice(0, 80),
          instrumental,
          customMode: Boolean(lyrics && isCustom && !instrumental),
          model: 'V6'
        })
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Generate HTTP ${response.status}: ${JSON.stringify(body).slice(0, 350)}`);
      taskId = findTaskId(body) || '';
      if (!taskId) throw new Error(`Server tidak mengirim Task ID: ${JSON.stringify(body).slice(0, 400)}`);
      try { localStorage.setItem('fattahmusic.lastTaskId', taskId); } catch {}
      showGenerationStatus('Task diterima', `ID ${taskId} · menyimpan riwayat dan menunggu audio…`);
      try { await saveSong(taskId, historyPrompt, 'processing', []); }
      catch { authNotice('Lagu sedang dibuat, tetapi riwayat awal belum tersimpan. Periksa konfigurasi tabel Supabase.', true); }
      await pollTask(taskId, historyPrompt);
      $('librarySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if (taskId) {
        try { await saveSong(taskId, historyPrompt, 'failed', []); } catch {}
      }
      showGenerationStatus('Pembuatan lagu belum berhasil', error.message || 'Periksa koneksi server lalu coba lagi.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function lookupExistingTask() {
    if (!currentUser) { openAuth(); authNotice('Masuk terlebih dahulu untuk memuat hasil ke pustaka.', true); return; }
    const taskId = $('taskLookup').value.trim();
    if (!taskId) { toast('Tempel Task ID terlebih dahulu.'); $('taskLookup').focus(); return; }
    const button = $('lookupBtn');
    button.disabled = true;
    showGenerationStatus('Memuat lagu yang sudah dibuat…', 'Memeriksa task tanpa mengirim permintaan generate baru.');
    try {
      const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tracks = collectTracks(body, taskId);
      if (!tracks.length) throw new Error('Audio belum tersedia untuk Task ID ini.');
      mergeTracks(tracks);
      renderTracks();
      await saveSong(taskId, $('idea').value.trim(), 'complete', tracks);
      showGenerationStatus('Lagu ditemukan dan tersimpan', `${tracks.length} hasil masuk ke koleksi Anda.`, 'done');
    } catch (error) {
      showGenerationStatus('Hasil belum dapat dimuat', error.message || 'Periksa Task ID dan koneksi server.', 'error');
    } finally {
      button.disabled = false;
    }
  }

  function setAuthMode(mode) {
    document.querySelectorAll('[data-auth-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.authMode === mode);
    });
    $('nameField').style.display = mode === 'signup' ? 'block' : 'none';
    $('authTitle').textContent = mode === 'signup' ? 'Buat akun baru' : 'Selamat datang kembali';
    $('authIntro').textContent = mode === 'signup'
      ? 'Daftar dengan email untuk mulai membangun koleksi musikmu.'
      : 'Masuk untuk menyimpan dan mengelola karya musikmu.';
    $('authSubmit').textContent = mode === 'signup' ? 'Buat akun' : 'Masuk ke Studio';
    $('forgotPassword').style.display = mode === 'login' ? 'inline-block' : 'none';
    $('authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('authMessage').classList.remove('show');
  }

  function openAuth() {
    $('authOverlay').classList.add('open');
    if (!supabaseClient) authNotice('Supabase belum siap. Periksa koneksi dan muat ulang halaman.', true);
    setTimeout(() => $('authEmailInput').focus(), 50);
  }

  function closeAuth() { $('authOverlay').classList.remove('open'); }

  function updateAuthUI(user) {
    const previousId = currentUser?.id || '';
    currentUser = user || null;
    $('openAuth').style.display = currentUser ? 'none' : 'inline-flex';
    $('authUser').style.display = currentUser ? 'flex' : 'none';
    $('authEmail').textContent = currentUser?.email || '';
    if (currentUser) {
      closeAuth();
      if (previousId && previousId !== currentUser.id) allTracks = [];
      renderTracks();
    } else {
      historyRequest++;
      allTracks = [];
      renderTracks();
    }
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!supabaseClient) { authNotice('Konfigurasi Supabase tidak tersedia pada halaman ini.', true); return; }
    const email = $('authEmailInput').value.trim();
    const password = $('authPassword').value;
    const signup = document.querySelector('[data-auth-mode="signup"]').classList.contains('active');
    const button = $('authSubmit');
    button.disabled = true;
    button.textContent = 'Memproses…';
    try {
      if (signup) {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: $('authName').value.trim() },
            emailRedirectTo: window.location.origin + window.location.pathname
          }
        });
        if (error) throw error;
        if (data.session && data.user) {
          updateAuthUI(data.user);
          toast('Akun berhasil dibuat dan Anda sudah masuk.');
          await loadSavedSongs();
        } else {
          authNotice('Pendaftaran berhasil. Periksa email untuk konfirmasi, lalu masuk.');
        }
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        updateAuthUI(data.user);
        toast('Berhasil masuk. Memuat pustaka lagu…');
        await loadSavedSongs();
      }
    } catch (error) {
      authNotice(error.message || 'Autentikasi gagal. Coba lagi.', true);
    } finally {
      button.disabled = false;
      button.textContent = document.querySelector('[data-auth-mode="signup"]').classList.contains('active') ? 'Buat akun' : 'Masuk ke Studio';
    }
  }

  async function checkServer() {
    try {
      const response = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const ok = body.status === 'ok';
      $('serverStatusText').textContent = ok ? 'Server aktif' : 'Server merespons';
      $('serverBadge').dataset.state = ok ? 'ok' : 'error';
    } catch {
      $('serverStatusText').textContent = 'Server belum merespons';
      $('serverBadge').dataset.state = 'error';
    }
  }

  function wireTabs() {
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.tab;
        document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
        const labels = { create: 'Buat Musik', library: 'Koleksi Saya', explore: 'Jelajahi', liked: 'Disukai', settings: 'Pengaturan' };
        $('crumb').textContent = labels[activeTab] || 'Studio';
        if (activeTab === 'library' || activeTab === 'liked') {
          renderTracks();
          $('librarySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
          if (activeTab === 'library' && currentUser) loadSavedSongs();
        } else if (activeTab === 'create') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          toast(activeTab === 'explore' ? 'Jelajahi akan tersedia saat katalog musik disiapkan.' : 'Pengaturan akun dapat diubah setelah masuk.');
        }
      });
    });
  }

  function wireComposer() {
    $('idea').addEventListener('input', (event) => { $('charCount').textContent = `${event.target.value.length}/500`; });
    $('genres').addEventListener('click', (event) => {
      const button = event.target.closest('.chip');
      if (!button) return;
      document.querySelectorAll('#genres .chip').forEach((chip) => chip.classList.remove('selected'));
      button.classList.add('selected');
      selectedGenre = button.textContent.trim();
    });
    $('instrumental').addEventListener('click', () => {
      isInstrumental = !isInstrumental;
      $('instrumental').classList.toggle('on', isInstrumental);
      $('instrumental').setAttribute('aria-pressed', String(isInstrumental));
      $('vocal').disabled = isInstrumental;
      if (isInstrumental) $('vocal').value = 'Instrumental';
      else if ($('vocal').value === 'Instrumental') $('vocal').value = 'Vokal pria';
      $('lyrics').disabled = isInstrumental || !isCustom;
    });
    $('custom').addEventListener('click', () => {
      isCustom = !isCustom;
      $('custom').classList.toggle('on', isCustom);
      $('custom').setAttribute('aria-pressed', String(isCustom));
      $('lyrics').disabled = isInstrumental || !isCustom;
      $('genres').style.opacity = isCustom ? '1' : '.65';
    });
    $('musicForm').addEventListener('submit', generateMusic);
    $('lookupBtn').addEventListener('click', lookupExistingTask);
    $('viewAll').addEventListener('click', () => {
      activeTab = 'library';
      document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item.dataset.tab === activeTab));
      renderTracks();
      $('librarySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (currentUser) loadSavedSongs();
    });
    $('vipBtn').addEventListener('click', () => toast('Fitur paket berbayar belum tersedia.'));
  }

  function wireAuth() {
    $('openAuth').addEventListener('click', openAuth);
    $('closeAuth').addEventListener('click', closeAuth);
    $('authOverlay').addEventListener('click', (event) => { if (event.target.id === 'authOverlay') closeAuth(); });
    document.querySelectorAll('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
    $('authForm').addEventListener('submit', handleAuthSubmit);
    $('forgotPassword').addEventListener('click', async () => {
      if (!supabaseClient) { authNotice('Konfigurasi Supabase belum tersedia.', true); return; }
      const email = $('authEmailInput').value.trim();
      if (!email) { authNotice('Masukkan alamat email terlebih dahulu.', true); return; }
      try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
        if (error) throw error;
        authNotice('Link reset kata sandi dikirim jika email terdaftar. Periksa kotak masuk dan spam.');
      } catch (error) { authNotice(error.message || 'Gagal mengirim link reset.', true); }
    });
    $('signOut').addEventListener('click', async () => {
      const { error } = await supabaseClient.auth.signOut();
      if (error) { toast(`Gagal keluar: ${error.message}`); return; }
      updateAuthUI(null);
      toast('Anda sudah keluar.');
    });
  }

  function initializeAuth() {
    if (!supabaseReady) {
      $('openAuth').disabled = true;
      authNotice('Konfigurasi Supabase tidak tersedia pada halaman ini.', true);
      return;
    }
    try {
      supabaseClient = window.supabase.createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    } catch (error) {
      $('openAuth').disabled = true;
      authNotice(`Supabase tidak dapat dimulai: ${error.message || 'konfigurasi tidak valid.'}`, true);
      return;
    }
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      updateAuthUI(session?.user || null);
      if (session?.user) setTimeout(() => loadSavedSongs(), 0);
    });
    supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) { authNotice(`Sesi login tidak dapat dibaca: ${error.message}`, true); return; }
      updateAuthUI(data.session?.user || null);
      if (data.session?.user) loadSavedSongs();
    }).catch((error) => authNotice(`Sesi login tidak dapat dibaca: ${error.message}`, true));
  }

  wireTabs();
  wireComposer();
  wireAuth();
  initializeAuth();
  checkServer();
  renderTracks();
})();
