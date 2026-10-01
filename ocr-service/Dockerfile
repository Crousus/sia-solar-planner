# ocr-service Dockerfile
#
# python:3.12-slim base + system tesseract (English + German) + poppler
# for pdf2image.  The image is intentionally kept small: no dev tools,
# no build cache, apt lists cleaned after install.

FROM python:3.12-slim

# tesseract-ocr      — OCR engine
# tesseract-ocr-eng  — English language pack
# tesseract-ocr-deu  — German (many datasheets mix German labels)
# poppler-utils      — provides pdftoppm, used by pdf2image to render PDF pages
RUN apt-get update && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        tesseract-ocr-deu \
        poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Run unprivileged. The service parses untrusted PDFs with pdfminer,
# poppler and tesseract — large native attack surface — so a parser bug
# must not hand out root in the container. A fixed UID keeps file
# ownership predictable across rebuilds; --no-create-home + /tmp for
# scratch (tempfile / pdf2image write there) is all it needs. App files
# stay root-owned so the process can't modify its own code.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin ocr
USER 10001

# Internal port — only the backend service talks to us.
EXPOSE 8001
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
