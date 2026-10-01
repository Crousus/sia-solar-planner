# ocr-service/main.py
#
# FastAPI microservice for solar hardware datasheet parsing.
# Called by the Go backend at POST /api/sp/parse-datasheet; never reached
# directly by the browser — auth lives upstream in Go.
#
# SSRF: Go performs a first, string-level URL check, but this service is the
# one that actually opens the outbound connection, so it re-validates as
# defence in depth: it resolves the host itself, rejects any non-public
# address, PINS the TCP connection to the address it validated (no DNS
# rebinding window), and follows redirects manually, re-validating every hop.
# See `validate_public_url` / `download_pdf`.
#
# Resource limits (all env-overridable, see the constants below): download
# size + wall-clock deadline, pdfminer page cap, OCR page cap with bounded
# render size, LLM input truncation, and a concurrency semaphore around the
# whole pipeline so a burst of imports can't exhaust CPU/RAM.
#
# Errors: clients only ever see short generic messages; details (httpx
# exceptions, pdftoppm stderr, LLM SDK errors) go to the server log, because
# they can reveal internal hostnames, paths, or API-key configuration.
#
# Pipeline:
#   1. Download the PDF (httpx, size-capped, deadline-bounded).
#   2. Extract text cheaply via pdfminer (works for digitally-authored PDFs).
#      If the result is too short (< 80 alnum chars) the PDF stores glyphs
#      without a Unicode map — fall back to OCR.
#   3. OCR fallback: pdf2image renders the first few pages (bounded pixel
#      size, one page at a time), tesseract reads them.
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
import ipaddress
import json
import logging
import math
import os
import socket
import tempfile
import threading
from typing import Optional
from urllib.parse import urljoin, urlsplit

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
    from pdf2image import convert_from_path, pdfinfo_from_path
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

log = logging.getLogger("ocr-service")
logging.basicConfig(level=logging.INFO)


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except ValueError:
        return default


# ── Resource limits ───────────────────────────────────────────────────────────
# WHY each one exists:
#   MAX_PDF_BYTES        — memory: the whole PDF is held in RAM (and later
#                          written to a temp file for pdftoppm).
#   DOWNLOAD_DEADLINE_S  — httpx timeouts are per-operation (connect / each
#                          read), so a server trickling 1 byte every 29 s
#                          would never time out. This caps the total.
#   MAX_REDIRECTS        — redirect loops / long chains.
#   MAX_TEXT_PAGES       — pdfminer CPU on huge documents (datasheets are
#                          1–4 pages; nothing useful lives on page 50).
#   MAX_OCR_PAGES        — each OCR'd page is a full raster + tesseract run.
#   OCR_MAX_SIDE_PX      — rasters are rendered with the LONGEST side scaled
#                          to this many pixels instead of a fixed dpi, so a
#                          maliciously huge MediaBox (e.g. 200 × 200 inch)
#                          can't produce a multi-GB bitmap. 2400 px ≈ 200 dpi
#                          on A4, which is what OCR quality was tuned for.
#   OCR_PAGE_TIMEOUT_S   — pdftoppm subprocess timeout per page.
#   MAX_LLM_CHARS        — LLM cost/latency; a real datasheet is 5–15 k chars.
#   MAX_CONCURRENCY      — CPU/RAM: heavy pipelines running at once.
MAX_PDF_BYTES       = _env_int("OCR_MAX_PDF_BYTES", 25 * 1024 * 1024)
DOWNLOAD_DEADLINE_S = _env_int("OCR_DOWNLOAD_DEADLINE_S", 45)
MAX_REDIRECTS       = 5
MAX_URL_LEN         = 2048
MAX_TEXT_PAGES      = _env_int("OCR_MAX_TEXT_PAGES", 20)
MAX_OCR_PAGES       = _env_int("OCR_MAX_OCR_PAGES", 4)
OCR_MAX_SIDE_PX     = _env_int("OCR_MAX_SIDE_PX", 2400)
OCR_PAGE_TIMEOUT_S  = _env_int("OCR_PAGE_TIMEOUT_S", 60)
MAX_LLM_CHARS       = _env_int("OCR_MAX_LLM_CHARS", 30_000)
MAX_CONCURRENCY     = _env_int("OCR_MAX_CONCURRENCY", 2)
MAX_VARIANTS        = 50
MAX_STRING_FIELD_LEN = 200
# How long a request waits for a free pipeline slot before giving up. Must
# stay well below the Go proxy's 120 s client timeout.
SLOT_WAIT_S         = 20

# Ports a datasheet host may use. Public CDNs/vendor sites use 80/443;
# allowing arbitrary ports would let a caller probe services on public IPs
# from our egress address (and odd ports have no legitimate use here).
ALLOWED_PORTS = {80, 443, 8080, 8443}

# Hostname suffixes that are never public DNS names. Single-label names
# ("backend", "pdf-service", "localhost") are rejected separately — those
# are exactly what Docker's embedded DNS resolves to internal containers.
BLOCKED_HOST_SUFFIXES = (
    ".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain",
)

_pipeline_sem: Optional[asyncio.Semaphore] = None


def _get_sem() -> asyncio.Semaphore:
    # Created lazily so it binds to uvicorn's running event loop.
    global _pipeline_sem
    if _pipeline_sem is None:
        _pipeline_sem = asyncio.Semaphore(MAX_CONCURRENCY)
    return _pipeline_sem

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
            log.error("GEMINI_API_KEY env var not set")
            raise HTTPException(500, "LLM not configured")
        # Import lazily so the module loads even without the package installed
        # (the Dockerfile installs it, but local venvs might not have it yet).
        try:
            from google import genai
            _gemini_client = genai.Client(api_key=api_key)
        except ImportError:
            log.error("google-genai package not installed")
            raise HTTPException(500, "LLM not configured")
    return _gemini_client


def _get_groq():
    global _groq_client
    if _groq_client is None:
        api_key = os.environ.get("GROQ_API_KEY", "")
        if not api_key:
            log.error("GROQ_API_KEY env var not set — needed as Gemini fallback")
            raise HTTPException(500, "LLM not configured")
        try:
            from groq import Groq
            _groq_client = Groq(api_key=api_key)
        except ImportError:
            log.error("groq package not installed")
            raise HTTPException(500, "LLM not configured")
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
    if len(req.url) > MAX_URL_LEN:
        raise HTTPException(400, "URL too long")

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
    #
    # Every {"error"} message is one WE wrote (HTTPException details below
    # are generic by construction); unexpected exceptions are logged and
    # surface only as "internal error".
    async def generate():
        # Bound concurrent pipelines (download buffer + extraction + LLM).
        # Waiting is capped so a request doesn't sit silently until the Go
        # proxy's 120 s timeout fires.
        sem = _get_sem()
        try:
            await asyncio.wait_for(sem.acquire(), timeout=SLOT_WAIT_S)
        except asyncio.TimeoutError:
            yield json.dumps({"error": "service busy, please try again shortly"}) + "\n"
            return
        try:
            # Stage 1 — download PDF
            try:
                pdf_bytes = await download_pdf(req.url)
            except HTTPException as exc:
                yield json.dumps({"error": exc.detail}) + "\n"
                return
            yield json.dumps({"progress": "downloaded"}) + "\n"

            # Stage 2 — text extraction (CPU-bound; run in a thread so the
            # event loop stays responsive and the yield above flushes to
            # client). `_bounded` additionally caps CPU work with a THREAD
            # semaphore: if the client disconnects, this generator is
            # cancelled and releases the asyncio slot, but the worker thread
            # can't be killed — the thread-level semaphore keeps such
            # orphans counted against the limit until they really finish.
            try:
                text = await asyncio.to_thread(_bounded, extract_text, pdf_bytes)
            except HTTPException as exc:
                yield json.dumps({"error": exc.detail}) + "\n"
                return
            del pdf_bytes  # free the download buffer before the LLM round-trip
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
        except Exception:
            # GeneratorExit / CancelledError are BaseException and pass
            # through untouched (client went away); anything else is a bug.
            log.exception("datasheet pipeline failed unexpectedly")
            yield json.dumps({"error": "internal error"}) + "\n"
        finally:
            sem.release()

    return StreamingResponse(generate(), media_type="application/x-ndjson")


_cpu_sem = threading.BoundedSemaphore(MAX_CONCURRENCY)


def _bounded(fn, *args):
    with _cpu_sem:
        return fn(*args)


# ── SSRF guard ────────────────────────────────────────────────────────────────
#
# The Go gate only does string matching on the URL (no DNS), so a public
# hostname that resolves to 10.x / 169.254.169.254 / a Docker service, or a
# public URL that 302-redirects to one, would sail through. We therefore:
#   1. syntactically validate the URL (scheme, no userinfo, allowed port,
#      no single-label / internal-suffix hostnames),
#   2. resolve the hostname ourselves and require EVERY returned address to
#      be globally routable (mixed public/private answers are rejected —
#      otherwise an attacker could race which one gets used),
#   3. connect to the exact IP we validated (Host header + TLS SNI carry the
#      original name, so virtual hosting and certificate verification still
#      work) — this closes the DNS-rebinding window between check and use,
#   4. follow redirects manually, repeating 1–3 for every hop.

# Networks never acceptable as a fetch target, listed explicitly even where
# `ip.is_global` would already catch them, so the policy is readable and
# survives stdlib classification changes between Python versions.
_BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8",          # "this network" / unspecified
    "10.0.0.0/8",         # RFC 1918
    "100.64.0.0/10",      # CGNAT shared address space (RFC 6598)
    "127.0.0.0/8",        # loopback
    "169.254.0.0/16",     # link-local — includes cloud metadata 169.254.169.254
    "172.16.0.0/12",      # RFC 1918 — includes Docker's default bridge ranges
    "192.0.0.0/24",       # IETF protocol assignments
    "192.168.0.0/16",     # RFC 1918
    "198.18.0.0/15",      # benchmarking
    "224.0.0.0/4",        # multicast
    "240.0.0.0/4",        # reserved + broadcast
    "::/128", "::1/128",  # unspecified / loopback
    "fc00::/7",           # unique local (ULA)
    "fe80::/10",          # link-local
    "ff00::/8",           # multicast
)]
_NAT64 = ipaddress.ip_network("64:ff9b::/96")


def is_public_ip(ip: "ipaddress.IPv4Address | ipaddress.IPv6Address") -> bool:
    """True only for globally routable unicast addresses."""
    if isinstance(ip, ipaddress.IPv6Address):
        # Addresses that embed an IPv4 address are judged by that address,
        # otherwise ::ffff:127.0.0.1 or 2002:7f00:1:: would bypass the
        # IPv4 rules on dual-stack hosts.
        if ip.ipv4_mapped is not None:
            return is_public_ip(ip.ipv4_mapped)
        if ip.sixtofour is not None:
            return is_public_ip(ip.sixtofour)
        if ip in _NAT64:
            return is_public_ip(ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF))
        if ip.teredo is not None:
            return False  # tunnelling endpoint; no legitimate datasheet host
    if any(ip in net for net in _BLOCKED_NETS):
        return False
    return bool(ip.is_global) and not (
        ip.is_multicast or ip.is_reserved or ip.is_unspecified
        or ip.is_loopback or ip.is_link_local or ip.is_private
    )


class _Target:
    """A validated fetch target, pinned to its resolved (all-public) IPs."""

    def __init__(self, scheme: str, hostname: str, port: int, explicit_port: bool,
                 ips: list, path_query: str):
        self.scheme = scheme
        self.hostname = hostname
        self.port = port
        # IPv4 first: Docker networks are IPv4-only by default, so dialling
        # an AAAA record first would fail for most deployments. Other
        # addresses remain as fallbacks on connect errors.
        self.ips = sorted(dict.fromkeys(ips), key=lambda a: ":" in a)
        self.path_query = path_query
        self.host_header = f"{hostname}:{port}" if explicit_port else hostname

    def url_for(self, ip: str) -> str:
        ip_host = f"[{ip}]" if ":" in ip else ip
        return f"{self.scheme}://{ip_host}:{self.port}{self.path_query}"


def check_url_syntax(raw: str) -> tuple:
    """
    Pure (no I/O) URL checks. Returns (scheme, hostname, port, explicit_port,
    path_query) or raises HTTPException(400). Unit-tested in test_main.py.
    """
    bad = HTTPException(400, "URL must point to a public http(s) host")
    if not isinstance(raw, str) or len(raw) > MAX_URL_LEN:
        raise bad
    # Control characters / whitespace inside a URL are a classic parser-
    # differential trick (one parser strips them, another doesn't).
    if any(ord(c) < 0x21 or ord(c) == 0x7F for c in raw):
        raise bad
    try:
        parts = urlsplit(raw)
        port = parts.port  # raises ValueError on non-numeric / out of range
    except ValueError:
        raise bad
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise bad
    # user:pass@host — no legitimate use, and a common way to disguise the
    # real host from humans and naive validators.
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise bad
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise bad
    explicit_port = port is not None
    if port is None:
        port = 443 if scheme == "https" else 80
    if port not in ALLOWED_PORTS:
        raise bad

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if not is_public_ip(ip):
            raise bad
    else:
        # IDNA-encode for DNS + Host header; reject what can't be encoded.
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError:
            raise bad
        # Single-label names ("backend", "pdf-service", "localhost", or a
        # bare decimal like "2130706433") are what Docker's embedded DNS /
        # search domains resolve to internal hosts — never a public site.
        if "." not in host or host == "localhost" or host.endswith(BLOCKED_HOST_SUFFIXES):
            raise bad

    path_query = parts.path or "/"
    if parts.query:
        path_query += "?" + parts.query
    return scheme, host, port, explicit_port, path_query


async def resolve_target(raw: str) -> _Target:
    """check_url_syntax + DNS resolution; every resolved address must be public."""
    scheme, host, port, explicit_port, path_query = check_url_syntax(raw)
    try:
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        loop = asyncio.get_running_loop()
        try:
            infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except (socket.gaierror, UnicodeError, OSError):
            raise HTTPException(400, "could not resolve URL host")
        addrs = [info[4][0] for info in infos]
    if not addrs:
        raise HTTPException(400, "could not resolve URL host")
    for a in addrs:
        # getaddrinfo may return scoped IPv6 ("fe80::1%eth0"); strip the zone.
        if not is_public_ip(ipaddress.ip_address(a.split("%", 1)[0])):
            log.warning("blocked non-public fetch target %s -> %s", host, a)
            raise HTTPException(400, "URL must point to a public http(s) host")
    return _Target(scheme, host, port, explicit_port, [a.split("%", 1)[0] for a in addrs], path_query)


# ── PDF download ──────────────────────────────────────────────────────────────

async def download_pdf(url: str) -> bytes:
    """Fetch `url` with SSRF checks on every hop, a byte cap, and a deadline."""
    try:
        # httpx timeouts are per connect/read; wait_for bounds the whole
        # thing (DNS + all redirect hops + body) against slow-drip servers.
        return await asyncio.wait_for(_download(url), timeout=DOWNLOAD_DEADLINE_S)
    except asyncio.TimeoutError:
        raise HTTPException(504, "download timed out")


async def _download(url: str) -> bytes:
    headers = {"User-Agent": "solar-planner-ocr/2.0", "Accept": "application/pdf,*/*;q=0.5"}
    # follow_redirects=False: redirects are followed manually below so each
    # hop is re-validated. trust_env=False: ignore HTTP(S)_PROXY / .netrc
    # from the environment — a proxy would re-resolve the hostname itself
    # and defeat the IP pinning.
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(15.0), follow_redirects=False, trust_env=False,
    ) as client:
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            target = await resolve_target(current)
            resp = None
            for ip in target.ips:
                request = client.build_request(
                    "GET",
                    target.url_for(ip),
                    headers={**headers, "Host": target.host_header},
                    # TLS: SNI + certificate verification against the ORIGINAL
                    # hostname even though we dial the IP directly.
                    extensions={"sni_hostname": target.hostname} if target.scheme == "https" else {},
                )
                try:
                    resp = await client.send(request, stream=True)
                    break
                except httpx.ConnectError as exc:
                    # Try the next validated address (e.g. AAAA unreachable).
                    log.info("connect to %s (%s) failed: %r", target.hostname, ip, exc)
                    continue
                except httpx.HTTPError as exc:
                    log.warning("download failed for %s: %r", target.hostname, exc)
                    raise HTTPException(502, "download failed")
            if resp is None:
                raise HTTPException(502, "download failed")
            try:
                if resp.status_code in (301, 302, 303, 307, 308):
                    location = resp.headers.get("location")
                    if not location:
                        raise HTTPException(502, "download failed")
                    current = urljoin(current, location)
                    continue
                if resp.status_code != 200:
                    # The numeric status is safe and useful to the user
                    # ("404" = wrong link); the body is not echoed.
                    raise HTTPException(502, f"download failed: remote server returned HTTP {resp.status_code}")

                size_err = HTTPException(413, f"PDF exceeds {MAX_PDF_BYTES // (1024 * 1024)} MB size limit")
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > MAX_PDF_BYTES:
                    raise size_err
                chunks = []
                total = 0
                # aiter_bytes yields DECODED bytes, so the cap also holds for
                # gzip bombs (Content-Encoding) — memory is what we protect.
                async for chunk in resp.aiter_bytes(65536):
                    total += len(chunk)
                    if total > MAX_PDF_BYTES:
                        raise size_err
                    chunks.append(chunk)
                data = b"".join(chunks)
            except httpx.HTTPError as exc:
                log.warning("download failed for %s: %r", target.hostname, exc)
                raise HTTPException(502, "download failed")
            finally:
                await resp.aclose()

            # The PDF spec allows the header anywhere in the first 1024 bytes.
            # Rejecting non-PDFs here keeps HTML error pages, images and other
            # junk away from pdfminer/poppler (less parser attack surface).
            if b"%PDF-" not in data[:1024]:
                raise HTTPException(415, "URL did not return a PDF")
            return data
        raise HTTPException(502, "download failed: too many redirects")


# ── Text extraction ───────────────────────────────────────────────────────────

def extract_text(pdf_bytes: bytes) -> str:
    """
    Try pdfminer first (fast, no system deps).  If the result is shorter than
    80 meaningful characters — as happens with design-tool PDFs that store
    glyphs without a Unicode map — fall back to OCR.
    """
    if HAS_PDFMINER:
        try:
            # maxpages bounds CPU on huge documents; datasheet specs are on
            # the first pages.
            text = _pdfminer_extract(io.BytesIO(pdf_bytes), maxpages=MAX_TEXT_PAGES)
            # Count alphanumeric chars; pure whitespace / control chars mean
            # the font has no Unicode mapping so we need OCR.
            if sum(c.isalnum() for c in text) >= 80:
                return text
        except Exception:
            log.info("pdfminer extraction failed; falling back to OCR", exc_info=True)

    if HAS_OCR:
        return _ocr_extract(pdf_bytes)

    return ""


def _ocr_extract(pdf_bytes: bytes) -> str:
    """
    Render the first MAX_OCR_PAGES pages ONE AT A TIME (never the whole
    document at once) and run tesseract on each.

    The previous `convert_from_bytes(pdf, dpi=200)` rasterised every page
    into memory up front: a 500-page PDF, or one page with a gigantic
    MediaBox, could take GBs. Now each page is scaled so its longest side is
    OCR_MAX_SIDE_PX, rendered in grayscale (1 byte/px instead of 3 — OCR
    doesn't need colour), OCR'd and released before the next one.
    """
    # TESSDATA_PREFIX points tesserocr at the traineddata files.
    # In Docker (system tesseract via apt) the default path is correct.
    # For venv installs, set TESSDATA_PREFIX to the directory containing
    # eng.traineddata (download from github.com/tesseract-ocr/tessdata).
    tessdata = os.environ.get("TESSDATA_PREFIX", "")

    with tempfile.TemporaryDirectory(prefix="ocr-") as tmp:
        # Write once; pdftoppm/pdfinfo then read the file for each page
        # (convert_from_bytes would rewrite the temp file on every call).
        pdf_path = os.path.join(tmp, "in.pdf")
        with open(pdf_path, "wb") as f:
            f.write(pdf_bytes)
        try:
            info = pdfinfo_from_path(pdf_path, timeout=OCR_PAGE_TIMEOUT_S)
            page_count = int(info.get("Pages", 0))
        except Exception:
            log.warning("pdfinfo failed", exc_info=True)
            raise HTTPException(422, "could not render PDF pages")

        pages = []
        for page_no in range(1, min(page_count, MAX_OCR_PAGES) + 1):
            try:
                images = convert_from_path(
                    pdf_path,
                    first_page=page_no,
                    last_page=page_no,
                    size=OCR_MAX_SIDE_PX,   # -scale-to: bounds the bitmap
                    grayscale=True,
                    timeout=OCR_PAGE_TIMEOUT_S,
                )
            except Exception:
                # pdftoppm stderr can include paths — log, don't return.
                log.warning("could not render page %d", page_no, exc_info=True)
                continue
            for img in images:
                try:
                    text = _ocr_image(img, tessdata)
                    if text:
                        pages.append(text)
                except Exception:
                    log.info("OCR failed on page %d", page_no, exc_info=True)
                    # skip unreadable page; partial text beats nothing
                finally:
                    img.close()

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


def _compact_text(text: str) -> str:
    """Strip trailing whitespace per line and collapse runs of blank lines.

    Line-based on purpose (no regex over the whole text): linear time even
    on pathological whitespace. Input is pre-truncated so a 25 MB text
    dump doesn't get fully split just to keep the first 30 k chars.
    """
    out = []
    blank = False
    for line in text[: MAX_LLM_CHARS * 4].splitlines():
        line = line.rstrip()
        if not line:
            if not blank:
                out.append("")
            blank = True
            continue
        blank = False
        out.append(line)
    return "\n".join(out).strip()


def llm_extract(text: str, device_type: str) -> list:
    """
    Send extracted datasheet text to the LLM and parse the structured response.
    Returns a list of dicts, one per product variant.
    Falls back to Groq automatically when Gemini returns 503 UNAVAILABLE.
    """
    prompt_tpl = _PANEL_PROMPT if device_type == "panel" else _INVERTER_PROMPT
    # Bound LLM cost/latency and keep a hostile PDF from stuffing megabytes
    # of text into the prompt. Collapsing blank-line runs first means the
    # budget is spent on content (pdfminer output is very newline-heavy).
    text = _compact_text(text)[:MAX_LLM_CHARS]
    prompt = prompt_tpl.format(text=text)

    # SDK exceptions can include request URLs, model/quota details or key
    # configuration hints — log them, return a generic message.
    try:
        raw = _call_gemini(prompt)
    except Exception as exc:
        # 503 UNAVAILABLE means Gemini is under high load — retry with Groq.
        if "503" in str(exc) or "UNAVAILABLE" in str(exc):
            log.warning("Gemini unavailable, falling back to Groq: %r", exc)
            try:
                raw = _call_groq(prompt)
            except Exception as exc2:
                log.error("Groq fallback failed: %r", exc2)
                raise HTTPException(502, "LLM call failed")
        else:
            log.error("Gemini call failed: %r", exc)
            raise HTTPException(502, "LLM call failed")

    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError) as exc:
        log.warning("LLM returned invalid JSON: %r", exc)
        raise HTTPException(502, "LLM returned invalid JSON")

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
    # The LLM output is derived from attacker-controlled PDF text (prompt
    # injection is possible), so treat it as untrusted: cap variant count
    # and string length, drop bools (isinstance(True, int) is True) and
    # non-finite floats (json.loads accepts NaN/Infinity, which would make
    # our ndjson line invalid JSON for the browser's JSON.parse).
    for item in parsed[:MAX_VARIANTS]:
        if not isinstance(item, dict):
            continue
        clean: dict = {}
        for k, v in item.items():
            if k in string_keys and isinstance(v, str) and v.strip():
                clean[k] = v.strip()[:MAX_STRING_FIELD_LEN]
            elif (k in numeric_keys and isinstance(v, (int, float))
                  and not isinstance(v, bool) and math.isfinite(v)):
                clean[k] = v
        if any(k in clean for k in numeric_keys):
            result.append(clean)

    return result
