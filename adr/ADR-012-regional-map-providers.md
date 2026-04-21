# ADR-012: Regional Map Provider Integration (WMS)

- **Status:** Accepted
- **Date:** 2026-04-20
- **Requirement:** Enable high-resolution regional map sources, specifically for Bavaria (OpenData), to improve planning accuracy.

## Context
Global map providers like ESRI or Mapbox provide good coverage but often lack the extreme resolution (20cm) or precise building geometry (ALKIS) available through regional state-surveying agencies.

## Decision
1.  **Provider State:** Added `mapProvider` to `MapState`.
2.  **WMS Support:** Updated `MapView.tsx` to conditionally render Leaflet `WMSTileLayer` components.
3.  **Bavarian Integration:** Added support for:
    - **Bayern DOP 20cm:** High-resolution orthophotos.
    - **Hybrid ALKIS View:** Overlays the cadastral building footprints (yellow outlines) directly on top of the DOP 20cm imagery.
4.  **Persistence:** The selected provider is saved with the project and captured during the map lock process via the existing `html2canvas` pipeline.

## Consequences
- **Pros:** Superior accuracy for Bavarian projects; cadastral overlays make roof tracing trivial and mathematically exact.
- **Cons:** Regional providers only work within their specific geographic boundaries; adds complexity to the map layer rendering.
