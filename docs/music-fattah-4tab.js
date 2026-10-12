(() => {
  'use strict';

  const API_BASE = 'https://musik-fattah-p.onrender.com';
  const $ = (id) => document.getElementById(id);
  const config = window.FATTAH_SUPABASE_CONFIG || {};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let supabaseClient = null;
  let currentUser = null;
  let currentMode = 'prompt';
  let currentAuthMode = 'login';
  let activeFilter = 'Semua';
  let allTracks = [];
  let toastTimer = 0;
  let historyRequest = 0;
  let lastLoadedUserId = '';
  const videoReady = new Set();
  let favoriteIds = new Set();

  try {
    const saved = JSON.parse(localStorage.getItem('fattahmusic.favorites') || '[]');
    if (Array.isArray(saved)) favoriteIds = new Set(saved.map(String));
  } catch {}

  function toast(message) {
    const node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.style.display = 'none'; }, 3500);
  }

  function authNotice(message, isError = false) {
    const node = $('authMessage');
    if (!node) return;
    node.textContent = message;
    node.classList.toggle('error', isError);
    node.classList.add('show');
  }

  function status(title, text = '', state = 'loading') {
    const box = $('generationStatus');
    if (!box) return;
    box.hidden = false;
    box.className = `generation-status${state === 'error' ? ' error' : ''}${state === 'done' ? ' done' : ''}`;
    $('generationTitle').textContent = title;
    $('generationText').textContent = text;
    $('generationSpinner').hidden = state !== 'loading';
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
        const failure = findFailure(child);
        if (failure) return failure;
      }
      return null;
    }
    const state = String(value.status || value.state || value.callbackType || value.callback_type || '').toLowerCase();
    if (['failed', 'error', 'failure'].includes(state)) return value.msg || value.errorMessage || value.error || state;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') {
        const failure = findFailure(child);
        if (failure) return failure;
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

  function normalizeTracks(row) {
    return (Array.isArray(row.tracks) ? row.tracks : []).map((track) => ({
      url: track.audio_url || track.url || '',
      title: track.title || '',
      id: String(track.audio_id || track.id || ''),
      taskId: row.task_id,
      imageUrl: track.image_url || track.imageUrl || ''
    })).filter((track) => track.url && /^https?:\/\//i.test(track.url));
  }

  function selectedText(group) {
    return document.querySelector(`#${group} .selected`)?.textContent.trim().replace(/^[^\p{L}\p{N}]+/u, '') || '';
  }

  function emptyText() {
    if (activeFilter === 'Favorit') return 'Belum ada lagu favorit. Tekan ♡ pada lagu untuk menyimpannya di sini.';
    if (activeFilter === 'Video') return 'Belum ada MP4 yang siap. Lagu baru akan diproses menjadi video setelah audionya selesai.';
    return currentUser ? 'Belum ada lagu di koleksi ini. Buat lagu baru dari tab Buat Musik.' : 'Masuk lewat tab Profil untuk menyimpan lagu dan melihat riwayat akun.';
  }

  function renderTracks() {
    const list = $('songs');
    if (!list) return;
    list.replaceChildren();
    let visible = allTracks;
    if (activeFilter === 'Favorit') visible = allTracks.filter((track) => favoriteIds.has(trackKey(track)));
    if (activeFilter === 'Video') visible = allTracks.filter((track) => videoReady.has(track.taskId));

    if ($('collectionCount')) $('collectionCount').textContent = `${visible.length} ${visible.length === 1 ? 'lagu' : 'lagu'}`;
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = emptyText();
      list.append(empty);
      return;
    }

    const videoButtonTasks = new Set();
    visible.forEach((track, index) => {
      const card = document.createElement('article');
      card.className = 'song generated-card';
      card.dataset.type = 'Audio';
      const cover = document.createElement('div');
      cover.className = 'generated-cover';
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
      info.className = 'generated-info';
      const title = document.createElement('strong');
      title.textContent = track.title || `Lagu AI · ${index + 1}`;
      const meta = document.createElement('small');
      meta.textContent = track.id ? `Audio ID ${track.id}` : 'Hasil SunoAPI';
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.src = track.url;
      audio.setAttribute('aria-label', `Putar ${track.title || 'lagu AI'}`);
      info.append(title, meta, audio);

      const actions = document.createElement('div');
      actions.className = 'generated-actions';
      const mp3 = document.createElement('button');
      mp3.type = 'button';
      mp3.className = 'generated-button';
      mp3.textContent = '↓ Unduh MP3';
      mp3.addEventListener('click', () => downloadMp3(track, mp3, index));
      actions.append(mp3);

      if (track.taskId && !videoButtonTasks.has(track.taskId)) {
        videoButtonTasks.add(track.taskId);
        const mp4 = document.createElement('button');
        mp4.type = 'button';
        mp4.className = 'generated-button';
        mp4.textContent = '▣ Unduh MP4';
        mp4.addEventListener('click', () => downloadMp4(track, mp4));
        actions.append(mp4);
      }

      const favorite = document.createElement('button');
      favorite.type = 'button';
      favorite.className = 'generated-button favorite-button';
      const setFavorite = () => {
        const liked = favoriteIds.has(trackKey(track));
        favorite.textContent = liked ? '♥ Disukai' : '♡ Suka';
        favorite.setAttribute('aria-pressed', String(liked));
      };
      setFavorite();
      favorite.addEventListener('click', () => {
        const key = trackKey(track);
        if (favoriteIds.has(key)) favoriteIds.delete(key);
        else favoriteIds.add(key);
        try { localStorage.setItem('fattahmusic.favorites', JSON.stringify([...favoriteIds])); } catch {}
        setFavorite();
        if (activeFilter === 'Favorit') renderTracks();
      });
      actions.append(favorite);

      const lyrics = document.createElement('details');
      lyrics.className = 'generated-lyrics';
      const summary = document.createElement('summary');
      summary.textContent = 'Lihat lirik';
      const lyricsBody = document.createElement('div');
      lyricsBody.className = 'generated-lyrics-body';
      lyricsBody.textContent = 'Buka untuk mengambil lirik dari server.';
      lyrics.append(summary, lyricsBody);
      lyrics.addEventListener('toggle', () => {
        if (lyrics.open && !lyrics.dataset.requested) {
          lyrics.dataset.requested = '1';
          loadLyrics(track, lyricsBody);
        }
      });
      actions.append(lyrics);
      card.append(cover, info, actions);
      list.append(card);
    });
  }

  async function downloadMp3(track, button, index) {
    if (!track.taskId) { toast('Task ID tidak tersedia untuk unduhan.'); return; }
    button.disabled = true;
    button.textContent = 'Mengunduh…';
    try {
      const query = track.id ? `?audioId=${encodeURIComponent(track.id)}` : '';
      const response = await fetch(`${API_BASE}/download/${encodeURIComponent(track.taskId)}${query}`);
      if (!response.ok) {
        const body = await readJson(response);
        throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error('Berkas MP3 kosong.');
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `MusicFattah-${index + 1}.mp3`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      toast('Unduhan MP3 dimulai.');
    } catch (error) {
      toast(`MP3 belum dapat diunduh: ${error.message || 'periksa koneksi server.'}`);
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
      const result = await readJson(response);
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : `HTTP ${response.status}`);
      if (!result.ready) {
        const labels = {
          PENDING: 'MP4 masih diproses otomatis.',
          NOT_STARTED: 'Pembuatan MP4 belum dimulai untuk lagu ini.',
          NOT_FOUND: 'Task video belum tercatat di server.',
          CREATE_TASK_FAILED: 'SunoAPI gagal memulai pembuatan MP4.',
          GENERATE_MP4_FAILED: 'SunoAPI gagal membuat MP4.',
          CALLBACK_EXCEPTION: 'SunoAPI melaporkan kendala callback MP4.',
          POLL_ERROR: 'Server gagal memeriksa status MP4.',
          DOWNLOAD_FAILED: 'Video siap, tetapi server belum bisa mengambil berkas MP4.'
        };
        const message = labels[result.status] || `Status MP4: ${result.status || 'belum siap'}.`;
        toast(result.message ? `${message} ${result.message}` : `${message} Coba lagi beberapa saat.`);
        return;
      }
      videoReady.add(track.taskId);
      window.location.assign(`${API_BASE}/download-video/${encodeURIComponent(track.taskId)}`);
    } catch (error) {
      toast(`MP4 belum dapat diunduh: ${error.message || 'periksa koneksi server.'}`);
    } finally {
      button.disabled = false;
      button.textContent = '▣ Unduh MP4';
    }
  }

  async function loadLyrics(track, node) {
    if (!track.taskId || !track.id) {
      node.className = 'generated-lyrics-body error';
      node.textContent = 'ID audio belum tersedia, jadi lirik tidak bisa diminta.';
      return;
    }
    node.className = 'generated-lyrics-body loading';
    node.textContent = 'Memuat lirik dari server…';
    try {
      const url = `${API_BASE}/lyrics/${encodeURIComponent(track.taskId)}?audioId=${encodeURIComponent(track.id)}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `HTTP ${response.status}`);
      const text = extractLyrics(body);
      if (!text) throw new Error('Server belum mengembalikan teks lirik.');
      node.className = 'generated-lyrics-body';
      node.textContent = text;
    } catch (error) {
      node.className = 'generated-lyrics-body error';
      node.textContent = `Lirik belum tersedia: ${error.message || 'periksa koneksi server.'}`;
    }
  }

  async function saveSong(taskId, prompt, state, tracks) {
    if (!currentUser || !supabaseClient) throw new Error('Sesi login tidak aktif. Masuk kembali untuk menyimpan riwayat.');
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
      status: state,
      tracks: safeTracks,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,task_id' });
    if (error) throw error;
  }

  async function loadSavedSongs() {
    if (!currentUser || !supabaseClient) return;
    const userId = currentUser.id;
    const requestId = ++historyRequest;
    authNotice('Memuat riwayat lagu…');
    try {
      const { data, error } = await supabaseClient.from('user_songs')
        .select('task_id,prompt,status,tracks,created_at')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      const restored = [];
      let pending = 0;
      for (const row of data || []) {
        let rowTracks = normalizeTracks(row);
        if (!rowTracks.length && row.task_id && ['processing', 'queued', 'audio_done'].includes(String(row.status).toLowerCase())) {
          try {
            const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(row.task_id)}`, { headers: { Accept: 'application/json' } });
            const body = await readJson(response);
            if (response.ok) rowTracks = collectTracks(body, row.task_id);
            if (rowTracks.length) await saveSong(row.task_id, row.prompt, 'complete', rowTracks);
            else pending++;
          } catch { pending++; }
        }
        restored.push(...rowTracks);
      }
      if (requestId !== historyRequest || currentUser?.id !== userId) return;
      allTracks = restored.filter((track, index, list) => list.findIndex((item) => trackKey(item) === trackKey(track)) === index);
      renderTracks();
      authNotice(allTracks.length
        ? `${allTracks.length} lagu dari akun Anda dimuat${pending ? ` · ${pending} task masih diproses` : ''}.`
        : (pending ? `${pending} lagu masih diproses. Buka kembali Koleksi beberapa saat lagi.` : 'Login aktif. Belum ada lagu tersimpan di akun ini.'));
    } catch (error) {
      authNotice(`Riwayat belum dapat dimuat: ${error.message || 'periksa tabel Supabase.'}`, true);
      toast('Riwayat belum dapat dimuat. Pastikan tabel user_songs sudah disiapkan di Supabase.');
    }
  }

  async function pollTask(taskId, prompt) {
    for (let attempt = 0; attempt < 60; attempt++) {
      await wait(10000);
      status('Meracik lagu…', `Memeriksa hasil · ${(attempt + 1) * 10} detik`);
      const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Pemeriksaan status gagal (HTTP ${response.status}).`);
      const tracks = collectTracks(body, taskId);
      if (tracks.length) {
        mergeTracks(tracks);
        renderTracks();
        let saved = true;
        try { await saveSong(taskId, prompt, 'complete', tracks); }
        catch { saved = false; }
        status(saved ? 'Lagu selesai dan tersimpan' : 'Lagu selesai, riwayat belum tersimpan', saved ? `${tracks.length} hasil masuk ke koleksi Anda. MP4 diproses otomatis.` : 'Audio tersedia; periksa tabel user_songs dan izin Supabase.', saved ? 'done' : 'error');
        toast(saved ? 'Lagu selesai dan tersimpan di Koleksi.' : 'Lagu selesai, tetapi riwayat Supabase belum tersimpan.');
        go('library');
        return;
      }
      const failure = findFailure(body);
      if (failure) throw new Error(`SunoAPI gagal: ${failure}`);
    }
    throw new Error('Waktu tunggu habis. Task mungkin masih berjalan; cek lagi nanti di Koleksi.');
  }

  async function generateMusic() {
    if (!supabaseClient || !currentUser) {
      go('profile');
      authNotice('Masuk atau buat akun dengan email terlebih dahulu agar riwayat lagu tersimpan.', true);
      return;
    }
    const input = $('prompt');
    const prompt = input.value.trim();
    if (!prompt) { toast('Tulis ide atau lirik lagu terlebih dahulu.'); input.focus(); return; }
    const genre = selectedText('genres') || 'Pop';
    const mood = selectedText('moods') || 'Santai';
    const vocal = selectedText('vocals') || 'Vokal Pria';
    const instrumental = /instrumental/i.test(vocal);
    const customMode = currentMode === 'lyrics' && !instrumental;
    const style = [genre, mood, instrumental ? 'Instrumental' : vocal].filter(Boolean).join(', ');
    const title = $('title')?.value.trim() || '';
    if (!window.confirm('Permintaan ini memakai kuota SunoAPI.org. Lanjutkan membuat lagu?')) return;

    const button = document.querySelector('#create .primary');
    if (button) { button.disabled = true; button.textContent = 'Mengirim…'; }
    status('Mengirim permintaan…', 'Menghubungi server Musik Fattah.');
    let taskId = '';
    try {
      const response = await fetch(`${API_BASE}/generate-music`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ prompt, style, title, instrumental, customMode, model: 'V6' })
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`Generate gagal (HTTP ${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
      taskId = findTaskId(body) || '';
      if (!taskId) throw new Error('Server tidak mengirim Task ID. Coba lagi setelah memeriksa status backend.');
      try { localStorage.setItem('fattahmusic.lastTaskId', taskId); } catch {}
      status('Task diterima', `ID ${taskId} · menyimpan riwayat dan menunggu audio…`);
      try { await saveSong(taskId, prompt, 'processing', []); }
      catch (error) { authNotice(`Lagu sedang dibuat, tetapi riwayat awal belum tersimpan: ${error.message || ''}`, true); }
      await pollTask(taskId, prompt);
    } catch (error) {
      if (taskId) { try { await saveSong(taskId, prompt, 'failed', []); } catch {} }
      status('Pembuatan lagu belum berhasil', error.message || 'Periksa koneksi server lalu coba lagi.', 'error');
      toast(error.message || 'Pembuatan lagu gagal.');
    } finally {
      if (button) { button.disabled = false; button.textContent = '✦ Buat Musik'; }
    }
  }

  async function lookupExistingTask() {
    if (!currentUser) { go('profile'); authNotice('Masuk terlebih dahulu untuk memuat hasil ke Koleksi.', true); return; }
    const taskId = $('taskLookup')?.value.trim();
    if (!taskId) { toast('Tempel Task ID terlebih dahulu.'); $('taskLookup')?.focus(); return; }
    const button = $('lookupBtn');
    if (button) { button.disabled = true; button.textContent = 'Memuat…'; }
    try {
      const response = await fetch(`${API_BASE}/record-info/${encodeURIComponent(taskId)}`, { headers: { Accept: 'application/json' } });
      const body = await readJson(response);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tracks = collectTracks(body, taskId);
      if (!tracks.length) throw new Error('Audio belum tersedia untuk Task ID ini.');
      mergeTracks(tracks);
      renderTracks();
      await saveSong(taskId, $('prompt')?.value.trim() || '', 'complete', tracks);
      toast(`${tracks.length} hasil ditambahkan ke Koleksi.`);
      go('library');
    } catch (error) {
      toast(`Hasil belum dapat dimuat: ${error.message || 'periksa Task ID.'}`);
    } finally {
      if (button) { button.disabled = false; button.textContent = 'Ambil hasil'; }
    }
  }

  async function refreshVideoStatuses() {
    const taskIds = [...new Set(allTracks.map((track) => track.taskId).filter(Boolean))].slice(0, 20);
    if (!taskIds.length) return;
    toast('Memeriksa status MP4 untuk koleksi Anda…');
    await Promise.allSettled(taskIds.map(async (taskId) => {
      const response = await fetch(`${API_BASE}/video-status/${encodeURIComponent(taskId)}`, { cache: 'no-store' });
      const result = await readJson(response);
      if (response.ok && result.ready) videoReady.add(taskId);
    }));
  }

  async function filterSongs(type, button) {
    activeFilter = type;
    document.querySelectorAll('#library .segment button').forEach((item) => item.classList.toggle('on', item === button || item.textContent.trim() === type));
    if (type === 'Video') await refreshVideoStatuses();
    renderTracks();
  }

  function go(pageId) {
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === pageId));
    document.querySelectorAll('.bottom button').forEach((button) => {
      const match = (button.getAttribute('onclick') || '').match(/go\(['"]([^'"]+)/);
      button.classList.toggle('active', Boolean(match && match[1] === pageId));
    });
    if (pageId === 'library') renderTracks();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setMode(mode, button) {
    currentMode = mode === 'lyrics' ? 'lyrics' : 'prompt';
    document.querySelectorAll('#create .segment button').forEach((item) => item.classList.toggle('on', item === button));
    const input = $('prompt');
    input.placeholder = currentMode === 'lyrics'
      ? 'Tulis lirik lagu orisinal kamu di sini…'
      : 'Tulis ide lagu kamu di sini…\nContoh: lagu pop tentang persahabatan, santai, penuh semangat';
  }

  function chooseChip(button, group) {
    const container = $(group);
    if (!container) return;
    container.querySelectorAll('button').forEach((item) => item.classList.toggle('selected', item === button));
  }

  function authMode(mode) {
    currentAuthMode = mode === 'register' ? 'register' : 'login';
    $('loginTab')?.classList.toggle('on', currentAuthMode === 'login');
    $('registerTab')?.classList.toggle('on', currentAuthMode === 'register');
    $('authTitle').textContent = currentAuthMode === 'register' ? 'Buat Akun Baru' : 'Masuk dengan Email';
    $('authDesc').textContent = currentAuthMode === 'register'
      ? 'Daftar menggunakan email untuk menyimpan koleksi lagu kamu.'
      : 'Masuk untuk menyimpan lagu dan mengakses riwayat kamu.';
    $('authSubmit').textContent = currentAuthMode === 'register' ? 'Daftar Sekarang' : 'Masuk';
    $('password').autocomplete = currentAuthMode === 'register' ? 'new-password' : 'current-password';
    $('authMessage')?.classList.remove('show');
  }

  function favorite(button) {
    const card = button.closest('.song');
    const key = card?.dataset.trackKey;
    if (!key) return;
    if (favoriteIds.has(key)) favoriteIds.delete(key); else favoriteIds.add(key);
    try { localStorage.setItem('fattahmusic.favorites', JSON.stringify([...favoriteIds])); } catch {}
    button.textContent = favoriteIds.has(key) ? '♥' : '♡';
  }

  function showToast(message) { toast(message); }

  async function checkServer() {
    const badge = $('serviceBadge');
    try {
      const response = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      if (badge) {
        badge.textContent = body.status === 'ok' ? '● Server aktif' : '● Server merespons';
        badge.dataset.state = body.status === 'ok' ? 'ok' : 'error';
      }
    } catch {
      if (badge) { badge.textContent = '● Server belum merespons'; badge.dataset.state = 'error'; }
    }
  }

  function updateAuthUI(user) {
    const previousId = currentUser?.id || '';
    currentUser = user || null;
    const form = $('authForm');
    const tabs = document.querySelector('.auth-tabs');
    const session = $('profileSession');
    if (currentUser) {
      if (form) form.hidden = true;
      if (tabs) tabs.hidden = true;
      if (session) session.hidden = false;
      $('profileEmail').textContent = currentUser.email || '';
      $('authTitle').textContent = 'Akun Anda';
      $('authDesc').textContent = 'Riwayat lagu disimpan secara pribadi di Supabase.';
      authNotice(`Masuk sebagai ${currentUser.email || 'pengguna'}.`);
      if (previousId && previousId !== currentUser.id) allTracks = [];
    } else {
      historyRequest++;
      allTracks = [];
      if (form) form.hidden = false;
      if (tabs) tabs.hidden = false;
      if (session) session.hidden = true;
      authMode('login');
      authNotice('Masuk atau daftar menggunakan email untuk menyimpan lagu.');
    }
    renderTracks();
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!supabaseClient) { authNotice('Konfigurasi Supabase belum tersedia pada halaman ini.', true); return; }
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!email || !password) { authNotice('Isi email dan kata sandi terlebih dahulu.', true); return; }
    if (currentAuthMode === 'register' && password.length < 6) { authNotice('Kata sandi minimal 6 karakter.', true); return; }
    const button = $('authSubmit');
    button.disabled = true;
    button.textContent = 'Memproses…';
    try {
      if (currentAuthMode === 'register') {
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + window.location.pathname }
        });
        if (error) throw error;
        if (data.session && data.user) {
          updateAuthUI(data.user);
          await loadSavedSongs();
        } else {
          authNotice('Akun berhasil dibuat. Periksa email untuk konfirmasi, lalu masuk.');
        }
      } else {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        updateAuthUI(data.user);
        await loadSavedSongs();
        toast('Berhasil masuk. Riwayat lagu dimuat.');
      }
    } catch (error) {
      authNotice(`Autentikasi gagal: ${error.message || 'coba lagi.'}`, true);
    } finally {
      button.disabled = false;
      button.textContent = currentAuthMode === 'register' ? 'Daftar Sekarang' : 'Masuk';
    }
  }

  function initializeAuth() {
    if (!window.supabase || !config.url || !config.key) {
      authNotice('Konfigurasi Supabase belum tersedia. Muat ulang halaman atau periksa koneksi.', true);
      return;
    }
    try {
      supabaseClient = window.supabase.createClient(config.url, config.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    } catch (error) {
      authNotice(`Supabase tidak dapat dimulai: ${error.message || 'konfigurasi tidak valid.'}`, true);
      return;
    }
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      const user = session?.user || null;
      updateAuthUI(user);
      if (user && lastLoadedUserId !== user.id) {
        lastLoadedUserId = user.id;
        setTimeout(() => loadSavedSongs(), 0);
      } else if (!user) lastLoadedUserId = '';
    });
    supabaseClient.auth.getSession().then(({ data, error }) => {
      if (error) { authNotice(`Sesi login tidak dapat dibaca: ${error.message}`, true); return; }
      const user = data.session?.user || null;
      updateAuthUI(user);
      if (user && lastLoadedUserId !== user.id) {
        lastLoadedUserId = user.id;
        loadSavedSongs();
      }
    }).catch((error) => authNotice(`Sesi login tidak dapat dibaca: ${error.message}`, true));
  }

  function wireUI() {
    $('prompt')?.addEventListener('input', (event) => {
      $('count').textContent = `${event.target.value.length}/500`;
    });
    $('authForm')?.addEventListener('submit', handleAuthSubmit);
    $('forgotPassword')?.addEventListener('click', async () => {
      if (!supabaseClient) { authNotice('Konfigurasi Supabase belum tersedia.', true); return; }
      const email = $('email').value.trim();
      if (!email) { authNotice('Masukkan alamat email terlebih dahulu.', true); return; }
      try {
        const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
        if (error) throw error;
        authNotice('Jika email terdaftar, tautan reset kata sandi akan dikirim. Periksa kotak masuk dan spam.');
      } catch (error) { authNotice(`Gagal mengirim tautan reset: ${error.message || ''}`, true); }
    });
    $('logoutBtn')?.addEventListener('click', async () => {
      const { error } = await supabaseClient.auth.signOut();
      if (error) { authNotice(`Gagal keluar: ${error.message}`, true); return; }
      updateAuthUI(null);
      toast('Anda sudah keluar.');
    });
    $('lookupBtn')?.addEventListener('click', lookupExistingTask);
  }

  function exposeInlineHandlers() {
    window.go = go;
    window.setMode = setMode;
    window.chooseChip = chooseChip;
    window.generate = generateMusic;
    window.filterSongs = filterSongs;
    window.favorite = favorite;
    window.showToast = showToast;
    window.authMode = authMode;
  }

  function start() {
    exposeInlineHandlers();
    wireUI();
    initializeAuth();
    checkServer();
    renderTracks();
  }

  start();
})();
