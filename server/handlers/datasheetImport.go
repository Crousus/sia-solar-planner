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

package handlers

// datasheetImport.go — POST /api/sp/parse-datasheet
//
// Thin auth-and-SSRF gate that proxies validated requests to the
// ocr-service Python microservice, which handles the actual PDF
// download, text extraction, and LLM-based parsing.
//
// WHY split into a separate service:
//   Many manufacturer datasheets (JA Solar, Longi, …) render text as
//   vector glyphs with no Unicode font map, so Go PDF libraries return
//   empty strings.  Tesseract OCR solves this; shipping a CGo tesseract
//   binding inside the PocketBase binary adds complexity and a large C
//   dependency.  A small Python sidecar that owns pdftoppm + tesseract
//   + the Gemini API call keeps the Go binary clean.
//
// Auth and SSRF validation stay here in Go because:
//   - The ocr-service is internal (only reachable from the backend network).
//   - We never want unauthenticated callers to trigger arbitrary outbound
//     HTTP fetches or LLM API calls from our infrastructure.

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// ocrServiceURL is resolved once at startup.  Override via OCR_SERVICE_URL
// env var.  Default is localhost for plain `go run` dev; docker-compose
// sets it to http://ocr-service:8001.
var ocrServiceURL = func() string {
	if v := os.Getenv("OCR_SERVICE_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	return "http://localhost:8001"
}()

var ocrClient = &http.Client{Timeout: 120 * time.Second}

const (
	maxDatasheetRequestBytes = 8 << 10  // {"url": ≤2 KB, "type": …}
	maxOCRErrorBodyBytes     = 64 << 10 // we never forward more than a message
	maxForwardedErrorChars   = 300
)

// datasheetImportRequest mirrors what the Python service expects.
type datasheetImportRequest struct {
	URL  string `json:"url"`
	Type string `json:"type"` // "panel" | "inverter"
}

func handleDatasheetImport(re *core.RequestEvent) error {
	// Signed-in app users only. Unapproved users have e.Auth cleared by the
	// approval middleware. Every call can trigger an outbound fetch plus a
	// paid LLM request, so it's also rate-limited (migration 1712347100).
	if !isUserCaller(re) {
		return re.JSON(http.StatusUnauthorized, map[string]string{"error": "unauthenticated"})
	}

	re.Request.Body = http.MaxBytesReader(re.Response, re.Request.Body, maxDatasheetRequestBytes)
	var body datasheetImportRequest
	if err := json.NewDecoder(re.Request.Body).Decode(&body); err != nil {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body"})
	}
	if body.Type != "panel" && body.Type != "inverter" {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": `type must be "panel" or "inverter"`})
	}
	if err := validatePublicURL(re.Request.Context(), body.URL); err != nil {
		return re.JSON(http.StatusBadRequest, map[string]string{"error": err.Error()})
	}

	// Forward to the OCR service.  We re-encode the body so only the
	// validated fields reach the downstream service.
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(re.Request.Context(), http.MethodPost, ocrServiceURL+"/parse", strings.NewReader(string(payload)))
	if err != nil {
		re.App.Logger().Error("datasheet import: build request", "error", err)
		return re.JSON(http.StatusInternalServerError, map[string]string{"error": "datasheet import failed"})
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := ocrClient.Do(req)
	if err != nil {
		// Log the real cause (it contains the internal service hostname and
		// network error); return a generic message. Previously the raw
		// error — "dial tcp ocr-service:8001: …" — went to the browser.
		re.App.Logger().Error("datasheet import: ocr-service unreachable", "error", err)
		return re.JSON(http.StatusBadGateway, map[string]string{"error": "datasheet service unavailable"})
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxOCRErrorBodyBytes))
		if resp.StatusCode >= 500 {
			// 5xx bodies can carry tracebacks / internal URLs. Log, don't forward.
			re.App.Logger().Error("datasheet import: ocr-service error",
				"status", resp.StatusCode, "body", truncateRunes(string(raw), 2000))
			return re.JSON(http.StatusBadGateway, map[string]string{"error": "datasheet parsing failed"})
		}
		// 4xx are user-actionable ("could not download PDF", "not a PDF",
		// …). Forward only a short message string, never the raw body.
		return re.JSON(resp.StatusCode, map[string]string{"error": ocrErrorMessage(raw)})
	}
	// Success path: stream the ndjson body so the frontend receives progress
	// lines as they arrive rather than waiting for the full LLM response.
	re.Response.Header().Set("Content-Type", "application/x-ndjson")
	re.Response.Header().Set("X-Accel-Buffering", "no") // disable nginx proxy buffering
	re.Response.WriteHeader(http.StatusOK)
	flusher, canFlush := re.Response.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := re.Response.Write(buf[:n]); writeErr != nil {
				// Browser went away; headers are already sent, so there's
				// nothing useful to return to it.
				return nil
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// Headers (200) are already on the wire; log instead of trying
			// to write an error response the client can't parse anyway.
			re.App.Logger().Error("datasheet import: stream interrupted", "error", readErr)
			return nil
		}
	}
	return nil
}

// ocrErrorMessage extracts a short human message from an ocr-service
// error body ({"detail": "..."} from FastAPI, or {"error": "..."}).
func ocrErrorMessage(raw []byte) string {
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err == nil {
		for _, k := range []string{"error", "detail"} {
			if v, ok := m[k].(string); ok && v != "" {
				return truncateRunes(v, maxForwardedErrorChars)
			}
		}
	}
	return "datasheet could not be processed"
}
