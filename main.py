import os
import httpx
import requests
import psycopg2
from fastapi import FastAPI, Request, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional

# ==================================================
# WAJIB PALING ATAS: BUAT FOLDER MEDIA
# ==================================================
os.makedirs("media", exist_ok=True)

# ================= ENV =================
SUNO_API_KEY = os.getenv("SUNO_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

BASE_URL = (
    os.getenv("BASE_URL")
    or os.getenv("RENDER_EXTERNAL_URL")
    or "https://musik-fattah-p.onrender.com"
).rstrip("/")

CALLBACK_URL = f"{BASE_URL}/callback"

SUNO_BASE_API = os.getenv(
    "SUNO_API_BASE",
    "https://apibox.erweima.ai/api/v1"
).rstrip("/")
STYLE_GENERATE_URL = f"{SUNO_BASE_API}/style/generate"
MUSIC_GENERATE_URL = f"{SUNO_BASE_API}/generate"
STATUS_URL = f"{SUNO_BASE_API}/generate/record-info"
LYRICS_URL = f"{SUNO_BASE_API}/generate/get-timestamped-lyrics"
VIDEO_URL = f"{SUNO_BASE_API}/mp4/generate"
VIDEO_STATUS_URL = f"{SUNO_BASE_API}/mp4/record-info"

# ================= APP =================
app = FastAPI(
    title="AI Music Suno API Wrapper",
    version="2.0.0"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://septiapermana71-spec.github.io"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)

# ==================================================
# STATIC FILES
# ==================================================
app.mount("/media", StaticFiles(directory="media"), name="media")

# ================= REQUEST MODEL =================
class BoostStyleRequest(BaseModel):
    content: str

class GenerateMusicRequest(BaseModel):
    prompt: str
    style: Optional[str] = None
    title: Optional[str] = None
    instrumental: bool = False
    customMode: bool = False
    model: str = "V6"

# ================= HELPERS =================
def suno_headers():
    if not SUNO_API_KEY:
        raise HTTPException(500, "SUNO_API_KEY not set")
    return {
        "Authorization": f"Bearer {SUNO_API_KEY}",
        "Content-Type": "application/json"
    }

def normalize_task_response(provider_response: dict):
    data = provider_response.get("data")
    candidates = [data] if isinstance(data, dict) else (data if isinstance(data, list) else [])
    task_id = provider_response.get("taskId") or provider_response.get("task_id")

    for item in candidates:
        if isinstance(item, dict):
            task_id = task_id or item.get("taskId") or item.get("task_id")
            if task_id:
                item.setdefault("taskId", task_id)
                item.setdefault("task_id", task_id)
                break

    if not task_id:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "SunoAPI did not return a task ID",
                "provider_code": provider_response.get("code"),
                "provider_message": provider_response.get("msg")
            }
        )

    provider_response["taskId"] = task_id
    provider_response["task_id"] = task_id
    return provider_response

def find_audio_candidates(payload):
    candidates = []

    def walk(value):
        if isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            audio_url = (
                value.get("audioUrl") or value.get("audio_url")
                or value.get("streamAudioUrl") or value.get("stream_audio_url")
            )
            if isinstance(audio_url, str) and audio_url.startswith(("https://", "http://")):
                audio_id = value.get("audioId") or value.get("audio_id") or value.get("id")
                candidates.append((str(audio_id) if audio_id is not None else "", audio_url))
            for child in value.values():
                if isinstance(child, (dict, list)):
                    walk(child)

    walk(payload)
    return candidates

def normalize_model(model: str) -> str:
    if model.lower() in ["v4", "v4_5", "v45"]:
        return "V4_5"
    return model

def get_conn():
    if not DATABASE_URL:
        raise HTTPException(500, "DATABASE_URL not set")
    return psycopg2.connect(DATABASE_URL)

def save_file(url: str, path: str):
    r = requests.get(url, timeout=120)
    with open(path, "wb") as f:
        f.write(r.content)

# ================= ROOT =================
@app.get("/")
def root():
    return {"status": "running", "service": "AI Music Suno API"}

@app.get("/health")
def health():
    return {"status": "ok"}

# ================= BOOST STYLE =================
@app.post("/boost-style")
async def boost_style(payload: BoostStyleRequest):
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            STYLE_GENERATE_URL,
            headers=suno_headers(),
            json={"content": payload.content}
        )
    return res.json()

# ================= GENERATE MUSIC =================
@app.post("/generate-music")
async def generate_music(payload: GenerateMusicRequest):

    body = {
        "prompt": payload.prompt,
        "customMode": payload.customMode,
        "instrumental": payload.instrumental,
        "model": normalize_model(payload.model),
        "callBackUrl": CALLBACK_URL
    }

    if payload.style:
        body["style"] = payload.style
    if payload.title:
        body["title"] = payload.title

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            MUSIC_GENERATE_URL,
            headers=suno_headers(),
            json=body
        )

    if res.status_code != 200:
        raise HTTPException(500, "Gagal generate musik")

    try:
        provider_response = res.json()
    except ValueError:
        raise HTTPException(502, "SunoAPI returned invalid JSON")

    return normalize_task_response(provider_response)

# ================= RECORD INFO =================
@app.get("/record-info/{task_id}")
async def record_info(task_id: str):
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(
            STATUS_URL,
            headers=suno_headers(),
            params={"taskId": task_id}
        )
    return res.json()

@app.get("/lyrics/{task_id}")
async def get_lyrics(task_id: str, audioId: str):
    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            LYRICS_URL,
            headers=suno_headers(),
            json={"taskId": task_id, "audioId": audioId}
        )
    if res.status_code >= 400:
        raise HTTPException(502, "Gagal mengambil lirik dari SunoAPI")
    try:
        return res.json()
    except ValueError:
        raise HTTPException(502, "SunoAPI mengembalikan respons lirik yang tidak valid")

@app.get("/download/{task_id}")
async def download_music(task_id: str, audioId: Optional[str] = None):
    async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
        record_res = await client.get(
            STATUS_URL,
            headers=suno_headers(),
            params={"taskId": task_id}
        )
        if record_res.status_code >= 400:
            raise HTTPException(502, "Gagal mengambil informasi audio dari SunoAPI")
        try:
            record = record_res.json()
        except ValueError:
            raise HTTPException(502, "SunoAPI mengembalikan status audio yang tidak valid")

        candidates = find_audio_candidates(record)
        selected = next((item for item in candidates if audioId and item[0] == audioId), None)
        if selected is None and (not audioId or len(candidates) == 1):
            selected = candidates[0] if candidates else None
        if selected is None:
            raise HTTPException(404, "Audio belum tersedia atau audio ID tidak ditemukan")

        audio_res = await client.get(selected[1])
        if audio_res.status_code >= 400:
            raise HTTPException(502, "Gagal mengunduh audio dari penyedia musik")

    media_type = audio_res.headers.get("content-type", "audio/mpeg").split(";", 1)[0]
    if not media_type.startswith("audio/") and media_type != "application/octet-stream":
        media_type = "audio/mpeg"
    return Response(
        content=audio_res.content,
        media_type=media_type,
        headers={"Content-Disposition": 'attachment; filename="FattahMusic.mp3"', "Cache-Control": "no-store"}
    )

# ================= VIDEO DOWNLOAD =================
def local_video_path(task_id: str) -> str:
    if not task_id or len(task_id) > 180 or not all(ch.isalnum() or ch in "-_" for ch in task_id):
        raise HTTPException(400, "Task ID tidak valid")
    return os.path.join("media", f"{task_id}.mp4")

def download_video_file(video_url: str, path: str):
    if not isinstance(video_url, str) or not video_url.startswith(("https://", "http://")):
        raise ValueError("URL video tidak valid")
    temp_path = path + ".part"
    try:
        with requests.get(video_url, stream=True, timeout=120) as response:
            response.raise_for_status()
            with open(temp_path, "wb") as f:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        f.write(chunk)
        if os.path.getsize(temp_path) <= 0:
            raise ValueError("Berkas MP4 kosong")
        os.replace(temp_path, path)
    except Exception:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        raise


def save_video_callback(video_task_id: str, video_url: str):
    """Simpan callback MP4 dengan memetakan ID task video ke task audio induk."""
    conn = None
    cur = None
    try:
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT task_id FROM songs WHERE video_task_id=%s LIMIT 1", (video_task_id,))
        row = cur.fetchone()
        if not row:
            cur.execute("SELECT task_id FROM songs WHERE task_id=%s LIMIT 1", (video_task_id,))
            row = cur.fetchone()
        if not row:
            raise RuntimeError("Task video belum memiliki task lagu induk di database")
        audio_task_id = str(row[0])
        cur.close(); cur = None
        conn.close(); conn = None

        path = local_video_path(audio_task_id)
        download_video_file(video_url, path)
        local_url = f"{BASE_URL}/media/{audio_task_id}.mp4"

        conn = get_conn()
        cur = conn.cursor()
        cur.execute("UPDATE songs SET video_url=%s,status='done' WHERE task_id=%s", (local_url, audio_task_id))
        conn.commit()
        print("VIDEO SAVED:", audio_task_id)
    except Exception as exc:
        print("VIDEO CALLBACK SAVE ERROR:", str(exc))
    finally:
        if cur:
            cur.close()
        if conn:
            conn.close()


@app.get("/video-status/{task_id}")
def video_status(task_id: str):
    path = local_video_path(task_id)
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return {"ready": True, "status": "SUCCESS"}

    conn = get_conn()
    cur = conn.cursor()
    try:
        cur.execute("SELECT video_task_id FROM songs WHERE task_id=%s LIMIT 1", (task_id,))
        row = cur.fetchone()
    finally:
        cur.close()
        conn.close()

    if not row:
        return {"ready": False, "status": "NOT_FOUND", "message": "Task video belum tercatat. Periksa lagi setelah callback audio selesai."}
    video_task_id = str(row[0]) if row[0] else ""
    if not video_task_id:
        return {"ready": False, "status": "NOT_STARTED", "message": "Task pembuatan MP4 belum tercatat untuk lagu ini."}

    # Migrasikan berkas yang sempat tersimpan memakai ID task video, bukan ID lagu.
    legacy_path = local_video_path(video_task_id)
    if video_task_id != task_id and os.path.isfile(legacy_path) and os.path.getsize(legacy_path) > 0:
        os.replace(legacy_path, path)
        local_url = f"{BASE_URL}/media/{task_id}.mp4"
        conn = get_conn(); cur = conn.cursor()
        try:
            cur.execute("UPDATE songs SET video_url=%s,status='done' WHERE task_id=%s", (local_url, task_id))
            conn.commit()
        finally:
            cur.close(); conn.close()
        return {"ready": True, "status": "SUCCESS"}

    try:
        response = requests.get(
            VIDEO_STATUS_URL,
            headers=suno_headers(),
            params={"taskId": video_task_id},
            timeout=25
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        return {"ready": False, "status": "POLL_ERROR", "message": str(exc)[:240]}

    video_data = payload.get("data") if isinstance(payload, dict) else {}
    video_data = video_data if isinstance(video_data, dict) else {}
    result = video_data.get("response") if isinstance(video_data.get("response"), dict) else {}
    video_url = result.get("videoUrl") or video_data.get("videoUrl") or video_data.get("video_url")
    state = str(video_data.get("successFlag") or video_data.get("status") or payload.get("status") or "PENDING").upper()
    if not video_url:
        message = video_data.get("errorMessage") or payload.get("msg") or "Video masih diproses."
        return {"ready": False, "status": state, "message": str(message)[:240]}

    try:
        download_video_file(video_url, path)
        local_url = f"{BASE_URL}/media/{task_id}.mp4"
        conn = get_conn(); cur = conn.cursor()
        try:
            cur.execute("UPDATE songs SET video_url=%s,status='done' WHERE task_id=%s", (local_url, task_id))
            conn.commit()
        finally:
            cur.close(); conn.close()
        return {"ready": True, "status": "SUCCESS"}
    except Exception as exc:
        return {"ready": False, "status": "DOWNLOAD_FAILED", "message": str(exc)[:240]}


@app.get("/download-video/{task_id}")
def download_video(task_id: str):
    path = local_video_path(task_id)
    if not os.path.isfile(path) or os.path.getsize(path) <= 0:
        raise HTTPException(404, "MP4 belum siap. Periksa status video lalu coba lagi.")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=f"FattahMusic-{task_id}.mp4",
        headers={"Cache-Control": "no-store"}
    )

# ================= CALLBACK =================
@app.post("/callback")
async def callback(request: Request, background_tasks: BackgroundTasks):
    data = await request.json()
    print("CALLBACK:", data)

    try:
        callback_type = data.get("callbackType") or data.get("callback_type")
        provider_code = data.get("code")
        raw_items = data.get("data") or data.get("sunoData") or []
        if isinstance(raw_items, list):
            item = raw_items[0] if raw_items else {}
        elif isinstance(raw_items, dict):
            item = raw_items
        else:
            item = {}

        if not isinstance(item, dict):
            item = {}

        # SunoAPI MP4 callback uses code=200 and data.task_id/video_url;
        # it does not include callbackType or a nested status field.
        video_url = item.get("videoUrl") or item.get("video_url") or item.get("resultUrl")
        if video_url:
            if provider_code not in (None, 200, "200"):
                return {"status": "video_failed", "message": data.get("msg") or data.get("errorMessage")}
            video_task_id = (
                item.get("task_id") or item.get("taskId")
                or data.get("taskId") or data.get("task_id")
            )
            if not video_task_id:
                return {"status": "error", "message": "Video callback tidak menyertakan task ID"}
            background_tasks.add_task(save_video_callback, str(video_task_id), str(video_url))
            return {"status": "video_save_queued"}

        if callback_type == "error" or (provider_code is not None and str(provider_code) != "200"):
            return {"status": "failed", "message": data.get("msg") or data.get("errorMessage")}
        if not item:
            return {"status": "ignored"}

        state = callback_type or item.get("state") or item.get("status")
        if state not in ["succeeded", "success", "first", "complete"]:
            return {"status": "processing"}

        task_id = data.get("taskId") or data.get("task_id") or item.get("taskId") or item.get("task_id")
        if not task_id:
            return {"status": "error", "message": "Audio callback tidak menyertakan task ID"}

        audio_url = (
            item.get("audioUrl")
            or item.get("audio_url")
            or item.get("streamAudioUrl")
            or item.get("stream_audio_url")
        )
        if not audio_url:
            return {"status": "unknown_callback"}

        audio_id = item.get("audioId") or item.get("audio_id") or item.get("id")
        image_url = item.get("imageUrl") or item.get("image_url")
        title = item.get("title", "Untitled")

        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT status FROM songs WHERE task_id=%s", (task_id,))
        row = cur.fetchone()
        if row and row[0] in ["audio_done", "done"]:
            cur.close()
            conn.close()
            return {"status": "already_processed"}

        mp3_path = f"media/{task_id}.mp3"
        save_file(audio_url, mp3_path)
        local_audio_url = f"{BASE_URL}/media/{task_id}.mp3"

        async with httpx.AsyncClient(timeout=60) as client:
            lyrics_res = await client.post(
                LYRICS_URL,
                headers=suno_headers(),
                json={"taskId": task_id, "audioId": audio_id}
            )
        try:
            lyrics_data = lyrics_res.json()
        except Exception:
            lyrics_data = {"message": "Lirik belum tersedia"}

        video_task_id = None
        video_error = None
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                video_res = await client.post(
                    VIDEO_URL,
                    headers=suno_headers(),
                    json={
                        "taskId": task_id,
                        "audioId": audio_id,
                        "callBackUrl": CALLBACK_URL,
                        "author": "AI Artist",
                        "domainName": BASE_URL
                    }
                )
            video_body = video_res.json()
            video_data = video_body.get("data") if isinstance(video_body, dict) else {}
            video_data = video_data if isinstance(video_data, dict) else {}
            if video_res.status_code >= 400 or video_body.get("code") not in (None, 200, "200"):
                raise RuntimeError(str(video_body.get("msg") or video_body.get("message") or f"HTTP {video_res.status_code}"))
            video_task_id = video_data.get("taskId") or video_data.get("task_id")
            if not video_task_id:
                raise RuntimeError("Respons SunoAPI tidak menyertakan task ID video")
        except Exception as exc:
            video_error = str(exc)
            print("VIDEO START ERROR:", video_error)

        cur.execute("""
            INSERT INTO songs
            (task_id, title, audio_url, cover_url, lyrics, audio_id, video_task_id, status)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (task_id) DO UPDATE SET
                audio_url=EXCLUDED.audio_url,
                lyrics=EXCLUDED.lyrics,
                audio_id=EXCLUDED.audio_id,
                video_task_id=EXCLUDED.video_task_id,
                status='audio_done'
        """, (
            task_id,
            title,
            local_audio_url,
            image_url,
            str(lyrics_data),
            audio_id,
            video_task_id,
            "audio_done"
        ))
        conn.commit()
        cur.close()
        conn.close()

        return {
            "status": "audio_saved_video_started" if video_task_id else "audio_saved_video_start_failed",
            "videoMessage": video_error
        }

    except Exception as exc:
        print("CALLBACK ERROR:", str(exc))
        return {"status": "error", "error": str(exc)}

# ================= DB TEST =================
@app.get("/db-all")
def db_all():
    conn = get_conn()
    cur = conn.cursor()
    cur.execute("SELECT * FROM songs;")
    rows = cur.fetchall()
    cur.close()
    conn.close()
    return rows
