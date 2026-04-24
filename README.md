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
| **PDF export** | A4 landscape, two pages: roof plan + block diagram |
| **Team sync** | Real-time multi-tab sync via PocketBase SSE; optimistic concurrency with conflict UI |
| **Datasheet import** | Upload an inverter/panel PDF — OCR + Gemini extract specs automatically |
| **i18n** | English and German |

---

## Getting started

### Frontend only (no backend required)

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Works fully offline in single-user mode using `localStorage`.

### Full stack

```bash
docker-compose -f docker-compose.dev.yml up
```

This starts:
- **Frontend** on port `5173` (Vite, hot-reload)
- **Backend** on port `8090` (PocketBase + custom Go handlers)
- **OCR sidecar** on port `8001` (FastAPI + Tesseract + Gemini)

PocketBase admin UI: [http://127.0.0.1:8090/_/](http://127.0.0.1:8090/_/)

<details>
<summary>Run services individually</summary>

```bash
# Backend
cd server && go build -o pocketbase . && ./pocketbase serve

# OCR sidecar
cd ocr-service && pip install -r requirements.txt && uvicorn main:app --port 8001

# Frontend
npm run dev
```

</details>

---

## Tech stack

| Concern | Choice |
|---|---|
| Build | Vite 5 |
| UI | React 18 + TypeScript (strict) |
| Roof canvas | react-konva |
| Diagram canvas | @xyflow/react v12 |
| Map | react-leaflet |
| State | Zustand (persist + undo/redo middleware) |
| PDF | @react-pdf/renderer + html2canvas |
| Backend | PocketBase (custom Go binary) |
| OCR | FastAPI + pdfminer + Tesseract + Gemini Flash Lite |
| i18n | i18next + react-i18next |

---

## Development

```bash
npm install          # install dependencies
npm run dev          # start dev server
npm run build        # production build (tsc + vite)
npx tsc --noEmit     # type-check only
npx vitest run       # unit tests
```

For backend changes, always rebuild the binary after editing Go files:

```bash
cd server && go build -o pocketbase .
```

---

## License

[AGPL-3.0](LICENSE)
