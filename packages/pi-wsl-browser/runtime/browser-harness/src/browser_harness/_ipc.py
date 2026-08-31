"""Daemon IPC plumbing. AF_UNIX socket on POSIX, TCP loopback on Windows."""

import asyncio
import contextlib
import json
import os
import re
import secrets
import socket
import subprocess
import sys
from pathlib import Path

from . import paths

_MANAGED_SOCKET_ENV = "BH_MANAGED_SOCKET"
_MANAGED_MODE_ENV = "BH_MANAGED"

IS_WINDOWS = sys.platform == "win32"


def managed_mode():
    """Whether this process belongs to the package-managed browser lane.

    The daemon receives both ``BH_MANAGED=1`` and the socket path.  The agent
    wrapper deliberately receives only the socket path, so socket presence is
    also a managed-mode signal.  In managed mode the socket path is always the
    controller-selected endpoint; BU_NAME is never used for endpoint lookup.
    """
    return os.environ.get(_MANAGED_MODE_ENV) == "1" or bool(
        os.environ.get(_MANAGED_SOCKET_ENV)
    )


def managed_socket_path():
    """Return the exact managed Unix socket path, or ``None`` outside managed mode.

    The controller contract requires an absolute path.  Rejecting relative
    paths here prevents a caller's working directory from changing which
    daemon receives lifecycle or CDP requests.
    """
    raw = os.environ.get(_MANAGED_SOCKET_ENV)
    if not raw:
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError("managed socket path must be absolute")
    return path


# Two caller-supplied dirs:
#   BH_RUNTIME_DIR — sock/port/pid. AF_UNIX sun_path is 104 bytes on macOS, so
#       the runtime dir must be short. Caller is responsible for keeping it
#       within budget. Falls back to BH_TMP_DIR (legacy single-dir callers),
#       then to the browser-harness runtime dir.
#   BH_TMP_DIR — screenshots, debug overlays, daemon log. No path-length
#       sensitivity; caller can use a deep persistent path.
# By default, a caller-supplied dir is treated as per-instance and files use
# bare "bu" stems. Set BH_RUNTIME_DIR_SHARED=1 or BH_TMP_DIR_SHARED=1 when the
# dir is shared by multiple BU_NAME values and the filename must carry the name.
BH_TMP_DIR = os.environ.get("BH_TMP_DIR")
BH_RUNTIME_DIR = os.environ.get("BH_RUNTIME_DIR") or BH_TMP_DIR
BH_RUNTIME_DIR_SHARED = os.environ.get("BH_RUNTIME_DIR_SHARED") == "1"
BH_TMP_DIR_SHARED = os.environ.get("BH_TMP_DIR_SHARED") == "1"
_TMP = paths.tmp_dir()
_RUNTIME = (
    paths.ensure_private_dir(Path(BH_RUNTIME_DIR).expanduser().resolve())
    if BH_RUNTIME_DIR
    else paths.runtime_dir()
)
_TMP.mkdir(parents=True, exist_ok=True)
_RUNTIME.mkdir(parents=True, exist_ok=True)
_NAME_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")

# Set by serve() on Windows. Daemon's handle() requires every request to carry
# this token (TCP loopback has no chmod-equivalent so any local process could
# otherwise issue CDP commands). Stays None on POSIX where AF_UNIX + chmod 600
# is the boundary.
_server_token = None


def _check(name):  # path-traversal guard for BU_NAME
    if not _NAME_RE.match(name or ""):
        raise ValueError(f"invalid BU_NAME {name!r}: must match [A-Za-z0-9_-]{{1,64}}")
    return name


def _runtime_stem(name):  # "bu" when BH_RUNTIME_DIR isolates us, else "bu-<NAME>"
    _check(name)
    return "bu" if BH_RUNTIME_DIR and not BH_RUNTIME_DIR_SHARED else f"bu-{name}"


def _tmp_stem(name):  # "bu" when BH_TMP_DIR isolates us, else "bu-<NAME>"
    _check(name)
    return "bu" if BH_TMP_DIR and not BH_TMP_DIR_SHARED else f"bu-{name}"


def log_path(name):
    return _TMP / f"{_tmp_stem(name)}.log"


def pid_path(name):
    return _RUNTIME / f"{_runtime_stem(name)}.pid"


def port_path(name):
    return (
        _RUNTIME / f"{_runtime_stem(name)}.port"
    )  # Windows-only: holds {"port","token"} JSON


def _sock_path(name):
    return _RUNTIME / f"{_runtime_stem(name)}.sock"


def _is_true(value):
    return type(value) is bool and value


def _read_port_file(name):
    """(port, token) from the Windows port file, or (None, None) on any failure."""
    try:
        d = json.loads(port_path(name).read_text(encoding="utf-8"))
        return int(d["port"]), d["token"]
    except (FileNotFoundError, ValueError, KeyError, TypeError, OSError):
        return None, None


def sock_addr(name):  # display-only, used in log lines
    managed = managed_socket_path()
    if managed is not None:
        return str(managed)
    if not IS_WINDOWS:
        return str(_sock_path(name))
    port, _ = _read_port_file(name)
    return f"127.0.0.1:{port}" if port else f"tcp:{_runtime_stem(name)}"


def spawn_kwargs():  # subprocess.Popen flags so the daemon detaches from this terminal
    if IS_WINDOWS:
        # CREATE_NO_WINDOW: no console window for the daemon. CREATE_NEW_PROCESS_GROUP:
        # daemon doesn't receive Ctrl-C/Ctrl-Break sent to the parent terminal, so
        # closing that terminal doesn't kill it. DETACHED_PROCESS is intentionally
        # omitted: per Win32 docs it overrides CREATE_NO_WINDOW, causing Windows to
        # allocate a fresh console for the (still console-subsystem) python.exe.
        return {
            "creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        }
    return {"start_new_session": True}


def connect(name, timeout=1.0):
    """Blocking client for the selected daemon endpoint.

    Managed mode ignores ``name`` and connects only to the exact controller
    socket.  This is intentional: the agent must not be able to select an
    arbitrary BU_NAME or another Pi session.
    """
    managed = managed_socket_path()
    if managed is not None:
        if not hasattr(socket, "AF_UNIX"):
            raise OSError("managed Unix sockets are unavailable on this platform")
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(str(managed))
        return s, None
    if not IS_WINDOWS:
        # uv-Python on Windows lacks socket.AF_UNIX, so this branch must be gated.
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect(str(_sock_path(name)))
        return s, None
    port, token = _read_port_file(name)
    if port is None:
        raise FileNotFoundError(str(port_path(name)))
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.settimeout(timeout)
    return s, token


def request(c, token, req):
    """One-shot send + recv + parse on an open socket. Injects token on Windows.
    Returns the parsed JSON response. Caller closes the socket."""
    if token:
        req = {**req, "token": token}
    c.sendall((json.dumps(req) + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        chunk = c.recv(1 << 16)
        if not chunk:
            break
        data += chunk
    try:
        return json.loads(data or b"{}")
    except json.JSONDecodeError as error:
        raise ValueError("daemon returned invalid JSON") from error


def ping(name, timeout=1.0):
    """True iff a live daemon answers our ping. Defends against stale .port files
    + port reuse: a bare TCP connect can succeed against an unrelated process that
    grabbed the port after our daemon crashed; only our daemon answers {"pong":true}."""
    try:
        c, token = connect(name, timeout=timeout)
    except (FileNotFoundError, ConnectionRefusedError, TimeoutError, OSError):
        return False
    try:
        resp = request(c, token, {"meta": "ping"})
        # request() returns parsed JSON, which may be any valid value (a list,
        # scalar, etc. from a stale or hostile endpoint). Anything that isn't
        # a {pong: true} dict counts as "not our daemon" — never .get() blindly.
        return isinstance(resp, dict) and _is_true(resp.get("pong"))
    except (OSError, ValueError, AttributeError):
        return False
    finally:
        with contextlib.suppress(OSError):
            c.close()


def identify(name, timeout=1.0):
    """Return the live daemon's PID, or None if unreachable.

    Used by restart_daemon() to signal a process whose identity has been
    verified end-to-end (live IPC + self-reported PID), instead of trusting
    a pid file whose number may have been reused by an unrelated process."""
    try:
        c, token = connect(name, timeout=timeout)
    except (FileNotFoundError, ConnectionRefusedError, TimeoutError, OSError):
        return None
    try:
        resp = request(c, token, {"meta": "ping"})
        # request() returns parsed JSON, which may be any valid value (a list,
        # scalar, etc. from a stale or hostile endpoint). Anything that isn't
        # a {pong: true} dict gets None — never .get() on a non-dict.
        if not isinstance(resp, dict) or not _is_true(resp.get("pong")):
            return None
        pid = resp.get("pid")
        # `type(pid) is int` (not isinstance) intentionally rejects bool: in
        # Python, isinstance(True, int) is True, so a hostile/buggy daemon
        # could reply with {"pid": True} and we'd treat that as PID 1 (init).
        # Also reject 0/negatives — os.kill(0, sig) signals every process in
        # the calling process group, os.kill(-1, sig) signals every process
        # the caller can. Upper bound is 2**31 because C pid_t is typically
        # signed 32-bit and a value outside that range makes os.kill() raise
        # OverflowError, which would propagate out of restart_daemon() before
        # its cleanup. Linux pid_max is also bounded at 2**22 in practice.
        return pid if type(pid) is int and 0 < pid < (1 << 31) else None
    except (OSError, ValueError, AttributeError):
        return None
    finally:
        with contextlib.suppress(OSError):
            c.close()


async def serve(name, handler):
    """Run the server until cancelled on the selected daemon endpoint."""
    global _server_token
    managed = managed_socket_path()
    if managed is not None:
        if not hasattr(socket, "AF_UNIX"):
            raise OSError("managed Unix sockets are unavailable on this platform")
        managed.parent.mkdir(parents=True, exist_ok=True)
        path = str(managed)
        if os.path.exists(path):
            Path(path).unlink(missing_ok=True)
        # Keep the endpoint private even when the controller selected a shared
        # temporary parent.  The lifecycle token remains the privilege gate.
        old_umask = os.umask(0o077)
        try:
            server = await asyncio.start_unix_server(handler, path=path)
            os.chmod(path, 0o600)
        finally:
            os.umask(old_umask)
        _server_token = None
        try:
            async with server:
                await asyncio.Event().wait()
        finally:
            managed.unlink(missing_ok=True)
        return
    if not IS_WINDOWS:
        path = str(_sock_path(name))
        if os.path.exists(path):
            Path(path).unlink(missing_ok=True)
        # umask 0o077 keeps the bind private; chmod makes the exact socket
        # mode 0600 without a world/group-readable steady state.
        old_umask = os.umask(0o077)
        try:
            server = await asyncio.start_unix_server(handler, path=path)
            os.chmod(path, 0o600)
        finally:
            os.umask(old_umask)
        _server_token = None
        async with server:
            await asyncio.Event().wait()
        return
    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    _server_token = secrets.token_hex(32)
    pf = port_path(name)
    # Atomic write so a concurrent reader never sees a half-written file.
    tmp = pf.with_name(pf.name + ".tmp")
    tmp.write_text(json.dumps({"port": port, "token": _server_token}), encoding="utf-8")
    os.replace(tmp, pf)
    try:
        async with server:
            await asyncio.Event().wait()
    finally:
        pf.unlink(missing_ok=True)


def expected_token():
    """The token the running daemon will accept, or None on POSIX."""
    return _server_token


def cleanup_endpoint(name):  # best-effort; silent if already gone
    managed = managed_socket_path()
    p = (
        managed
        if managed is not None
        else (_sock_path(name) if not IS_WINDOWS else port_path(name))
    )
    with contextlib.suppress(FileNotFoundError):
        p.unlink()
