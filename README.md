# Solar Planner

**Browser-based PV installation designer** — sketch solar panels on satellite imagery, wire strings to inverters, draw a single-line block diagram, and export a two-page A4 PDF.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)

---

## Features

| | |
|---|---|
| **Satellite map** | ESRI World Imagery, Bayern Orthophoto, Bayern ALKIS cadastral overlay |
| **Roof drawing** | Click-to-place vertices; split, merge, or trim edges |
| **Panel placement** | Tilt-aware grid snapping aligned to each roof's long axis |
| **String wiring** | Lasso-assign panels; auto-numbered wiring order; detour routing around non-member panels |
| **Block diagram** | Electrical single-line canvas (React Flow) bootstrapped from roof/inverter data |
| **PDF export** | A4 landscape, two pages: roof plan + block diagram (rendered server-side by `pdf-service`) |
| **Team sync** | Real-time multi-user sync via PocketBase SSE; optimistic concurrency, automatic merge of non-overlapping edits, conflict UI for true conflicts |
| **Datasheet import** | Upload an inverter/panel PDF — OCR + Gemini extract specs automatically |
| **i18n** | English and German |

---

## Getting started

Solar Planner needs its backend: projects live in PocketBase and there is no offline / local-only mode. Requirements: Node 22, Go 1.27+ (backend), Docker (optional, for the full stack).

### Full stack (Docker)

```bash
docker-compose -f docker-compose.dev.yml up
```

This starts (all ports bound to `127.0.0.1`):
- **Frontend** on port `5173` (Vite, hot-reload)
- **Backend** on port `8090` (PocketBase + custom Go handlers)
- **PDF service** on port `3002` (Node + @react-pdf/renderer)
- **OCR sidecar** on port `8001` (FastAPI + Tesseract + Gemini; needs `GEMINI_API_KEY` for datasheet import)

PocketBase admin UI: [http://127.0.0.1:8090/_/](http://127.0.0.1:8090/_/)

`docker-compose up` builds the production-like stack: nginx on port 80 serves the SPA and proxies `/api/` and `/pdf/`, the admin UI is not exposed (use an SSH tunnel to the backend), and new sign-ups need admin approval (`REQUIRE_APPROVAL=true`, see [`server/README.md`](server/README.md)).

<details>
<summary>Run services individually</summary>

```bash
# Backend (Go 1.27+)
cd server && go build -o pocketbase . && ./pocketbase serve --http=127.0.0.1:8090

# PDF service (needed for PDF export)
cd pdf-service && npm ci && npm start

# OCR sidecar (needed for datasheet import)
cd ocr-service && pip install -r requirements.txt && uvicorn main:app --port 8001

# Frontend — proxies /api to :8090 and /pdf to :3002
npm install && npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

</details>

---

## Tech stack

| Concern | Choice |
|---|---|
| Build | Vite 8 |
| UI | React 18 + TypeScript (strict) |
| Roof canvas | react-konva |
| Diagram canvas | @xyflow/react v12 |
| Map | react-leaflet |
| State | Zustand (in-memory; custom delta undo/redo middleware) |
| PDF | html-to-image capture in the browser + @react-pdf/renderer in `pdf-service` |
| Backend | PocketBase v0.40 (custom Go binary) |
| OCR | FastAPI + pdfminer + Tesseract + Gemini Flash Lite |
| i18n | i18next + react-i18next |

---

## Development

```bash
npm install              # install dependencies
npm run dev              # start dev server
npm run build            # production build (tsc + vite)
npx tsc --noEmit         # type-check only
npx vitest run           # unit tests
npm run test:integration # integration tests against a real PocketBase (build server/pocketbase first)

cd server && go test ./...                       # backend tests
cd pdf-service && npm test                       # pdf-service tests
cd ocr-service && python -m pytest test_main.py  # OCR sidecar tests
```

For backend changes, always rebuild the binary after editing Go files:

```bash
cd server && go build -o pocketbase .
```

CI (`.github/workflows/ci.yml`) runs all of the above on every push and pull request.

Contributor / agent guide: [`AGENTS.md`](AGENTS.md). Design decisions: [`adr/`](adr/).

---

## License

[AGPL-3.0](LICENSE)
