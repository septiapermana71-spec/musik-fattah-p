import os
import json
import logging
from pathlib import Path
from typing import Optional, Any

import httpx
import psycopg2
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ==================================================
# CONFIGURATION
# ==================================================
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("music-fattah-ai")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "media"))
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

SUNO_API_KEY = os.getenv("SUNO_API_KEY") or os.getenv("KIE_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

# Must match the Render service used by music-fattah-4tab.js.
BASE_URL = os.getenv("BASE_URL", "https://musik-fattah-p.onrender.com").rstrip("/")
CALLBACK_URL = f"{BASE_URL}/callback"

SUNO_BASE_API = "https://api.sunoapi.org/api/v1"
STYLE_GENERATE_URL = f"{SUNO_BASE_API}/style/generate"
MUSIC_GENERATE_URL = f"{SUNO_BASE_API}/generate"
STATUS_URL = f"{SUNO_BASE_API}/generate/record-info"
LYRICS_URL = f"{SUNO_BASE_API}/generate/get-timestamped-lyrics"
VIDEO_URL = f"{SUNO_BASE_API}/mp4/generate"

app = FastAPI(title="Music Fattah AI API", version="2.1.0")

# Frontend is hosted separately from Render, so browser requests need CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


# ==================================================
# REQUEST MODELS
# ==================================================
class BoostStyleRequest(BaseModel):
    content: str


class GenerateMusicRequest(BaseModel):
    prompt: str
    style: Optional[str] = None
    title: Optional[str] = None
    instrumental: bool = False
    customMode: bool = False
    model: str = "V4_5"


# ==================================================
# HELPERS
# ==================================================
def suno_headers():
    if not SUNO_API_KEY:
        raise HTTPException(status_code=500, detail="SUNO_API_KEY atau KIE_API_KEY belum diatur di Render.")
    return {
        "Authorization": f"Bearer {SUNO_API_KEY}",
        "Content-Type": "application/json",
    }


def normalize_model(model: str) -> str:
    # SunoAPI.org documents V3_5, V4, V4_5, and V4_5PLUS.
    # The current frontend sends V6, so map that value to the closest documented
    # current high-quality model instead of sending an unsupported model name.
    aliases = {
        "v3.5": "V3_5",
        "v3_5": "V3_5",
        "v4": "V4",
        "v4.5": "V4_5",
        "v4_5": "V4_5",
        "v45": "V4_5",
        "v4_5plus": "V4_5PLUS",
        "v4.5plus": "V4_5PLUS",
        "v6": "V4_5PLUS",
    }
    return aliases.get((model or "V4_5").lower(), model or "V4_5")


def get_conn():
    if not DATABASE_URL:
        raise HTTPException(status_code=500, detail="DATABASE_URL belum diatur di Render.")
    return psycopg2.connect(DATABASE_URL)


def extract_data_url(value: Any, audio_id: Optional[str] = None) -> Optional[str]:
    """Find an audio URL in a nested KIE/Suno response, preferring audio_id when given."""
    if isinstance(value, list):
        for item in value:
            result = extract_data_url(item, audio_id)
            if result:
                return result
        return None
    if not isinstance(value, dict):
        return None

    candidates = []
    url = value.get("audioUrl") or value.get("audio_url") or value.get("streamAudioUrl") or value.get("stream_audio_url")
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        candidates.append((value, url))
    if audio_id:
        for item, item_url in candidates:
            item_id = str(item.get("audioId") or item.get("audio_id") or item.get("id") or "")
            if item_id == str(audio_id):
                return item_url
    for item, item_url in candidates:
        return item_url

    for child in value.values():
        result = extract_data_url(child, audio_id)
        if result:
            return result
    return None


def extract_video_url(value: Any) -> Optional[str]:
    if isinstance(value, list):
        for item in value:
            result = extract_video_url(item)
            if result:
                return result
        return None
    if not isinstance(value, dict):
        return None
    for key in ("videoUrl", "video_url", "resultUrl", "result_url", "url"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.startswith(("http://", "https://")) and (key != "url" or candidate.lower().split("?")[0].endswith(".mp4")):
            return candidate
    for child in value.values():
        result = extract_video_url(child)
        if result:
            return result
    return None


async def kie_json(method: str, url: str, *, params=None, body=None, timeout=60):
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(
            method,
            url,
            headers=suno_headers(),
            params=params,
            json=body,
        )
    if response.is_error:
        logger.error("SunoAPI.org error %s: %s", response.status_code, response.text[:1000])
        raise HTTPException(
            status_code=502,
            detail=f"SunoAPI.org error HTTP {response.status_code}: {response.text[:500]}",
        )
    try:
        return response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="Respons SunoAPI.org bukan JSON yang valid.")


async def fetch_bytes(url: str, timeout=180) -> tuple[bytes, str]:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url)
    if response.is_error:
        raise HTTPException(status_code=502, detail=f"Gagal mengambil berkas dari sumber (HTTP {response.status_code}).")
    content_type = response.headers.get("content-type", "application/octet-stream")
    if not response.content:
        raise HTTPException(status_code=502, detail="Berkas yang diterima kosong.")
    return response.content, content_type


# ==================================================
# BASIC STATUS
# ==================================================
@app.get("/")
def root():
    return {"status": "running", "service": "Music Fattah AI API", "version": "2.1.0"}


@app.get("/health")
def health():
    return {"status": "ok"}


# ==================================================
# STYLE HELPER
# ==================================================
@app.post("/boost-style")
async def boost_style(payload: BoostStyleRequest):
    return await kie_json("POST", STYLE_GENERATE_URL, body={"content": payload.content})


# ==================================================
# GENERATE MUSIC — keep this endpoint compatible with the frontend
# ==================================================
@app.post("/generate-music")
async def generate_music(payload: GenerateMusicRequest):
    body = {
        "prompt": payload.prompt,
        "customMode": payload.customMode,
        "instrumental": payload.instrumental,
        "model": normalize_model(payload.model),
        "callBackUrl": CALLBACK_URL,
    }
    if payload.style:
        body["style"] = payload.style
    if payload.title:
        body["title"] = payload.title

    logger.info("Generate request: model=%s customMode=%s instrumental=%s style=%s", body["model"], body["customMode"], body["instrumental"], body.get("style", ""))
    return await kie_json("POST", MUSIC_GENERATE_URL, body=body)


# ==================================================
# TASK STATUS
# ==================================================
@app.get("/record-info/{task_id}")
async def record_info(task_id: str):
    return await kie_json("GET", STATUS_URL, params={"taskId": task_id}, timeout=45)


# ==================================================
# LYRICS ENDPOINT — required by music-fattah-4tab.js
# Frontend calls GET /lyrics/{task_id}?audioId=...
# ==================================================
@app.get("/lyrics/{task_id}")
async def get_lyrics(task_id: str, audioId: str = Query(..., min_length=1)):
    result = await kie_json(
        "POST",
        LYRICS_URL,
        body={"taskId": task_id, "audioId": audioId},
        timeout=60,
    )
    # SunoAPI.org returns timestamped words under data.alignedWords.
    # Normalize this to a `lyrics` string because the frontend can display that field.
    lyrics_lines = []
    data = result.get("data") if isinstance(result, dict) else None
    aligned = data.get("alignedWords") if isinstance(data, dict) else None
    if isinstance(aligned, list):
        for word in aligned:
            if not isinstance(word, dict):
                continue
            text = str(word.get("text") or word.get("word") or "").strip()
            if not text:
                continue
            start = word.get("start_s")
            if start is not None:
                lyrics_lines.append(f"[{start}] {text}")
            else:
                lyrics_lines.append(text)
    if lyrics_lines:
        result["lyrics"] = "\n".join(lyrics_lines)
    elif isinstance(data, dict):
        # Some responses may expose plain lyrics instead of aligned words.
        for key in ("lyrics", "lyric", "text", "plainLyrics", "syncedLyrics"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                result["lyrics"] = value.strip()
                break
    return result


# ==================================================
# MP3 DOWNLOAD — required by music-fattah-4tab.js
# ==================================================
@app.get("/download/{task_id}")
async def download_mp3(task_id: str, audioId: Optional[str] = Query(default=None)):
    local_file = MEDIA_DIR / f"{task_id}.mp3"
    if local_file.is_file() and local_file.stat().st_size > 0:
        return FileResponse(local_file, media_type="audio/mpeg", filename=f"MusicFattah-{task_id}.mp3")

    status_data = await kie_json("GET", STATUS_URL, params={"taskId": task_id}, timeout=45)
    audio_url = extract_data_url(status_data, audioId)
    if not audio_url:
        raise HTTPException(status_code=404, detail="Audio belum tersedia untuk Task ID ini.")
    content, content_type = await fetch_bytes(audio_url)
    return Response(
        content=content,
        media_type=content_type if content_type.startswith("audio/") else "audio/mpeg",
        headers={"Content-Disposition": f'attachment; filename="MusicFattah-{task_id}.mp3"'},
    )


# ==================================================
# MP4 STATUS AND DOWNLOAD — used by the collection UI
# ==================================================
@app.get("/video-status/{task_id}")
def video_status(task_id: str):
    local_file = MEDIA_DIR / f"{task_id}.mp4"
    if local_file.is_file() and local_file.stat().st_size > 0:
        return {"ready": True, "status": "READY", "url": f"{BASE_URL}/media/{task_id}.mp4"}

    if not DATABASE_URL:
        return {"ready": False, "status": "NOT_FOUND", "message": "DATABASE_URL belum diatur."}

    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT video_url, status FROM songs WHERE task_id=%s", (task_id,))
            row = cur.fetchone()
        if row and row[0]:
            return {"ready": True, "status": "READY", "url": row[0]}
        if row:
            return {"ready": False, "status": "PENDING", "message": "Audio sudah tercatat; video belum tersedia."}
        return {"ready": False, "status": "NOT_FOUND", "message": "Task video belum tercatat di database."}
    except Exception as exc:
        logger.exception("video_status database error")
        return {"ready": False, "status": "POLL_ERROR", "message": str(exc)}
    finally:
        conn.close()


@app.get("/download-video/{task_id}")
async def download_video(task_id: str):
    local_file = MEDIA_DIR / f"{task_id}.mp4"
    if local_file.is_file() and local_file.stat().st_size > 0:
        return FileResponse(local_file, media_type="video/mp4", filename=f"MusicFattah-{task_id}.mp4")

    if not DATABASE_URL:
        raise HTTPException(status_code=404, detail="Video belum tersedia.")
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT video_url FROM songs WHERE task_id=%s", (task_id,))
            row = cur.fetchone()
    finally:
        conn.close()

    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="Video belum siap. Coba lagi beberapa saat.")

    video_url = row[0]
    if video_url.startswith(f"{BASE_URL}/media/"):
        raise HTTPException(status_code=404, detail="Berkas video lokal tidak ditemukan di server.")
    content, _ = await fetch_bytes(video_url, timeout=240)
    return Response(
        content=content,
        media_type="video/mp4",
        headers={"Content-Disposition": f'attachment; filename="MusicFattah-{task_id}.mp4"'},
    )


# ==================================================
# CALLBACK FROM SUNOAPI.ORG
# Saves audio first even if lyric or MP4 generation fails.
# ==================================================
@app.post("/callback")
async def callback(request: Request):
    data = await request.json()
    logger.info("CALLBACK received: %s", json.dumps(data, ensure_ascii=False)[:3000])

    callback_data = data.get("data") if isinstance(data.get("data"), dict) else {}
    task_id = (
        data.get("taskId") or data.get("task_id")
        or callback_data.get("taskId") or callback_data.get("task_id")
    )
    items = callback_data.get("data") if isinstance(callback_data, dict) else None
    if not isinstance(items, list):
        raw_items = data.get("data")
        items = raw_items if isinstance(raw_items, list) else []
    if not task_id:
        return {"status": "ignored", "message": "taskId tidak ditemukan"}
    if not items:
        # A callback may contain one result at the root or under data.
        candidate = callback_data if callback_data else data
        items = [candidate]

    # SunoAPI.org callback stages include text, first, and complete.
    callback_type = str(callback_data.get("callbackType") or data.get("callbackType") or "").lower()
    if callback_type == "text":
        return {"status": "lyrics_stage_received", "taskId": task_id}

    # Process every returned audio/video item instead of assuming only data[0].
    for item in items:
        if not isinstance(item, dict):
            continue
        state = str(item.get("state") or item.get("status") or "").lower()
        if state in {"failed", "error", "failure", "generate_audio_failed", "create_task_failed"}:
            logger.error("Generation failed for task %s: %s", task_id, item)
            continue

        audio_url = item.get("audioUrl") or item.get("audio_url") or item.get("streamAudioUrl") or item.get("stream_audio_url")
        video_url = item.get("videoUrl") or item.get("video_url") or item.get("resultUrl") or item.get("result_url")
        audio_id = item.get("audioId") or item.get("audio_id") or item.get("id")
        image_url = item.get("imageUrl") or item.get("image_url") or item.get("image")
        title = item.get("title") or item.get("name") or "Untitled"

        if audio_url:
            try:
                # Fetch and save MP3 locally, but do not let this block lyric endpoint use.
                content, _ = await fetch_bytes(audio_url, timeout=180)
                mp3_path = MEDIA_DIR / f"{task_id}.mp3"
                mp3_path.write_bytes(content)
                local_audio_url = f"{BASE_URL}/media/{task_id}.mp3"
            except Exception as exc:
                logger.exception("Failed saving MP3 for task %s", task_id)
                local_audio_url = audio_url
                logger.warning("Will retain provider audio URL: %s", exc)

            lyrics_data = {}
            if audio_id:
                try:
                    lyrics_data = await kie_json(
                        "POST",
                        LYRICS_URL,
                        body={"taskId": task_id, "audioId": str(audio_id)},
                        timeout=60,
                    )
                except Exception as exc:
                    logger.warning("Lyrics not ready for task %s: %s", task_id, exc)

            video_task_id = None
            try:
                video_result = await kie_json(
                    "POST",
                    VIDEO_URL,
                    body={
                        "taskId": task_id,
                        "audioId": audio_id,
                        "callBackUrl": CALLBACK_URL,
                        "author": "Music Fattah AI",
                        "domainName": BASE_URL,
                    },
                    timeout=60,
                )
                if isinstance(video_result, dict):
                    result_data = video_result.get("data") or {}
                    if isinstance(result_data, dict):
                        video_task_id = result_data.get("taskId") or result_data.get("task_id")
            except Exception as exc:
                # Audio and lyrics should still be saved if video generation fails.
                logger.warning("MP4 generation could not start for task %s: %s", task_id, exc)

            if DATABASE_URL:
                conn = get_conn()
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            """
                            INSERT INTO songs
                                (task_id, title, audio_url, cover_url, lyrics, audio_id, video_task_id, status)
                            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                            ON CONFLICT (task_id) DO UPDATE SET
                                title=EXCLUDED.title,
                                audio_url=EXCLUDED.audio_url,
                                cover_url=EXCLUDED.cover_url,
                                lyrics=EXCLUDED.lyrics,
                                audio_id=EXCLUDED.audio_id,
                                video_task_id=COALESCE(EXCLUDED.video_task_id, songs.video_task_id),
                                status='audio_done'
                            """,
                            (
                                task_id,
                                title,
                                local_audio_url,
                                image_url,
                                json.dumps(lyrics_data, ensure_ascii=False),
                                str(audio_id) if audio_id is not None else None,
                                video_task_id,
                                "audio_done",
                            ),
                        )
                    conn.commit()
                except Exception:
                    conn.rollback()
                    logger.exception("Failed saving song row for task %s", task_id)
                finally:
                    conn.close()
            return {"status": "audio_saved", "taskId": task_id, "lyricsAvailable": bool(lyrics_data), "videoTaskId": video_task_id}

        if video_url:
            try:
                content, _ = await fetch_bytes(video_url, timeout=240)
                mp4_path = MEDIA_DIR / f"{task_id}.mp4"
                mp4_path.write_bytes(content)
                local_video_url = f"{BASE_URL}/media/{task_id}.mp4"
            except Exception as exc:
                logger.exception("Failed saving MP4 for task %s", task_id)
                local_video_url = video_url
                logger.warning("Retaining provider video URL: %s", exc)

            if DATABASE_URL:
                conn = get_conn()
                try:
                    with conn.cursor() as cur:
                        cur.execute(
                            "UPDATE songs SET video_url=%s, status='done' WHERE task_id=%s",
                            (local_video_url, task_id),
                        )
                    conn.commit()
                except Exception:
                    conn.rollback()
                    logger.exception("Failed updating video URL for task %s", task_id)
                finally:
                    conn.close()
            return {"status": "video_saved", "taskId": task_id}

    return {"status": "processing", "taskId": task_id}


# ==================================================
# DATABASE DIAGNOSTIC
# ==================================================
@app.get("/db-all")
def db_all():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM songs ORDER BY created_at DESC LIMIT 100")
            columns = [desc[0] for desc in cur.description]
            rows = cur.fetchall()
        return [dict(zip(columns, row)) for row in rows]
    finally:
        conn.close()
