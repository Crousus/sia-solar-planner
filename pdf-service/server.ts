// Solar Planner - Frontend web application for designing and planning rooftop solar panel installations
// Copyright (C) 2026  Johannes Wenz github.com/Crousus
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

// ────────────────────────────────────────────────────────────────────────────
// pdf-service — server-side PDF renderer for Solar Planner.
//
// Request flow (current):
//   browser ──POST /pdf/render──▶ nginx (/pdf/ location, rate-limited)
//           ──▶ pdf-service :3002 /render
//   The request does NOT go through the Go/PocketBase backend: PocketBase
//   caps request bodies at 32 MB and the image payload can exceed that. So
//   this service authenticates the caller itself, by asking PocketBase to
//   refresh the caller's bearer token (see `requireUserAuth`).
//
// The client captures the Konva stage (roof plan) and the diagram as raster
// images (PNG/JPEG data URIs) plus extracted text runs; we run
// @react-pdf/renderer in Node so the output is deterministic regardless of
// the client device — no browser rendering quirks, no iOS WebKit /
// foreignObject bugs, and the main tab doesn't spend 3-4 GB of RAM on it.
//
// SECURITY MODEL — read before changing anything here:
//   * Every byte of the request body is attacker-controlled (any logged-in
//     user can POST arbitrary JSON). react-pdf's <Image src> is NOT a dumb
//     data sink: given `{uri, method, headers, body}` it performs that HTTP
//     request from inside our network (SSRF), and given a plain path string
//     it does `fs.readFile` (local file disclosure, e.g. /proc/self/environ
//     embedded into the PDF). Therefore the payload is validated against a
//     strict schema below and SolarPlanDoc is only ever rendered from the
//     *validated, re-constructed* props — never from `req.body` directly.
//   * Auth is checked BEFORE the (up to 60 MB) JSON body is parsed so an
//     anonymous caller cannot make us buffer and parse large bodies.
//   * Rendering is memory-heavy, so concurrent renders are capped.
//   * Errors are logged server-side; clients only get generic messages (raw
//     exception strings can leak paths, internal hostnames, stack details).
//
// Import path note:
//   This file lives at pdf-service/server.ts. It imports shared source via
//   "../src/…" which resolves correctly whether the service is run from
//   the repo root in dev or from /app in Docker (same relative structure
//   in both cases — see Dockerfile).
// ────────────────────────────────────────────────────────────────────────────

import express, { type NextFunction, type Request, type Response } from 'express';
import React from 'react';
import { renderToBuffer } from '@react-pdf/renderer';
import { SolarPlanDoc, type SolarPlanDocProps } from '../src/pdf/SolarPlanDoc';

const app = express();

// We sit behind nginx; don't advertise the framework.
app.disable('x-powered-by');

// PocketBase URL for token validation. Defaults to localhost for the native
// two-terminal dev workflow; docker-compose sets it to http://backend:8090.
const POCKETBASE_URL = (process.env.POCKETBASE_URL ?? 'http://localhost:8090').replace(/\/$/, '');

// How long we wait for PocketBase to answer the auth-refresh call. Without
// a timeout a hung backend would pin request slots (and their sockets)
// indefinitely. 5 s is far above the normal ~10 ms hop.
const AUTH_TIMEOUT_MS = 5_000;

// Max simultaneous renders. Each render holds the decoded images (tens of
// MB) plus react-pdf's layout tree in memory; a handful of parallel exports
// is plenty for a small team and keeps a burst from OOM-killing the
// container. Overflow gets a 503 + Retry-After instead of queueing
// unboundedly.
const MAX_CONCURRENT_RENDERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_RENDERS ?? '2', 10) || 2);

// Body limit: image data URLs can reach 10-30 MB JPEG as base64 on big
// monitors. Kept in sync with nginx `client_max_body_size 60m` for /pdf/.
const BODY_LIMIT = '60mb';

// ── Auth ────────────────────────────────────────────────────────────────────

// A PocketBase auth token is a JWT: three base64url segments. We sanity-check
// the shape and length before forwarding it so arbitrary junk (or a header
// smuggling attempt) never reaches the backend.
const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const MAX_AUTH_HEADER_LEN = 4096;

// Validate a PocketBase auth token by hitting the users auth-refresh
// endpoint. This is a lightweight hop that confirms the token is still valid
// (signature, expiry, record still exists — and, once the server's approval
// gate lands, that the user is approved) without us having to share the
// JWT secret or implement verification ourselves.
//
// We call the `users` collection explicitly AND check the returned record's
// collectionName: a token minted for another auth collection (notably
// `_superusers`) must not be accepted as "a user" here, and checking the
// response body guards against a future PocketBase behaviour change.
async function validateToken(authHeader: string | undefined): Promise<boolean> {
  if (!authHeader || authHeader.length > MAX_AUTH_HEADER_LEN) return false;
  if (!BEARER_RE.test(authHeader)) return false;
  try {
    const res = await fetch(`${POCKETBASE_URL}/api/collections/users/auth-refresh`, {
      method: 'POST',
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
      // Never follow redirects with the user's token attached.
      redirect: 'error',
    });
    if (!res.ok) {
      // Drain so the socket can be reused; ignore content.
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const data = (await res.json()) as { record?: { collectionName?: unknown; id?: unknown } };
    return data?.record?.collectionName === 'users' && typeof data.record.id === 'string';
  } catch (err) {
    // Network error / timeout / malformed JSON → fail closed. Log only the
    // error name so tokens never end up in logs.
    console.error('[pdf-service] auth check failed:', (err as Error)?.name ?? 'unknown');
    return false;
  }
}

// Route-level middleware: runs BEFORE express.json(), reading only the
// Authorization header. An unauthenticated request is rejected without the
// body ever being buffered or parsed.
async function requireUserAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await validateToken(req.headers.authorization))) {
    // `Connection: close` tells Node not to keep reading a (possibly huge)
    // unread request body to reuse the socket.
    res.setHeader('Connection', 'close');
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
}

// ── Concurrency gate ────────────────────────────────────────────────────────

let rendersInFlight = 0;

// Acquired after auth but before body parsing, so the 60 MB-per-request
// memory cost is bounded by MAX_CONCURRENT_RENDERS too. The slot is released
// on response 'close', which fires for success, error and client abort alike.
function renderSlot(_req: Request, res: Response, next: NextFunction): void {
  if (rendersInFlight >= MAX_CONCURRENT_RENDERS) {
    res.setHeader('Retry-After', '5');
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: 'busy' });
    return;
  }
  rendersInFlight++;
  let released = false;
  res.on('close', () => {
    if (!released) {
      released = true;
      rendersInFlight--;
    }
  });
  next();
}

// ── Payload validation ──────────────────────────────────────────────────────
//
// Strict allow-list schema. Anything not matching is a 400. We rebuild the
// props object from validated primitives so unknown keys (or prototype
// tricks) never reach react-pdf.

type CapturedPage = NonNullable<SolarPlanDocProps['planFrameCapture']>;
type TextRun = CapturedPage['texts'][number];
type Rect = NonNullable<SolarPlanDocProps['planImageRectPt']>;

class ValidationError extends Error {}

// Only base64 PNG/JPEG data URIs. In particular this excludes:
//   - objects ({uri, method, headers, body}) → SSRF via react-pdf's fetch
//   - http(s):// and file: URLs, bare paths    → SSRF / local file read
//   - data:image/svg+xml                        → SVG parser surface, and SVG
//                                                 can reference external
//                                                 resources
// The base64 alphabet check is anchored and uses a single character class,
// so it is linear-time even on tens of MB (no catastrophic backtracking).
const DATA_URI_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

// ~45 M base64 chars ≈ 34 MB decoded. A single image can't exceed the
// overall 60 MB body anyway; this just rejects absurd single fields early.
const MAX_IMAGE_CHARS = 45 * 1024 * 1024;
const MAX_TEXT_RUNS = 10_000;
const MAX_TEXT_LEN = 10_000;
const MAX_COORD = 100_000;        // px / pt — far beyond any real A4 capture
const MAX_CAPTURE_DIM = 20_000;   // capture is 1122×794 today
const MAX_FONT_SIZE = 1_000;

// CSS computed colours arrive as `rgb(…)`/`rgba(…)` (or hex / keywords /
// modern functional notations). We only need to stop pathological strings;
// react-pdf's colour parser never fetches anything.
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+(\([0-9a-zA-Z.,%\s/+-]*\))?)$/;

// PNG: 89 50 4E 47 0D 0A 1A 0A; JPEG: FF D8 FF. Checking the magic bytes
// turns a mislabeled/garbage image into a clean 400 rather than a renderer
// crash deep inside react-pdf.
function checkImage(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length > MAX_IMAGE_CHARS) throw new ValidationError(`${field} too large`);
  const m = DATA_URI_RE.exec(value);
  if (!m) throw new ValidationError(`${field} must be a base64 PNG or JPEG data URI`);
  const head = Buffer.from(m[2].slice(0, 16), 'base64');
  const isPng = head.length >= 8 && head.readUInt32BE(0) === 0x89504e47 && head.readUInt32BE(4) === 0x0d0a1a0a;
  const isJpeg = head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if ((m[1] === 'png' && !isPng) || (m[1] === 'jpeg' && !isJpeg)) {
    throw new ValidationError(`${field} content does not match its declared type`);
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkNum(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${field} must be a number in [${min}, ${max}]`);
  }
  return value;
}

function checkTextRun(value: unknown, field: string): TextRun {
  if (!isPlainObject(value)) throw new ValidationError(`${field} must be an object`);
  const { text, fontFamily, bold, color, textAlign } = value;
  if (typeof text !== 'string' || text.length > MAX_TEXT_LEN) {
    throw new ValidationError(`${field}.text must be a string of at most ${MAX_TEXT_LEN} chars`);
  }
  if (fontFamily !== 'sans' && fontFamily !== 'mono') throw new ValidationError(`${field}.fontFamily invalid`);
  if (typeof bold !== 'boolean') throw new ValidationError(`${field}.bold must be boolean`);
  if (typeof color !== 'string' || color.length > 64 || !COLOR_RE.test(color)) {
    throw new ValidationError(`${field}.color invalid`);
  }
  if (textAlign !== 'left' && textAlign !== 'center' && textAlign !== 'right' && textAlign !== 'justify') {
    throw new ValidationError(`${field}.textAlign invalid`);
  }
  return {
    text,
    x: checkNum(value.x, `${field}.x`, -MAX_COORD, MAX_COORD),
    y: checkNum(value.y, `${field}.y`, -MAX_COORD, MAX_COORD),
    width: checkNum(value.width, `${field}.width`, 0, MAX_COORD),
    height: checkNum(value.height, `${field}.height`, 0, MAX_COORD),
    fontSize: checkNum(value.fontSize, `${field}.fontSize`, 0, MAX_FONT_SIZE),
    fontFamily,
    bold,
    color,
    textAlign,
    letterSpacing: checkNum(value.letterSpacing, `${field}.letterSpacing`, -MAX_FONT_SIZE, MAX_FONT_SIZE),
  };
}

function checkCapture(value: unknown, field: string): CapturedPage {
  if (!isPlainObject(value)) throw new ValidationError(`${field} must be an object`);
  const { texts } = value;
  if (!Array.isArray(texts) || texts.length > MAX_TEXT_RUNS) {
    throw new ValidationError(`${field}.texts must be an array of at most ${MAX_TEXT_RUNS} runs`);
  }
  return {
    image: checkImage(value.image, `${field}.image`),
    texts: texts.map((t, i) => checkTextRun(t, `${field}.texts[${i}]`)),
    // Lower bound 1 — these are divisors in SolarPlanDoc.
    captureWidth: checkNum(value.captureWidth, `${field}.captureWidth`, 1, MAX_CAPTURE_DIM),
    captureHeight: checkNum(value.captureHeight, `${field}.captureHeight`, 1, MAX_CAPTURE_DIM),
  };
}

function checkRect(value: unknown, field: string): Rect {
  if (!isPlainObject(value)) throw new ValidationError(`${field} must be an object`);
  return {
    x: checkNum(value.x, `${field}.x`, -MAX_COORD, MAX_COORD),
    y: checkNum(value.y, `${field}.y`, -MAX_COORD, MAX_COORD),
    w: checkNum(value.w, `${field}.w`, 0, MAX_COORD),
    h: checkNum(value.h, `${field}.h`, 0, MAX_COORD),
  };
}

// `undefined` and `null` both mean "absent" (JSON.stringify drops undefined
// fields, but be lenient about explicit nulls).
function optional<T>(value: unknown, check: (v: unknown) => T): T | undefined {
  return value === undefined || value === null ? undefined : check(value);
}

export function validateRenderPayload(body: unknown): SolarPlanDocProps {
  if (!isPlainObject(body)) throw new ValidationError('body must be a JSON object');
  const props: SolarPlanDocProps = {
    planFrameCapture: optional(body.planFrameCapture, (v) => checkCapture(v, 'planFrameCapture')),
    planImageDataUrl: optional(body.planImageDataUrl, (v) => checkImage(v, 'planImageDataUrl')),
    planImageRectPt: optional(body.planImageRectPt, (v) => checkRect(v, 'planImageRectPt')),
    diagramCapture: optional(body.diagramCapture, (v) => checkCapture(v, 'diagramCapture')),
  };
  if (!props.planFrameCapture && !props.diagramCapture) {
    throw new ValidationError('at least one of planFrameCapture or diagramCapture is required');
  }
  return props;
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.post(
  '/render',
  requireUserAuth,
  renderSlot,
  // Body parsing only happens for authenticated callers that got a slot.
  // `strict: true` (default) only accepts objects/arrays at the top level.
  express.json({ limit: BODY_LIMIT }),
  async (req: Request, res: Response) => {
    let props: SolarPlanDocProps;
    try {
      props = validateRenderPayload(req.body);
    } catch (err) {
      if (err instanceof ValidationError) {
        // Validation messages are ours (field names + limits), safe to echo.
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    try {
      const element = React.createElement(SolarPlanDoc, props);

      // renderToBuffer is the Node.js-specific API — pdf().toBuffer() is the
      // browser path and returns the internal PDFDocument object in Node.js
      // rather than a Buffer, which causes express to try to JSON-serialize it.
      // The cast: renderToBuffer is typed for <Document> elements; SolarPlanDoc
      // returns one, but TS can't see through the function component.
      const buffer = await renderToBuffer(element as unknown as Parameters<typeof renderToBuffer>[0]);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) {
      // Full detail stays in the server log; the client only learns that it
      // failed (String(err) could leak file paths, hostnames, stack info).
      console.error('[pdf-service] render failed:', err);
      res.status(500).json({ error: 'render failed' });
    }
  },
);

// Health check for docker-compose depends_on condition in the future.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Final error handler: body-parser errors (413 too large, 400 malformed
// JSON) and anything unexpected. Express's default handler would include
// the stack trace in non-production mode — we always return a generic body.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
  if (status >= 500) console.error('[pdf-service] unhandled error:', err);
  if (res.headersSent) return;
  const message = status === 413 ? 'payload too large' : status === 400 ? 'invalid JSON body' : 'internal error';
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
});

// Only start listening when run as the entrypoint, so tests can import
// `validateRenderPayload` without opening a port.
const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const PORT = parseInt(process.env.PORT ?? '3002', 10);
  app.listen(PORT, () => {
    console.log(`pdf-service listening on :${PORT}`);
  });
}
