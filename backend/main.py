import os
import re
import sys
import uuid
import time
import asyncio
import subprocess
import httpx
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, File, Form, UploadFile, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import logging
import json
import datetime

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title="Hebrew Subtitle Generator", version="1.0.0")

_origins_env = os.getenv("ALLOWED_ORIGINS", "*")
ALLOWED_ORIGINS = [o.strip() for o in _origins_env.split(",")] if _origins_env != "*" else ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"null|file://.*|http://localhost(:\d+)?",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_FILE_SIZE_MB    = int(os.getenv("MAX_FILE_SIZE_MB", "500"))
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "10"))
RATE_LIMIT_WINDOW   = int(os.getenv("RATE_LIMIT_WINDOW",   "60"))
FILE_TTL_SECONDS    = int(os.getenv("FILE_TTL_SECONDS", str(60 * 60 * 2)))

_rate_store: dict = defaultdict(list)

def check_rate_limit(ip: str):
    now = time.time()
    reqs = [t for t in _rate_store[ip] if t > now - RATE_LIMIT_WINDOW]
    if len(reqs) >= RATE_LIMIT_REQUESTS:
        raise HTTPException(429, f"יותר מדי בקשות. אנא המתן {RATE_LIMIT_WINDOW} שניות.")
    reqs.append(now)
    _rate_store[ip] = reqs

def cleanup_old_files():
    now = time.time()
    for f in UPLOAD_DIR.iterdir():
        try:
            if now - f.stat().st_mtime > FILE_TTL_SECONDS:
                f.unlink(missing_ok=True)
        except Exception:
            pass

print("Subit backend ready ✓")

# ── Structured API call logger ─────────────────────────────────────────────────
LOG_FILE = Path("logs/api_calls.jsonl")
LOG_FILE.parent.mkdir(exist_ok=True)

# Configure a simple file logger for API errors
_api_logger = logging.getLogger("subit.api")
_api_logger.setLevel(logging.INFO)
_fh = logging.FileHandler(LOG_FILE.parent / "errors.log", encoding="utf-8")
_fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
_api_logger.addHandler(_fh)
# Also log to stdout (visible in Render logs)
_sh = logging.StreamHandler()
_sh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
_api_logger.addHandler(_sh)

def api_log(
    service: str,          # "whisper" | "gpt"
    status: str,           # "ok" | "error" | "retry"
    ip: str = "-",
    filename: str = "-",
    duration_s: float = 0.0,
    error: str = "",
    extra: dict | None = None,
):
    """Append one JSONL line to logs/api_calls.jsonl and log errors to errors.log."""
    entry = {
        "ts": datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "service": service,
        "status": status,
        "ip": ip,
        "file": filename,
        "duration_s": round(duration_s, 2),
        "error": error,
        **(extra or {}),
    }
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        _api_logger.warning(f"Could not write to {LOG_FILE}: {e}")
    if status == "error":
        _api_logger.error(
            f"[{service.upper()}] {status} | ip={ip} file={filename} "
            f"dur={duration_s:.1f}s | {error[:200]}"
        )
    elif status in ("ok", "retry"):
        _api_logger.info(
            f"[{service.upper()}] {status} | ip={ip} file={filename} dur={duration_s:.1f}s"
        )

# ── Helpers ───────────────────────────────────────────────────────────────────
def seconds_to_srt_time(s: float) -> str:
    h  = int(s // 3600)
    m  = int((s % 3600) // 60)
    sc = int(s % 60)
    ms = int((s - int(s)) * 1000)
    return f"{h:02d}:{m:02d}:{sc:02d},{ms:03d}"

def srt_to_seconds(ts: str) -> float:
    try:
        h, m, rest = ts.split(":")
        s, ms = rest.replace(",", ".").split(".")
        return int(h)*3600 + int(m)*60 + int(s) + int(ms)/1000
    except Exception:
        return 0.0

def segments_to_srt(segments):
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(f"{i}\n{seconds_to_srt_time(seg['start'])} --> {seconds_to_srt_time(seg['end'])}\n{seg['text'].strip()}\n")
    return "\n".join(lines)

def cleanup_files(*paths):
    for p in paths:
        try:
            Path(p).unlink(missing_ok=True)
        except Exception:
            pass

# ── Smart split ───────────────────────────────────────────────────────────────
def smart_split_text(text: str, max_words: int):
    words = text.split()
    if len(words) <= max_words:
        return [text]
    chunks = []
    current = []
    BREAK = set(".,!?:;—–")
    MIN   = max(max_words // 2, 2)
    for word in words:
        current.append(word)
        at_limit  = len(current) >= max_words
        good_break = (word.rstrip()[-1] if word.rstrip() else "") in BREAK and len(current) >= MIN
        if good_break or at_limit:
            chunks.append(" ".join(current))
            current = []
    if current:
        if chunks and len(current) <= 2:
            chunks[-1] += " " + " ".join(current)
        else:
            chunks.append(" ".join(current))
    return chunks

def split_long_segments(segments, max_words):
    if not max_words or max_words <= 0:
        return segments
    result = []
    new_index = 1
    for seg in segments:
        words = seg["text"].split()
        if len(words) <= max_words:
            result.append({**seg, "index": new_index})
            new_index += 1
        else:
            start_s = srt_to_seconds(seg["start"])
            end_s   = srt_to_seconds(seg["end"])
            dur     = max(end_s - start_s, 0.1)
            chunks  = smart_split_text(seg["text"], max_words)
            total_w = sum(len(c.split()) for c in chunks)
            t = start_s
            for chunk in chunks:
                w_frac    = len(chunk.split()) / max(total_w, 1)
                chunk_dur = dur * w_frac
                result.append({
                    "index": new_index,
                    "start": seconds_to_srt_time(t),
                    "end":   seconds_to_srt_time(t + chunk_dur),
                    "text":  chunk,
                })
                t += chunk_dur
                new_index += 1
    return result

# ── Pydantic models ───────────────────────────────────────────────────────────
class SRTLine(BaseModel):
    index: int
    start: str
    end:   str
    text:  str

class BurnRequest(BaseModel):
    video_id:      str
    srt_lines:     list[SRTLine]
    font_name:     str = "Arial"
    font_size:     int = 24
    font_color:    str = "white"
    outline_color: str = "black"
    position:      str = "bottom"
    font_style:    str = "normal"
    bg_opacity:    int = 0

# ── OpenAI GPT helper ────────────────────────────────────────────────────────
async def call_openai(
    prompt: str,
    system: str = "",
    temperature: float = 0.1,
    timeout: int = 120,
    _log_ip: str = "-",
    _log_file: str = "-",
    _log_op: str = "gpt",          # label shown in logs (e.g. "ai-fix", "align")
) -> str:
    api_key = os.getenv("OPENAI_API_KEY", "")
    if not api_key:
        raise HTTPException(500, "OPENAI_API_KEY לא מוגדר בשרת")
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    retry_delays = [10, 20, 40]
    t0 = time.time()
    for attempt in range(3):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}",
                             "Content-Type": "application/json"},
                    json={"model": "gpt-5.4-mini",
                          "messages": messages,
                          "temperature": temperature,
                          "max_completion_tokens": 8192},
                )
        except Exception as exc:
            dur = time.time() - t0
            api_log("gpt", "error", _log_ip, _log_file, dur,
                    f"network error (attempt {attempt+1}): {exc}", {"op": _log_op})
            if attempt < 2:
                await asyncio.sleep(retry_delays[attempt])
                continue
            raise HTTPException(500, f"שגיאת רשת בקריאה ל-GPT: {exc}")

        if resp.status_code in (429, 503):
            dur = time.time() - t0
            api_log("gpt", "retry", _log_ip, _log_file, dur,
                    f"rate-limited {resp.status_code} (attempt {attempt+1})", {"op": _log_op})
            if attempt < 2:
                await asyncio.sleep(retry_delays[attempt])
                continue
            api_log("gpt", "error", _log_ip, _log_file, time.time()-t0,
                    f"rate-limited after 3 attempts: {resp.status_code}", {"op": _log_op})
            raise HTTPException(429, "שירות ה-AI עמוס כרגע — אנא המתן מספר שניות ונסה שוב")

        if resp.status_code != 200:
            dur = time.time() - t0
            err_body = resp.text[:500]
            api_log("gpt", "error", _log_ip, _log_file, dur,
                    f"HTTP {resp.status_code}: {err_body}", {"op": _log_op})
            print(f"OpenAI error {resp.status_code}: {err_body}")
            raise HTTPException(500, f"שגיאת OpenAI API: {resp.text[:300]}")

        data = resp.json()
        try:
            result = data["choices"][0]["message"]["content"]
            dur = time.time() - t0
            api_log("gpt", "ok", _log_ip, _log_file, dur, extra={
                "op": _log_op,
                "prompt_tokens": data.get("usage", {}).get("prompt_tokens"),
                "completion_tokens": data.get("usage", {}).get("completion_tokens"),
            })
            return result
        except (KeyError, IndexError):
            dur = time.time() - t0
            api_log("gpt", "error", _log_ip, _log_file, dur,
                    f"unexpected response shape: {str(data)[:200]}", {"op": _log_op})
            raise HTTPException(500, f"תשובה לא צפויה מ-OpenAI: {str(data)[:200]}")

def parse_numbered_lines(result_text: str, segments: list) -> list:
    fixed = [dict(s) for s in segments]
    for line in result_text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        dot = line.find(".")
        if dot == -1:
            continue
        try:
            idx  = int(line[:dot].strip())
            text = line[dot+1:].strip()
            for seg in fixed:
                if seg["index"] == idx:
                    seg["text"] = text
                    break
        except ValueError:
            continue
    return fixed

# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_SIZE}

@app.post("/transcribe")
async def transcribe(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    initial_prompt: str = Form(""),
    max_words_per_line: int = Form(0),
):
    client_ip = request.client.host if request.client else "unknown"
    check_rate_limit(client_ip)
    cleanup_old_files()

    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_FILE_SIZE_BYTES + 1024*1024:
        raise HTTPException(413, f"הקובץ גדול מדי. מקסימום {MAX_FILE_SIZE_MB}MB.")

    allowed_ext = {".mp4",".mov",".avi",".mkv",".webm",".mp3",".wav",".m4a",".ogg"}
    suffix = Path(file.filename).suffix.lower()
    if suffix not in allowed_ext:
        raise HTTPException(400, f"סוג קובץ לא נתמך: {suffix}")

    video_id   = str(uuid.uuid4())
    input_path = UPLOAD_DIR / f"{video_id}{suffix}"

    content = await file.read()
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(413, f"הקובץ גדול מדי. מקסימום {MAX_FILE_SIZE_MB}MB.")

    with open(input_path, "wb") as f:
        f.write(content)

    t_whisper = time.time()
    try:
        api_key = os.getenv("OPENAI_API_KEY", "")
        if not api_key:
            raise HTTPException(500, "OPENAI_API_KEY לא מוגדר בשרת")

        # Compress to MP3 if file > 24MB (Whisper API limit is 25MB)
        send_path = input_path
        compressed_path = None
        file_size_mb = round(input_path.stat().st_size / 1024 / 1024, 2)
        if input_path.stat().st_size > 24 * 1024 * 1024:
            compressed_path = UPLOAD_DIR / f"{video_id}_compressed.mp3"
            compress_cmd = [
                "ffmpeg", "-y", "-i", str(input_path),
                "-vn", "-ar", "16000", "-ac", "1", "-b:a", "32k",
                str(compressed_path)
            ]
            comp_result = subprocess.run(compress_cmd, capture_output=True, timeout=120)
            if comp_result.returncode == 0:
                send_path = compressed_path
            # If compression fails, try with original

        async with httpx.AsyncClient(timeout=300) as client:
            with open(send_path, "rb") as audio_file:
                form_data = {
                    "model": (None, "whisper-1"),
                    "language": (None, "he"),
                    "response_format": (None, "verbose_json"),
                }
                if initial_prompt:
                    form_data["prompt"] = (None, initial_prompt)
                resp = await client.post(
                    "https://api.openai.com/v1/audio/transcriptions",
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={**form_data, "file": (send_path.name, audio_file, "audio/mpeg")},
                )
        if compressed_path:
            cleanup_files(compressed_path)

        if resp.status_code != 200:
            dur = time.time() - t_whisper
            api_log("whisper", "error", client_ip, file.filename, dur,
                    f"HTTP {resp.status_code}: {resp.text[:400]}",
                    {"size_mb": file_size_mb})
            raise HTTPException(500, f"שגיאת Whisper API: {resp.text[:300]}")
        result = resp.json()
        dur = time.time() - t_whisper
        api_log("whisper", "ok", client_ip, file.filename, dur, extra={
            "size_mb": file_size_mb,
            "segments": len(result.get("segments", [])),
            "has_prompt": bool(initial_prompt),
        })
    except HTTPException:
        raise
    except Exception as e:
        dur = time.time() - t_whisper
        api_log("whisper", "error", client_ip, file.filename, dur, str(e),
                {"size_mb": getattr(input_path.stat(), "st_size", 0) / 1024 / 1024})
        cleanup_files(input_path)
        raise HTTPException(500, f"שגיאת תמלול: {str(e)}")

    raw_segs = result.get("segments", [])
    structured = [
        {"index": i+1, "start": seconds_to_srt_time(seg["start"]),
         "end": seconds_to_srt_time(seg["end"]), "text": seg["text"].strip()}
        for i, seg in enumerate(raw_segs)
    ]

    if max_words_per_line > 0:
        structured = split_long_segments(structured, max_words_per_line)

    segments    = structured
    srt_content = "\n".join(f"{s['index']}\n{s['start']} --> {s['end']}\n{s['text']}\n" for s in segments)
    plain_text  = " ".join(s["text"] for s in segments)

    srt_path = UPLOAD_DIR / f"{video_id}.srt"
    srt_path.write_text(srt_content, encoding="utf-8")

    return JSONResponse({
        "video_id":   video_id,
        "filename":   file.filename,
        "srt":        srt_content,
        "segments":   segments,
        "plain_text": plain_text,
        "language":   result.get("language", "he"),
    })

@app.get("/download/srt/{video_id}")
def download_srt(video_id: str):
    srt_path = UPLOAD_DIR / f"{video_id}.srt"
    if not srt_path.exists():
        raise HTTPException(404, "SRT file not found")
    return FileResponse(srt_path, media_type="text/plain", filename="subtitles_he.srt")

@app.post("/burn")
async def burn_subtitles(req: BurnRequest, background_tasks: BackgroundTasks):
    video_files = [f for f in UPLOAD_DIR.glob(f"{req.video_id}.*")
                   if f.suffix not in (".srt", ".ass")]
    if not video_files:
        raise HTTPException(404, "קובץ הוידאו המקורי לא נמצא. אנא העלה מחדש.")

    input_video = video_files[0]
    output_path = UPLOAD_DIR / f"{req.video_id}_burned.mp4"

    # ── Color maps (ASS &HAABBGGRR format) ──
    color_hex = {
        "white":  "&H00FFFFFF", "yellow": "&H0000FFFF",
        "black":  "&H00000000", "cyan":   "&H00FFFF00",
        "lime":   "&H0088FF00", "orange": "&H000099FF",
        "red":    "&H000000FF", "pink":   "&H00CC88FF",
    }
    outline_hex = {
        "black": "&H00000000", "white": "&H00FFFFFF",
        "none":  "&H00000000", "dark-shadow": "&H00000000",
    }

    primary    = color_hex.get(req.font_color, "&H00FFFFFF")
    outline_c  = outline_hex.get(req.outline_color, "&H00000000")
    outline_sz = 0 if req.outline_color in ("none","dark-shadow") else 2
    shadow_sz  = 3 if req.outline_color == "dark-shadow" else 0
    bold_n     = 1 if "bold"   in req.font_style else 0
    italic_n   = 1 if "italic" in req.font_style else 0
    bg_a       = hex(int(req.bg_opacity / 100 * 255)).upper()[2:].zfill(2) if req.bg_opacity > 0 else "00"
    back_c     = f"&H{bg_a}000000"
    b_style    = 3 if req.bg_opacity > 0 else 1

    align_map  = {"very-bottom":2,"bottom":2,"center-bottom":2,"center":5,"center-top":8,"top":8,"very-top":8}
    margin_map = {"very-bottom":8,"bottom":25,"center-bottom":80,"center":0,"center-top":80,"top":25,"very-top":8}
    alignment  = align_map.get(req.position, 2)
    margin_v   = margin_map.get(req.position, 25)

    # Write SRT
    burn_srt = UPLOAD_DIR / f"{req.video_id}_burn.srt"
    burn_srt.write_text(
        "\n".join(f"{i+1}\n{l.start} --> {l.end}\n{l.text}\n" for i,l in enumerate(req.srt_lines)),
        encoding="utf-8"
    )

    # Escape SRT path for FFmpeg
    srt_str = str(burn_srt).replace("\\", "/")
    if sys.platform == "win32":
        srt_str = re.sub(r"^([A-Za-z]):/", lambda m: m.group(1) + "\\:/", srt_str)

    force_style = (
        f"FontName={req.font_name},FontSize={req.font_size},"
        f"Bold={bold_n},Italic={italic_n},"
        f"PrimaryColour={primary},OutlineColour={outline_c},"
        f"BackColour={back_c},Outline={outline_sz},Shadow={shadow_sz},"
        f"BorderStyle={b_style},Alignment={alignment},MarginV={margin_v}"
    )
    subtitle_filter = f"subtitles='{srt_str}':force_style='{force_style}'"

    cmd = [
        "ffmpeg", "-y",
        "-i", str(input_video),
        "-vf", subtitle_filter,
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "copy",
        str(output_path),
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise HTTPException(500, f"FFmpeg error: {result.stderr[-600:]}")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "FFmpeg timed out")
    finally:
        cleanup_files(burn_srt)

    if not output_path.exists():
        raise HTTPException(500, "Output file not created")

    background_tasks.add_task(cleanup_files, output_path)
    return FileResponse(output_path, media_type="video/mp4",
                        filename=f"subtitled_{input_video.name}")

@app.post("/save-srt")
async def save_edited_srt(data: dict):
    video_id = data.get("video_id")
    segments = data.get("segments", [])
    if not video_id:
        raise HTTPException(400, "video_id required")
    srt_content = "\n".join(
        f"{seg['index']}\n{seg['start']} --> {seg['end']}\n{seg['text']}\n"
        for seg in segments
    )
    (UPLOAD_DIR / f"{video_id}.srt").write_text(srt_content, encoding="utf-8")
    return {"status": "saved"}

@app.post("/align-with-transcript")
async def align_with_transcript(data: dict, request: Request):
    segments   = data.get("segments", [])
    transcript = data.get("transcript", "").strip()
    video_id   = data.get("video_id", "-")
    client_ip  = request.client.host if request.client else "unknown"

    if not transcript:
        raise HTTPException(400, "לא סופק טקסט מקורי")
    if not segments:
        raise HTTPException(400, "לא סופקו כתוביות")

    n = len(segments)

    # Build segment list with word-count hints to guide proportional splitting
    seg_lines = []
    for s in segments:
        wc = len(s["text"].split())
        seg_lines.append(f"{s['index']}. [{wc} מילים] {s['text']}")
    seg_text = "\n".join(seg_lines)

    system = (
        "אתה מומחה עריכת כתוביות בעברית.\n"
        f"קיבלת טקסט מדויק של סרטון ורשימה של {n} כתוביות שנוצרו מתמלול אוטומטי.\n"
        "החלוקה לזמנים נכונה — רק הטקסט שגוי.\n\n"
        "המשימה:\n"
        f"חלק את הטקסט המדויק בין בדיוק {n} כתוביות, בסדר כרונולוגי.\n\n"
        "כללים:\n"
        "1. אל תוסיף ואל תגרע אף מילה מהטקסט המדויק.\n"
        "2. שמור על פרופורציה: כתוביות עם יותר מילים מקוריות (מסומן [X מילים]) מקבלות יחסית יותר מילים.\n"
        "3. חתוך תמיד בגבול מילה שלמה — לעולם לא באמצע מילה.\n"
        "4. העדף חיתוך לאחר סימן פיסוק (פסיק, נקודה, שאלה) כשאפשר.\n"
        "5. כל כתובית חייבת לקבל לפחות מילה אחת.\n"
        "6. כתוב את כל מילות הטקסט המדויק — אל תדלג על שום מילה, כולל המשפט האחרון.\n\n"
        "החזר אך ורק את הרשימה הממוספרת בפורמט:\n"
        "1. טקסט הכתובית\n"
        "2. טקסט הכתובית\n"
        "... ללא הסברים, ללא כותרות, ללא סוגריים."
    )
    prompt = (
        f"טקסט מדויק:\n{transcript}\n\n"
        f"כתוביות מקוריות (כולל ספירת מילים לכל אחת):\n{seg_text}"
    )
    result_text = await call_openai(
        prompt, system=system, temperature=0.05,
        _log_ip=client_ip, _log_file=video_id, _log_op="align"
    )
    return {"segments": parse_numbered_lines(result_text, segments)}

@app.post("/ai-fix")
async def ai_fix_text(data: dict, request: Request):
    segments  = data.get("segments", [])
    video_id  = data.get("video_id", "-")
    client_ip = request.client.host if request.client else "unknown"
    lines = "\n".join(f"{s['index']}. {s['text']}" for s in segments)
    system = (
        "אתה עורך תמלולים בעברית.\n"
        "הכתוביות נוצרו על ידי זיהוי קול — החלוקה לקטעים נכונה, אבל המילים לפעמים שגויות פונטית.\n"
        "תקן כל מילה שנשמעת דומה לנאמר אך אינה הגיונית בהקשר המשפט.\n"
        "נחש לפי הקשר גם כשאינך בטוח — עדיף תיקון אגרסיבי על פני השארת שגיאה.\n"
        "החזר את אותה רשימה ממוספרת בדיוק, שורה לשורה, ללא הסברים."
    )
    prompt = f"כתוביות לתיקון:\n{lines}"
    result_text = await call_openai(
        prompt, system=system, temperature=0.3,
        _log_ip=client_ip, _log_file=video_id, _log_op="ai-fix"
    )
    return {"segments": parse_numbered_lines(result_text, segments)}

# ── Logs viewer endpoint ──────────────────────────────────────────────────────
@app.get("/admin/logs")
async def view_logs(
    request: Request,
    service: str = "",
    status: str = "",
    last_n: int = 100,
):
    """
    Read the last N log entries from logs/api_calls.jsonl.
    Optional filters: ?service=whisper|gpt  &status=error|ok|retry
    Protect with ADMIN_TOKEN env var: add ?token=... to request.
    """
    admin_token = os.getenv("ADMIN_TOKEN", "")
    if admin_token:
        provided = request.query_params.get("token", "")
        if provided != admin_token:
            raise HTTPException(403, "Forbidden")

    if not LOG_FILE.exists():
        return JSONResponse({"entries": [], "total": 0, "filtered": 0})

    entries = []
    with open(LOG_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except Exception:
                pass

    total = len(entries)
    if service:
        entries = [e for e in entries if e.get("service") == service]
    if status:
        entries = [e for e in entries if e.get("status") == status]

    return JSONResponse({
        "total": total,
        "filtered": len(entries),
        "entries": entries[-last_n:],
    })
