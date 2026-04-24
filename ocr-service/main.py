# ocr-service/main.py
#
# FastAPI microservice for solar hardware datasheet parsing.
# Called by the Go backend at POST /api/sp/parse-datasheet; never reached
# directly by the browser — auth and SSRF validation live upstream in Go.
#
# Pipeline:
#   1. Download the PDF (httpx, 25 MB cap).
#   2. Extract text cheaply via pdfminer (works for digitally-authored PDFs).
#      If the result is too short (< 80 alnum chars) the PDF stores glyphs
#      without a Unicode map — fall back to OCR.
#   3. OCR fallback: pdf2image renders pages at 200 dpi, tesseract reads them.
#      This handles JA Solar, Longi, and other design-tool exports where the
#      font has no ToUnicode CMap table.
#   4. Send the extracted text to Gemini Flash Lite.  The LLM handles OCR
#      artifacts, multi-variant tables, mixed units, and varied label wording
#      far better than hand-written regexes at very low cost (~$0.001/call).
#      It returns a structured JSON array — one dict per product variant.
#
# WHY LLM instead of regex:
#   Manufacturer datasheets list 4–8 product variants in a single table, and
#   OCR often drops decimal points ("3212" → 32.12 V) or merges adjacent
#   columns.  Regex patterns tuned for one manufacturer break on another.
#   A small LLM reliably interprets the table regardless of layout.
#
# WHY text-first instead of sending the PDF/image to the LLM:
#   Image tokens (vision models) cost ~10–20× more than text tokens.
#   Running OCR locally is free; the LLM only ever sees plain text, keeping
#   each import call under $0.001.

import asyncio
import io
import json
import os
from typing import Optional

import httpx
from dotenv import load_dotenv

# Load .env from the service directory so local dev works without manually
# exporting GEMINI_API_KEY in the shell.  In Docker the env var is injected
# by compose; load_dotenv is a no-op when the var is already set.
load_dotenv()
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# ── Optional imports (graceful degradation) ───────────────────────────────────
try:
    from pdfminer.high_level import extract_text as _pdfminer_extract
    HAS_PDFMINER = True
except ImportError:
    HAS_PDFMINER = False

try:
    from pdf2image import convert_from_bytes
    HAS_PDF2IMAGE = True
except ImportError:
    HAS_PDF2IMAGE = False

# Prefer tesserocr (ships libtesseract via pip — no system binary required).
# Fall back to pytesseract (wraps the system tesseract CLI) if tesserocr is
# absent (e.g. in the Docker image where apt installs system tesseract).
try:
    import tesserocr
    HAS_TESSEROCR = True
except ImportError:
    HAS_TESSEROCR = False

try:
    import pytesseract
    HAS_PYTESSERACT = True
except ImportError:
    HAS_PYTESSERACT = False

HAS_OCR = HAS_PDF2IMAGE and (HAS_TESSEROCR or HAS_PYTESSERACT)

# ── Gemini client ─────────────────────────────────────────────────────────────
# Lazy init so the service starts even without a key (useful for local dev
# where you might test text extraction separately).  Fails at request time
# if GEMINI_API_KEY is not set.
#
# Model default is gemini-2.0-flash-lite.  Override via GEMINI_MODEL env var.
# On 503 UNAVAILABLE the request is retried via Groq (GROQ_MODEL).
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash-lite")
GROQ_MODEL   = os.environ.get("GROQ_MODEL",   "llama-3.3-70b-versatile")
_gemini_client = None
_groq_client   = None


def _get_gemini():
    global _gemini_client
    if _gemini_client is None:
        api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise HTTPException(500, "GEMINI_API_KEY env var not set")
        # Import lazily so the module loads even without the package installed
        # (the Dockerfile installs it, but local venvs might not have it yet).
        try:
            from google import genai
            _gemini_client = genai.Client(api_key=api_key)
        except ImportError:
            raise HTTPException(500, "google-genai package not installed")
    return _gemini_client


def _get_groq():
    global _groq_client
    if _groq_client is None:
        api_key = os.environ.get("GROQ_API_KEY", "")
        if not api_key:
            raise HTTPException(500, "GROQ_API_KEY env var not set — needed as Gemini fallback")
        try:
            from groq import Groq
            _groq_client = Groq(api_key=api_key)
        except ImportError:
            raise HTTPException(500, "groq package not installed")
    return _groq_client


app = FastAPI(title="solar-planner ocr-service", version="2.0")


# ── Request model ─────────────────────────────────────────────────────────────

class ParseRequest(BaseModel):
    url: str
    type: str   # "panel" | "inverter"


# ── Endpoint ──────────────────────────────────────────────────────────────────

@app.post("/parse")
async def parse_datasheet(req: ParseRequest):
    if req.type not in ("panel", "inverter"):
        raise HTTPException(400, "type must be 'panel' or 'inverter'")

    # Stream three-stage ndjson so the frontend can show a real progress bar.
    # Each line is valid JSON + \n:
    #   {"progress": "downloaded"}  — PDF fetched, starting OCR/text extraction
    #   {"progress": "extracted"}   — text ready, calling Gemini
    #   {"result": [...]}           — done; array of variant dicts
    #   {"error": "..."}            — something went wrong mid-stream
    #
    # We always return HTTP 200 once streaming starts (headers are already
    # committed by the first yield).  Validation errors caught before the
    # first yield still raise HTTPException with a 4xx status.
    async def generate():
        # Stage 1 — download PDF
        try:
            pdf_bytes = await download_pdf(req.url)
        except HTTPException as exc:
            yield json.dumps({"error": exc.detail}) + "\n"
            return
        yield json.dumps({"progress": "downloaded"}) + "\n"

        # Stage 2 — text extraction (CPU-bound; run in a thread so the
        # event loop stays responsive and the yield above flushes to client)
        try:
            text = await asyncio.to_thread(extract_text, pdf_bytes)
        except HTTPException as exc:
            yield json.dumps({"error": exc.detail}) + "\n"
            return
        if not text:
            yield json.dumps({"error": "no text could be extracted — PDF may be scanned or image-only"}) + "\n"
            return
        yield json.dumps({"progress": "extracted"}) + "\n"

        # Stage 3 — LLM extraction
        try:
            result = await asyncio.to_thread(llm_extract, text, req.type)
        except HTTPException as exc:
            yield json.dumps({"error": exc.detail}) + "\n"
            return
        yield json.dumps({"result": result}) + "\n"

    return StreamingResponse(generate(), media_type="application/x-ndjson")


# ── PDF download ──────────────────────────────────────────────────────────────

async def download_pdf(url: str) -> bytes:
    # 25 MB cap — generous for a datasheet, guards against abuse.
    headers = {"User-Agent": "solar-planner-ocr/2.0"}
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                resp.raise_for_status()
                chunks = []
                total = 0
                async for chunk in resp.aiter_bytes(65536):
                    total += len(chunk)
                    if total > 25 * 1024 * 1024:
                        raise HTTPException(413, "PDF exceeds 25 MB size limit")
                    chunks.append(chunk)
                return b"".join(chunks)
    except httpx.HTTPError as exc:
        raise HTTPException(502, f"download failed: {exc}")


# ── Text extraction ───────────────────────────────────────────────────────────

def extract_text(pdf_bytes: bytes) -> str:
    """
    Try pdfminer first (fast, no system deps).  If the result is shorter than
    80 meaningful characters — as happens with design-tool PDFs that store
    glyphs without a Unicode map — fall back to OCR.
    """
    if HAS_PDFMINER:
        try:
            text = _pdfminer_extract(io.BytesIO(pdf_bytes))
            # Count alphanumeric chars; pure whitespace / control chars mean
            # the font has no Unicode mapping so we need OCR.
            if sum(c.isalnum() for c in text) >= 80:
                return text
        except Exception:
            pass

    if HAS_OCR:
        return _ocr_extract(pdf_bytes)

    return ""


def _ocr_extract(pdf_bytes: bytes) -> str:
    """Render PDF pages to images at 200 dpi and run tesseract on each."""
    try:
        images = convert_from_bytes(pdf_bytes, dpi=200)
    except Exception as exc:
        raise HTTPException(422, f"could not render PDF pages: {exc}")

    # TESSDATA_PREFIX points tesserocr at the traineddata files.
    # In Docker (system tesseract via apt) the default path is correct.
    # For venv installs, set TESSDATA_PREFIX to the directory containing
    # eng.traineddata (download from github.com/tesseract-ocr/tessdata).
    tessdata = os.environ.get("TESSDATA_PREFIX", "")

    pages = []
    for img in images:
        try:
            text = _ocr_image(img, tessdata)
            if text:
                pages.append(text)
        except Exception:
            continue     # skip unreadable page; partial text beats nothing

    return "\n".join(pages)


def _ocr_image(img, tessdata: str) -> str:
    """Run OCR on a single PIL image, preferring tesserocr over pytesseract."""
    if HAS_TESSEROCR:
        # Empty string → system default path (correct in Docker with apt
        # tesseract).  None triggers the same default in newer tesserocr.
        with tesserocr.PyTessBaseAPI(path=tessdata or None, lang="eng") as api:
            api.SetImage(img)
            return api.GetUTF8Text()

    if HAS_PYTESSERACT:
        cfg = f"--tessdata-dir {tessdata}" if tessdata else ""
        return pytesseract.image_to_string(img, lang="eng", config=cfg)

    return ""


# ── LLM extraction ────────────────────────────────────────────────────────────
#
# The text from OCR / pdfminer is sent to Gemini Flash Lite with a prompt that
# asks for a JSON array of product variants.  Using `responseMimeType:
# application/json` in generationConfig constrains the model to emit valid JSON
# without any surrounding prose.
#
# WHY not use responseJsonSchema (strict schema enforcement)?
#   Schema enforcement is reliable for flat objects but Google's JSON schema
#   validator rejects top-level array types.  Wrapping in {"variants": [...]}
#   works but adds an extra nesting layer.  Since our prompt is explicit and
#   the model is consistent, plain JSON mode is simpler and equally reliable.

_PANEL_PROMPT = """\
You are extracting solar panel specifications from a datasheet.
The text below was extracted from a PDF (possibly via OCR and may contain artifacts).

Return ONLY a JSON array — no prose, no markdown.
Each element of the array represents one product variant found in the datasheet.
If the datasheet covers multiple power classes (e.g. 430 W, 435 W, 440 W), return one object per variant.
If only one variant is described, return a single-element array.

Fields for each object (omit if not found, never guess):
  manufacturer        (string)              — brand / manufacturer name (e.g. "JA Solar")
  model               (string)              — exact model designation (e.g. "JAM54D40-440/LB")
  wattPeak            (number, Wp)          — rated maximum power
  voc                 (number, V)           — open-circuit voltage
  isc                 (number, A)           — short-circuit current
  vmpp                (number, V)           — voltage at maximum power point
  impp                (number, A)           — current at maximum power point
  efficiencyPct       (number, %)           — module efficiency (e.g. 21.8, not 0.218)
  weightKg            (number, kg)          — module weight
  widthM              (number, metres)      — module width (convert mm → m if needed)
  heightM             (number, metres)      — module height (convert mm → m if needed)
  tempCoefficientPmax (number, %/°C)        — temperature coefficient of Pmax (typically negative, e.g. -0.29)

Rules:
- Omit a field entirely if you cannot find it — do not guess or invent values.
- Numeric fields must be numbers, never strings.
- manufacturer and model are strings; model should reflect the specific wattage variant
  (e.g. "JAM54D40-440/LB" for the 440 W variant, not the full series name).
- Dimensions: always in metres (a typical panel is 1.7 m × 1.1 m, NOT 1700 × 1100).
- Efficiency: percentage form (21.8, not 0.218).
- Temperature coefficient: keep the sign (usually negative).
- Shared fields (manufacturer, weight, dimensions, temp coefficient) should be repeated on every variant object.

DATASHEET TEXT:
{text}
"""

_INVERTER_PROMPT = """\
You are extracting solar inverter specifications from a datasheet.
The text below was extracted from a PDF (possibly via OCR and may contain artifacts).

Return ONLY a JSON array — no prose, no markdown.
Each element represents one inverter model/variant found in the datasheet.
If only one model is described, return a single-element array.

Fields for each object (omit if not found, never guess):
  manufacturer      (string)      — brand / manufacturer name (e.g. "SMA", "Fronius")
  model             (string)      — exact model designation (e.g. "Sunny Boy 5.0")
  maxAcPowerW       (number, W)   — rated AC output power (convert kW → W if needed)
  maxDcPowerW       (number, W)   — maximum DC input power (convert kW → W if needed)
  efficiencyPct     (number, %)   — peak/maximum efficiency (e.g. 97.6, not 0.976)
  maxInputVoltageV  (number, V)   — maximum DC input voltage
  phases            (integer)     — number of AC phases (1 or 3)
  maxStrings        (integer)     — total maximum number of PV input strings across all MPPTs
  mpptCount         (integer)     — number of independent MPPT trackers
  maxDcCurrentA     (number, A)   — maximum DC input current per string / per MPPT port
  stringsPerMppt    (integer)     — maximum number of strings per MPPT port

Rules:
- Numeric fields must be numbers, never strings.
- manufacturer and model are strings.
- Power in watts: 5 kW → 5000.
- Efficiency in percent: 97.6 %, not 0.976.

DATASHEET TEXT:
{text}
"""


def _call_gemini(prompt: str) -> str:
    """Call Gemini and return the raw response text (JSON mode)."""
    from google.genai import types as gtypes
    client = _get_gemini()
    resp = client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
        config=gtypes.GenerateContentConfig(
            response_mime_type="application/json",
        ),
    )
    return resp.text


def _call_groq(prompt: str) -> str:
    """Call Groq (llama-3.3-70b-versatile) and return the raw response text.

    Groq doesn't support response_format=json_object for all models, so we
    rely on the prompt instruction ("Return ONLY a JSON array") instead.
    """
    client = _get_groq()
    chat = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=[{"role": "user", "content": prompt}],
        # JSON mode IS supported for llama-3.3-70b-versatile on Groq.
        response_format={"type": "json_object"},
        temperature=0,
    )
    return chat.choices[0].message.content


def llm_extract(text: str, device_type: str) -> list:
    """
    Send extracted datasheet text to the LLM and parse the structured response.
    Returns a list of dicts, one per product variant.
    Falls back to Groq automatically when Gemini returns 503 UNAVAILABLE.
    """
    prompt_tpl = _PANEL_PROMPT if device_type == "panel" else _INVERTER_PROMPT
    prompt = prompt_tpl.format(text=text)

    try:
        raw = _call_gemini(prompt)
    except Exception as exc:
        # 503 UNAVAILABLE means Gemini is under high load — retry with Groq.
        if "503" in str(exc) or "UNAVAILABLE" in str(exc):
            try:
                raw = _call_groq(prompt)
            except Exception as exc2:
                raise HTTPException(502, f"LLM call failed (Gemini + Groq fallback): {exc2}")
        else:
            raise HTTPException(502, f"LLM call failed: {exc}")

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(502, f"LLM returned invalid JSON: {exc}")

    # The model should return a list directly; guard against it wrapping the
    # array in an object (e.g. {"variants": [...]}).
    if isinstance(parsed, dict):
        for key in ("variants", "panels", "inverters", "items", "results"):
            if isinstance(parsed.get(key), list):
                parsed = parsed[key]
                break

    if not isinstance(parsed, list):
        raise HTTPException(502, "LLM response was not a JSON array")

    # Sanitise: keep only dicts that have at least one numeric field we care about.
    # String fields (manufacturer, model) are kept as-is if they are non-empty strings.
    numeric_keys = {
        "wattPeak", "voc", "isc", "vmpp", "impp",
        "efficiencyPct", "weightKg", "widthM", "heightM", "tempCoefficientPmax",
        "maxAcPowerW", "maxDcPowerW", "maxInputVoltageV", "phases", "maxStrings",
        "mpptCount", "maxDcCurrentA", "stringsPerMppt",
    }
    string_keys = {"manufacturer", "model"}
    result = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        clean: dict = {}
        for k, v in item.items():
            if k in string_keys and isinstance(v, str) and v.strip():
                clean[k] = v.strip()
            elif k in numeric_keys and isinstance(v, (int, float)):
                clean[k] = v
        if any(k in clean for k in numeric_keys):
            result.append(clean)

    return result
