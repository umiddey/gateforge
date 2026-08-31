"""GPP/2 client library for Gateforge plugins (Python, stdlib only).

Lineage: spikes/plugin-protocol host/_lib lineage, hardened per ADR 0002
D3 at protocolVersion 2. A plugin calls :func:`serve` with its identity
and a ``discover(paths)`` handler; this module performs the hello/ready
handshake, validates host frames (protocolVersion, seq order, digest),
answers discover requests, and completes the shutdown/bye handshake.

Digest rule (pin #5): ``digest = sha256(canonical({type, seq, payload}))``
over GF-canonical-JSON (UTF-8, recursively key-sorted, no whitespace,
integers plain) — byte-compatible with @gateforge/core.
"""

from __future__ import annotations

import hashlib
import json
import sys

PROTOCOL_VERSION = 2
REQUIRED_CAPABILITY = "discover"

_KNOWN_TYPES = ("hello", "ready", "discover", "result", "error", "shutdown", "bye")


class ProtocolError(Exception):
    """A fail-closed protocol violation carrying a GPP code and detail."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(f"[{code}] {detail}")
        self.code = code
        self.detail = detail


def canonical_json(value: object) -> str:
    """Serializes a JSON-representable value to GF-canonical-JSON (pin #1).

    Args:
        value: Any JSON value (str/int/bool/None/list/dict of JSON values).

    Returns:
        str: Canonical JSON text — keys sorted recursively, no whitespace.

    Raises:
        TypeError: If the value is not JSON-representable.
    """
    if value is None:
        return "null"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise TypeError(f"canonical_json: {value!r} has no canonical form")
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        members = ",".join(
            f"{json.dumps(key, ensure_ascii=False)}:{canonical_json(value[key])}"
            for key in sorted(value)
        )
        return "{" + members + "}"
    raise TypeError(f"canonical_json: unsupported type {type(value).__name__}")


def digest_of(type_: str, seq: int, payload: object) -> str:
    """Computes the per-message digest: sha256(canonical({type, seq, payload})).

    Args:
        type_: Message catalog name.
        seq: Sender-side sequence number (1-based).
        payload: Message payload (JSON value).

    Returns:
        str: Lowercase hex sha256 digest.
    """
    return hashlib.sha256(
        canonical_json({"type": type_, "seq": seq, "payload": payload}).encode("utf-8")
    ).hexdigest()


def _send(
    type_: str,
    seq: int,
    payload: object,
    plugin_id: str,
    plugin_version: str,
) -> None:
    """Writes one newline-terminated envelope line to stdout and flushes."""
    frame = {
        "protocolVersion": PROTOCOL_VERSION,
        "pluginId": plugin_id,
        "pluginVersion": plugin_version,
        "type": type_,
        "seq": seq,
        "payload": payload,
        "digest": digest_of(type_, seq, payload),
    }
    sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _verify_host_frame(
    frame: object,
    expected_seq: int,
    plugin_id: str,
    plugin_version: str,
) -> dict:
    """Validates one host frame envelope; raises ProtocolError on violation.

    Args:
        frame: Parsed JSON value of the host frame.
        expected_seq: The next legal host seq (strictly sequential).
        plugin_id: This plugin's declared id (must be echoed by the host).
        plugin_version: This plugin's declared version (must be echoed).

    Returns:
        dict: The verified frame.

    Raises:
        ProtocolError: With the matching E_* code on any violation.
    """
    where = f"host frame {expected_seq}"
    if not isinstance(frame, dict):
        raise ProtocolError("E_FRAME_JSON", f"{where}: valid JSON but not an object")
    for field in ("protocolVersion", "pluginId", "pluginVersion", "type", "seq", "payload", "digest"):
        if field not in frame:
            raise ProtocolError("E_SCHEMA", f'{where}: required envelope field "{field}" is missing')
    if frame["protocolVersion"] != PROTOCOL_VERSION:
        raise ProtocolError(
            "E_PROTOCOL_VERSION",
            f"{where}: envelope protocolVersion={frame['protocolVersion']!r} but the plugin speaks {PROTOCOL_VERSION}",
        )
    if frame["pluginId"] != plugin_id or frame["pluginVersion"] != plugin_version:
        raise ProtocolError(
            "E_UNKNOWN_PLUGIN",
            f"{where}: host echoed identity "
            f"({frame['pluginId']!r}, {frame['pluginVersion']!r}) but this plugin is "
            f"({plugin_id!r}, {plugin_version!r})",
        )
    if frame["type"] not in _KNOWN_TYPES:
        raise ProtocolError(
            "E_UNKNOWN_TYPE",
            f"{where}: unknown message type {frame['type']!r}; known types: {sorted(_KNOWN_TYPES)}",
        )
    if frame["seq"] != expected_seq:
        raise ProtocolError(
            "E_SCHEMA",
            f"{where} (type {frame['type']}): seq {frame['seq']!r} but expected {expected_seq}",
        )
    expected_digest = digest_of(frame["type"], frame["seq"], frame["payload"])
    if frame["digest"] != expected_digest:
        raise ProtocolError(
            "E_SCHEMA",
            f"{where} (type {frame['type']}): digest mismatch: expected {expected_digest}, got {frame['digest']}",
        )
    return frame


def serve(
    plugin_id: str,
    plugin_version: str,
    discover,
    capabilities: tuple[str, ...] = (REQUIRED_CAPABILITY,),
) -> int:
    """Runs the GPP/2 serve loop over stdin/stdout until shutdown or EOF.

    Args:
        plugin_id: This plugin's identity, pinned by the host handshake.
        plugin_version: This plugin's version, pinned by the host handshake.
        discover: Callable ``discover(paths: list[str]) -> dict`` returning
            ``{"resources": [...], "unresolved": [...], "findings": [...]}``.
            Raise and the request is answered with an ``error`` frame.
        capabilities: Declared capabilities (default: ``("discover",)``).

    Returns:
        int: Process exit code (0 on a clean shutdown handshake).
    """
    seq = 0

    def next_seq() -> int:
        nonlocal seq
        seq += 1
        return seq

    _send("hello", next_seq(), {"capabilities": list(capabilities)}, plugin_id, plugin_version)

    host_seq = 0  # the host has its own strictly sequential counter

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            frame = json.loads(line)
        except json.JSONDecodeError as error:
            _fatal(plugin_id, plugin_version, next_seq(), "E_FRAME_JSON", f"host frame is not valid JSON ({error})")
        frame = _verify_host_frame(frame, host_seq + 1, plugin_id, plugin_version)
        host_seq += 1
        type_ = frame["type"]
        if type_ == "ready":
            continue
        if type_ == "discover":
            request = frame["payload"]
            request_id = request.get("requestId") if isinstance(request, dict) else None
            paths = request.get("paths") if isinstance(request, dict) else None
            if not isinstance(request_id, str) or not request_id or not isinstance(paths, list):
                _fatal(
                    plugin_id,
                    plugin_version,
                    next_seq(),
                    "E_SCHEMA",
                    f"discover frame: invalid payload: {json.dumps(request)[:200]}",
                )
            try:
                result = discover(list(paths))
                _send(
                    "result",
                    next_seq(),
                    {
                        "requestId": request_id,
                        "resources": result.get("resources", []),
                        "unresolved": result.get("unresolved", []),
                        "findings": result.get("findings", []),
                    },
                    plugin_id,
                    plugin_version,
                )
            except ProtocolError:
                raise
            except Exception as error:  # request-scoped: session stays alive
                _send(
                    "error",
                    next_seq(),
                    {"requestId": request_id, "code": "E_PLUGIN_INTERNAL", "message": str(error)},
                    plugin_id,
                    plugin_version,
                )
        elif type_ == "shutdown":
            _send("bye", next_seq(), {}, plugin_id, plugin_version)
            return 0
    return 0


def _fatal(plugin_id: str, plugin_version: str, seq: int, code: str, detail: str) -> None:
    """Emits a session-fatal error frame (no requestId), then exits nonzero."""
    try:
        _send("error", seq + 1, {"code": code, "message": detail}, plugin_id, plugin_version)
    except Exception:
        pass
    raise SystemExit(4)
