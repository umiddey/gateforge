"""Gateforge pytest plugin: per-test witness sessions + proxied ``httpx``.

Plan 2026-09-25 phase 3. The plugin gives pytest the SAME supervised
evidence channel the Playwright pack gives the browser:

- Lifecycle: each test writes ``testBegin`` / ``testEnd`` events (test
  identity, outcome, attempt) to the run's lifecycle spool. The trusted
  CLI drain reads the spool and performs the witness's SUPERVISOR calls
  (session open/seal); this process holds no supervisor rights at all.
- Tagging: the ``gateforge_session`` fixture resolves the
  supervisor-issued session credential for the RUNNING test by the exact
  ``(workerIndex, testId)`` pair (only an OPEN supervisor session
  answers). The ``gateforge_http`` fixture hands the test an
  ``httpx.Client`` whose transport rewrites the app origin onto the
  per-test session proxy origin, so every exchange is attributed to THAT
  session — the same ``session-proxy`` channel the Playwright fixture
  uses.

The plugin is INERT without supervised wiring: when the run-scoped
``GATEFORGE_*`` variables are absent (plain ``pytest``, collection,
advisory diagnostics) every hook is a no-op, so enumeration and
non-witnessed runs behave exactly as without the plugin. A test that
REQUESTS the fixtures without wiring fails loudly — never silently
passes unwitnessed.

Claims: mapped obligation ids come from the CLI-written
``claim-injections.json`` in the run-state dir, keyed by the
reconciliation key ``<file>#<title path joined by '>'>``. The document
is read-only here; a broken or absent document contributes nothing.

Env contract (all four required for activation):
- ``GATEFORGE_WITNESS_URL``  witness base URL,
- ``GATEFORGE_RUN_TOKEN``    the run's submission credential,
- ``GATEFORGE_STATE_DIR``    absolute run-state dir (spool + claims),
- ``GATEFORGE_RUN_ID``       the run identity both sides agree on.

Optional: ``GATEFORGE_APP_BASE_URL`` (the app origin the transport
rewrites; without it ``gateforge_http`` uses the session proxy as base).

Requires pytest >= 7 (hook wrappers) and, for ``gateforge_http``,
``httpx`` importable in the test environment.
"""

import json
import os
import time
import urllib.error
import urllib.request

import pytest

WITNESS_URL_ENV = "GATEFORGE_WITNESS_URL"
RUN_TOKEN_ENV = "GATEFORGE_RUN_TOKEN"
STATE_DIR_ENV = "GATEFORGE_STATE_DIR"
RUN_ID_ENV = "GATEFORGE_RUN_ID"
APP_BASE_URL_ENV = "GATEFORGE_APP_BASE_URL"

RUN_HEADER = "x-gateforge-run"
CLAIM_INJECTIONS_FILE = "claim-injections.json"

SESSION_RESOLVE_TIMEOUT_SECONDS = 5.0
SESSION_RESOLVE_POLL_SECONDS = 0.05
SPOOL_POLL_SETTLE_SECONDS = 0.05


def _wired():
    """Whether the run-scoped supervised wiring is present.

    Returns:
        bool: True exactly when every activation variable is set and
        non-empty; False means the plugin stays inert.
    """
    return all(os.environ.get(name) for name in (WITNESS_URL_ENV, RUN_TOKEN_ENV, STATE_DIR_ENV, RUN_ID_ENV))


def _spool_file():
    """The run's lifecycle spool path.

    Returns:
        str: absolute ``<stateDir>/spool/<runId>/events.jsonl`` path.
    """
    return os.path.join(
        os.environ[STATE_DIR_ENV], "spool", os.environ[RUN_ID_ENV], "events.jsonl"
    )


def _append_event(event):
    """Append one lifecycle event line to the spool (runner side).

    The line is one JSON object terminated by a newline (the format is
    NUL-safe by construction: ``json.dumps`` escapes control characters).
    A failed append never crashes the run: the drain then simply never
    opens that session and the witness rejects submissions fail-closed.

    Args:
        event: dict with the spool event fields (kind, testId,
            workerIndex, file, titlePath, project, and for testEnd also
            outcome + attempt; claims when mapped).

    Returns:
        None.
    """
    try:
        path = _spool_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, separators=(",", ":")) + "\n")
    except OSError as error:
        print("[gateforge] cannot append to the lifecycle spool: %s" % error)


def _worker_index(config):
    """The worker slot this process runs in (pytest-xdist aware).

    Args:
        config: pytest config object (``workerinput`` exists only under
            xdist workers).

    Returns:
        int: non-negative worker index; 0 for a non-distributed run.
    """
    worker_input = getattr(config, "workerinput", None)
    if not isinstance(worker_input, dict):
        return 0
    raw = str(worker_input.get("workerid", "gw0"))
    digits = "".join(character for character in raw if character.isdigit())
    return int(digits) if digits else 0


def _identity(item):
    """The reconciliation identity of one test item.

    Args:
        item: the pytest item running.

    Returns:
        tuple: ``(file, title_path, key)`` where ``file`` is the
        cwd-relative posix path of the test module, ``title_path`` is
        the node id's segment list after the file part, and ``key`` is
        the ``<file>#<title path joined by '>'>`` reconciliation key the
        CLI's claim-injections document is keyed by.
    """
    node_file = item.nodeid.split("::")[0]
    path = getattr(item, "path", None)
    if path is not None:
        node_file = os.path.relpath(str(path), os.getcwd()).replace(os.sep, "/")
    title_path = item.nodeid.split("::")[1:]
    key = "%s#%s" % (node_file, ">".join(title_path))
    return node_file, title_path, key


def _claims_for(key):
    """Mapped obligation ids for one reconciliation key.

    Args:
        key: the ``<file>#<title path>`` reconciliation key.

    Returns:
        list[str]: sorted, de-duplicated obligation ids; empty when the
        claims document is absent, unmapped, or malformed (declarations
        never redirect evidence on a broken document).
    """
    path = os.path.join(os.environ[STATE_DIR_ENV], CLAIM_INJECTIONS_FILE)
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        return []
    if not isinstance(document, dict):
        return []
    injections = document.get("injections")
    if not isinstance(injections, dict):
        return []
    raw = injections.get(key)
    if not isinstance(raw, list):
        return []
    claims = sorted({claim for claim in raw if isinstance(claim, str) and claim})
    return claims


def _resolve_session(test_id, worker_index):
    """Resolve the supervisor-issued session credential for one test.

    Polls ``POST /sessions/resolve`` briefly: the drain opens the
    session asynchronously after the ``testBegin`` spool event lands.
    Only an OPEN supervisor session answers; a never-opened or sealed
    session 404s and keeps polling until the bound.

    Args:
        test_id: the runner test id the spool event carried.
        worker_index: this process's worker slot.

    Returns:
        dict: the session credential (sessionId, sessionToken, proxyUrl,
        claims, ...).

    Raises:
        RuntimeError: when no open session answers within the bound —
            fail closed, never a silently unwitnessed "pass".
    """
    request = json.dumps({"testId": test_id, "workerIndex": worker_index}).encode("utf-8")
    deadline = time.monotonic() + SESSION_RESOLVE_TIMEOUT_SECONDS
    last_detail = "no answer"
    while time.monotonic() < deadline:
        call = urllib.request.Request(
            os.environ[WITNESS_URL_ENV].rstrip("/") + "/sessions/resolve",
            data=request,
            headers={"content-type": "application/json", RUN_HEADER: os.environ[RUN_TOKEN_ENV]},
            method="POST",
        )
        try:
            with urllib.request.urlopen(call, timeout=5) as response:
                body = json.loads(response.read().decode("utf-8"))
            if isinstance(body, dict) and body.get("sessionId"):
                return body
            last_detail = "malformed resolve response"
        except urllib.error.HTTPError as error:
            if error.code != 404:
                last_detail = "HTTP %s from /sessions/resolve" % error.code
        except (OSError, ValueError) as error:
            last_detail = str(error)
        time.sleep(SESSION_RESOLVE_POLL_SECONDS)
    raise RuntimeError(
        "gateforge: no open witness session answered for test '%s' (worker %s) within %.0fs (%s) "
        "— run under the supervised window so the drain opens a session per started test"
        % (test_id, worker_index, SESSION_RESOLVE_TIMEOUT_SECONDS, last_detail)
    )


class GateforgeSession:
    """One test's supervisor-issued session credential.

    Attributes:
        session_id: the witness session id.
        session_token: the per-session submission token.
        proxy_url: the per-test session proxy origin (None when the run
            wired no observation proxy).
        app_base_url: the app origin the proxy fronts (may be empty).
    """

    def __init__(self, credential, app_base_url):
        self.session_id = str(credential.get("sessionId", ""))
        self.session_token = str(credential.get("sessionToken", ""))
        proxy_url = credential.get("proxyUrl")
        self.proxy_url = str(proxy_url) if isinstance(proxy_url, str) and proxy_url else None
        self.app_base_url = app_base_url or ""


def _proxied_client(session):
    """Build the session-proxied ``httpx.Client`` for one test.

    The transport rewrites requests addressed to the app origin onto the
    per-test session proxy origin (same loopback discipline as the
    Playwright fixture's page routing), preserving the path, so the
    exchange is observed under THIS test's session. Without an app base
    URL the client addresses the session proxy directly (relative paths).

    Args:
        session: the resolved GateforgeSession.

    Returns:
        httpx.Client: the client the test drives (caller closes it).
    """
    import httpx
    from urllib.parse import urlsplit

    if session.proxy_url is None:
        raise RuntimeError(
            "gateforge: the witness issued no per-session proxy for this run — the run must wire "
            "an observation proxy (proxyTarget) so httpx traffic can be attributed to the session"
        )
    inner = httpx.HTTPTransport()
    app = urlsplit(session.app_base_url) if session.app_base_url else None
    proxy = urlsplit(session.proxy_url)

    class _SessionProxyTransport(httpx.BaseTransport):
        """Rewrites app-origin requests onto the session proxy origin."""

        def handle_request(self, request):
            if (
                app is not None
                and request.url.host == app.hostname
                and (request.url.port or (443 if request.url.scheme == "https" else 80))
                == (app.port or (443 if app.scheme == "https" else 80))
            ):
                request.url = request.url.copy_with(host=proxy.hostname, port=proxy.port)
            return inner.handle_request(request)

    base_url = session.app_base_url or session.proxy_url
    return httpx.Client(base_url=base_url, transport=_SessionProxyTransport(), timeout=30.0)


@pytest.hookimpl(wrapper=True)
def pytest_runtest_protocol(item, nextitem):
    """Spool ``testBegin`` before, and ``testEnd`` after, one wired test.

    Args:
        item: the test item about to run.
        nextitem: the next item (pytest protocol argument, unused).

    Returns:
        The wrapped protocol result, unchanged.
    """
    if not _wired():
        result = yield
        return result
    worker = _worker_index(item.config)
    node_file, title_path, key = _identity(item)
    event = {
        "kind": "testBegin",
        "testId": item.nodeid,
        "workerIndex": worker,
        "file": node_file,
        "titlePath": title_path,
        "project": None,
    }
    claims = _claims_for(key)
    if claims:
        event["claims"] = claims
    _append_event(event)
    try:
        result = yield
    finally:
        reports = item.__dict__.get("gateforge_reports", [])
        failed = any(report.failed for report in reports)
        skipped = any(report.skipped for report in reports) and not failed
        call_reports = [report for report in reports if report.when == "call"]
        if skipped:
            outcome = "skipped"
        elif failed or not call_reports or not all(report.passed for report in reports if report.when != "teardown"):
            outcome = "failed"
        else:
            outcome = "passed"
        _append_event(
            {
                "kind": "testEnd",
                "testId": item.nodeid,
                "workerIndex": worker,
                "file": node_file,
                "titlePath": title_path,
                "project": None,
                "outcome": outcome,
                "attempt": max(1, len(call_reports)),
            }
        )
    return result


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item, call):
    """Stash each phase report so the protocol hook can grade the test.

    Args:
        item: the test item the report belongs to.
        call: the test phase (setup/call/teardown) being reported.

    Returns:
        The wrapped report, unchanged.
    """
    report = yield
    item.__dict__.setdefault("gateforge_reports", []).append(report)
    return report


@pytest.fixture
def gateforge_session(request):
    """One test's supervisor-issued witness session.

    Returns:
        GateforgeSession: the resolved credential for the RUNNING test.

    Raises:
        pytest.fail: when the supervised wiring is absent or no open
            session answers — a fixture user can never silently pass
            unwitnessed.
    """
    if not _wired():
        pytest.fail(
            "gateforge: the gateforge_session fixture requires the supervised wiring "
            "(GATEFORGE_WITNESS_URL / GATEFORGE_RUN_TOKEN / GATEFORGE_STATE_DIR / GATEFORGE_RUN_ID) — "
            "run under 'gateforge test-gates' or the PytestRunnerAdapter"
        )
    return GateforgeSession(
        _resolve_session(request.node.nodeid, _worker_index(request.config)),
        os.environ.get(APP_BASE_URL_ENV, ""),
    )


@pytest.fixture
def gateforge_http(gateforge_session):
    """An ``httpx.Client`` routed through THIS test's session proxy.

    Requests to the app origin (or relative requests, when no app base
    URL is wired) travel the per-test session proxy, so the witness
    observes every exchange under this test's session.

    Args:
        gateforge_session: the resolved session credential fixture.

    Yields:
        httpx.Client: the proxied client (closed on teardown).

    Raises:
        RuntimeError: when the run wired no observation proxy — traffic
            would bypass the session channel, which is never silent.
    """
    client = _proxied_client(gateforge_session)
    try:
        yield client
    finally:
        client.close()
