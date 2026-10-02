# ocr-service/test_main.py
#
# Unit tests for the SSRF guard and output sanitiser in main.py.
#
#   cd ocr-service && python -m pytest test_main.py     (preferred)
#   cd ocr-service && python test_main.py               (no pytest needed)
#
# Needs the service's Python deps (fastapi, httpx, python-dotenv) but no
# network access, poppler, tesseract or LLM keys: DNS is stubbed, and the
# redirect test uses a throwaway local HTTP server.

import asyncio
import http.server
import ipaddress
import json
import os
import threading

import httpx

from fastapi import HTTPException

import main

# Captured before any test monkeypatches main._call_llm (the sanitiser tests
# below replace it with fakes and don't restore it).
_REAL_CALL_LLM = main._call_llm


def _rejects(url: str) -> bool:
    try:
        main.check_url_syntax(url)
    except HTTPException as exc:
        return exc.status_code == 400
    return False


def test_url_syntax_rejects_internal_targets():
    for url in [
        "ftp://example.com/a.pdf",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://localhost/a.pdf",
        "http://backend:8090/api/",            # docker service name
        "http://pdf-service:3002/render",
        "http://backend./api/",                # trailing-dot single label
        "http://2130706433/",                  # decimal 127.0.0.1
        "http://127.0.0.1/",
        "http://10.0.0.5/",
        "http://172.18.0.2/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://100.64.1.1/",                  # CGNAT
        "http://0.0.0.0/",
        "http://[::1]/",
        "http://[::]/",
        "http://[::ffff:127.0.0.1]/",          # v4-mapped
        "http://[fd00::1]/",                   # ULA
        "http://[fe80::1]/",                   # link-local
        "http://[2002:7f00:1::]/",             # 6to4 embedding 127.0.0.1
        "http://[64:ff9b::a00:1]/",            # NAT64 embedding 10.0.0.1
        "http://printer.local/",
        "http://metadata.google.internal/",
        "http://user:pw@example.com/a.pdf",    # userinfo
        "http://example.com@10.0.0.1/",
        "http://example.com:22/",              # disallowed port
        "http://example.com:99999/",           # invalid port
        "http://exa mple.com/",                # whitespace
        "http://example.com/\x00",
        "http:///a.pdf",                       # no host
        "http://" + "a" * 3000 + ".com/",      # too long
    ]:
        assert _rejects(url), url


def test_url_syntax_accepts_public_urls():
    scheme, host, port, explicit, pq = main.check_url_syntax(
        "https://Www.Example.com/files/ds.pdf?v=2#frag")
    assert (scheme, host, port, explicit, pq) == ("https", "www.example.com", 443, False, "/files/ds.pdf?v=2")
    assert main.check_url_syntax("http://example.com:8080/x.pdf")[2:4] == (8080, True)
    assert main.check_url_syntax("http://93.184.216.34/x.pdf")[1] == "93.184.216.34"
    assert main.check_url_syntax("http://[2606:4700::1111]/x.pdf")[1] == "2606:4700::1111"


def test_is_public_ip():
    for a in ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]:
        assert main.is_public_ip(ipaddress.ip_address(a)), a
    for a in ["127.0.0.1", "10.1.2.3", "100.100.0.1", "169.254.169.254", "172.31.255.255",
              "192.168.0.1", "224.0.0.1", "255.255.255.255", "::1", "fc00::1", "fe80::1",
              "::ffff:10.0.0.1", "2001::1"]:  # 2001::/32 is Teredo
        assert not main.is_public_ip(ipaddress.ip_address(a)), a


def _run(coro):
    return asyncio.run(coro)


def test_resolve_rejects_hostname_resolving_to_private():
    # A public-looking name whose DNS answer is internal (rebinding style),
    # including a MIXED answer where only one record is private.
    async def fake_getaddrinfo(host, port, **kw):
        return [(2, 1, 6, "", ("93.184.216.34", port)), (2, 1, 6, "", ("10.0.0.7", port))]

    async def go():
        loop = asyncio.get_running_loop()
        loop.getaddrinfo = fake_getaddrinfo  # type: ignore[method-assign]
        try:
            await main.resolve_target("http://evil.example.com/x.pdf")
        except HTTPException as exc:
            return exc.status_code
        return None

    assert _run(go()) == 400


def test_resolve_pins_ip_and_keeps_host_header():
    async def fake_getaddrinfo(host, port, **kw):
        return [(10, 1, 6, "", ("2606:4700::1111", port, 0, 0))]

    async def go():
        asyncio.get_running_loop().getaddrinfo = fake_getaddrinfo  # type: ignore[method-assign]
        return await main.resolve_target("https://cdn.example.com:8443/a/b.pdf?x=1")

    t = _run(go())
    assert t.url_for(t.ips[0]) == "https://[2606:4700::1111]:8443/a/b.pdf?x=1"
    assert t.host_header == "cdn.example.com:8443"
    assert t.hostname == "cdn.example.com"


def test_target_prefers_ipv4():
    t = main._Target("https", "h.example.com", 443, False, ["2606:4700::1", "93.184.216.34", "2606:4700::1"], "/")
    assert t.ips == ["93.184.216.34", "2606:4700::1"]


class _RedirectHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(302)
        self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


def test_redirect_to_internal_host_is_blocked():
    # Local server stands in for "a public host that redirects inward". We
    # let the FIRST hop through by stubbing resolve_target for that URL
    # only; every later hop goes through the real check.
    srv = http.server.HTTPServer(("127.0.0.1", 0), _RedirectHandler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    first = f"http://public.example.com:{port}/ds.pdf"
    real_resolve = main.resolve_target
    seen = []

    async def resolve(url):
        seen.append(url)
        if url == first:
            return main._Target("http", "public.example.com", port, True, ["127.0.0.1"], "/ds.pdf")
        return await real_resolve(url)

    main.resolve_target = resolve
    old_ports = main.ALLOWED_PORTS
    main.ALLOWED_PORTS = old_ports | {port}
    try:
        try:
            _run(main.download_pdf(first))
            status = None
        except HTTPException as exc:
            status = exc.status_code
    finally:
        main.resolve_target = real_resolve
        main.ALLOWED_PORTS = old_ports
        srv.shutdown()
    assert status == 400, status
    assert seen == [first, "http://169.254.169.254/latest/meta-data/"]


def test_llm_output_sanitised():
    main._call_llm = lambda prompt: (
        '[{"model": "' + "x" * 500 + '", "wattPeak": 440, "voc": NaN, "phases": true},'
        ' {"wattPeak": Infinity}, "junk"]'
    )
    out = main.llm_extract("some text", "panel")
    assert out == [{"model": "x" * main.MAX_STRING_FIELD_LEN, "wattPeak": 440}]


def test_llm_input_truncated():
    captured = {}

    def fake(prompt):
        captured["p"] = prompt
        return '[{"wattPeak": 1}]'

    main._call_llm = fake
    main.llm_extract("A" * (main.MAX_LLM_CHARS * 10) + "\n\n\n\n", "panel")
    assert len(captured["p"]) < main.MAX_LLM_CHARS + 5000


# ── DeepSeek client / Groq fallback ─────────────────────────────────────────

def _deepseek_with(handler):
    """Point the module's DeepSeek client at an in-process mock transport."""
    main._deepseek_http = httpx.Client(
        base_url="https://api.deepseek.test",
        transport=httpx.MockTransport(handler),
    )


def _restore_llm(old_call_llm, old_groq_call):
    main._call_llm = old_call_llm
    main._call_groq = old_groq_call
    main._deepseek_http = None


def test_deepseek_request_shape_and_variants_unwrap():
    old = (main._call_llm, main._call_groq)
    main._call_llm = _REAL_CALL_LLM
    seen = {}

    def handler(request):
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {
            "content": '{"variants": [{"manufacturer": "JA", "wattPeak": 440}]}'}}]})

    try:
        _deepseek_with(handler)
        out = main.llm_extract("datasheet text", "panel")
    finally:
        _restore_llm(*old)
    assert out == [{"manufacturer": "JA", "wattPeak": 440}]
    assert seen["path"] == "/chat/completions"
    body = seen["body"]
    assert body["model"] == main.DEEPSEEK_MODEL
    assert body["response_format"] == {"type": "json_object"}
    # Reasoning mode is off by default (it pushed latency past a minute).
    assert body["thinking"] == {"type": "disabled"}
    # DeepSeek JSON mode requires the word "json" in the prompt.
    assert "json" in (body["messages"][0]["content"] + body["messages"][1]["content"]).lower()


def test_deepseek_transient_error_falls_back_to_groq_when_configured():
    old = (main._call_llm, main._call_groq)
    main._call_llm = _REAL_CALL_LLM
    main._call_groq = lambda prompt: '{"variants": [{"wattPeak": 400}]}'
    os.environ["GROQ_API_KEY"] = "test-groq-key"
    try:
        _deepseek_with(lambda request: httpx.Response(503))
        out = main.llm_extract("t", "panel")
        # Empty JSON-mode content is DeepSeek's documented flake → fallback too.
        _deepseek_with(lambda request: httpx.Response(200, json={"choices": [{"message": {"content": ""}}]}))
        out2 = main.llm_extract("t", "panel")
    finally:
        os.environ.pop("GROQ_API_KEY", None)
        _restore_llm(*old)
    assert out == out2 == [{"wattPeak": 400}]


def test_deepseek_auth_error_does_not_fall_back():
    old = (main._call_llm, main._call_groq)
    main._call_llm = _REAL_CALL_LLM
    called = []
    main._call_groq = lambda prompt: called.append(1) or '{"variants": []}'
    os.environ["GROQ_API_KEY"] = "test-groq-key"
    try:
        _deepseek_with(lambda request: httpx.Response(401, json={"error": {"message": "bad key"}}))
        try:
            main.llm_extract("t", "panel")
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 502
            assert exc.detail == "LLM call failed"  # generic, no provider detail
    finally:
        os.environ.pop("GROQ_API_KEY", None)
        _restore_llm(*old)
    assert called == []


def test_transient_error_without_fallback_is_generic_502():
    old = (main._call_llm, main._call_groq)
    main._call_llm = _REAL_CALL_LLM
    os.environ.pop("GROQ_API_KEY", None)
    try:
        _deepseek_with(lambda request: httpx.Response(429))
        try:
            main.llm_extract("t", "panel")
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 502
    finally:
        _restore_llm(*old)


def test_deepseek_keepalive_trickle_hits_wall_clock_deadline():
    """A queued request that only ever sends keep-alive bytes must not pin a
    concurrency slot forever (observed during a DeepSeek outage)."""
    import time as _t

    class Trickle(httpx.SyncByteStream):
        def __iter__(self):
            while True:
                _t.sleep(0.05)
                yield b"\n"

    old = (main._call_llm, main._call_groq, main.LLM_TIMEOUT_S)
    main._call_llm = _REAL_CALL_LLM
    main.LLM_TIMEOUT_S = 0.3
    os.environ.pop("GROQ_API_KEY", None)
    t0 = _t.monotonic()
    try:
        _deepseek_with(lambda request: httpx.Response(200, stream=Trickle()))
        try:
            main.llm_extract("t", "panel")
            raise AssertionError("expected HTTPException")
        except HTTPException as exc:
            assert exc.status_code == 502
    finally:
        main.LLM_TIMEOUT_S = old[2]
        _restore_llm(old[0], old[1])
    assert _t.monotonic() - t0 < 2


def test_deepseek_leading_keepalive_lines_are_tolerated():
    old = (main._call_llm, main._call_groq)
    main._call_llm = _REAL_CALL_LLM
    payload = b"\n\n" + json.dumps({"choices": [{"message": {
        "content": '{"variants": [{"wattPeak": 445}]}'}}]}).encode()
    try:
        _deepseek_with(lambda request: httpx.Response(200, content=payload))
        out = main.llm_extract("t", "panel")
    finally:
        _restore_llm(*old)
    assert out == [{"wattPeak": 445}]


if __name__ == "__main__":
    failed = 0
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {exc!r}")
    print(f"{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
