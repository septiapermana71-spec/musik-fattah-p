# Musik Fattah API

Backend FastAPI untuk membuat musik melalui SunoAPI.org.

## Konfigurasi

Atur variabel berikut pada lingkungan deployment (misalnya Render → Service → Environment):

- `SUNO_API_KEY` — API key Bearer yang dibuat dari dashboard SunoAPI.org. Jangan commit atau membagikan nilai ini.
- `DATABASE_URL` — URL PostgreSQL yang digunakan untuk menyimpan metadata lagu.
- `BASE_URL` — URL publik aplikasi, tanpa garis miring di akhir; dipakai untuk callback dan file media. Contoh: `https://nama-service.onrender.com`.
- `SUNO_API_BASE` — opsional; default `https://apibox.erweima.ai/api/v1` sesuai dokumentasi SunoAPI.org.
- `PORT` — diatur otomatis oleh Render.

Aplikasi mengirim request dengan header `Authorization: Bearer <SUNO_API_KEY>`. Endpoint generate musik menggunakan `POST /generate` dan status menggunakan `GET /generate/record-info?taskId=...`. Model default telah diubah ke `V6`.

## Menjalankan lokal

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

Aplikasi tetap membutuhkan `DATABASE_URL` saat memproses callback audio/video. Tidak ada API key yang disertakan dalam repositori.
