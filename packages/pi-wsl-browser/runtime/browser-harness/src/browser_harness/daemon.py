"""CDP WS holder + IPC relay (Unix socket on POSIX, TCP loopback on Windows). One daemon per BU_NAME."""

import asyncio, hmac, json, os, platform, re, socket, sys, time, urllib.error, urllib.request, uuid
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse

from . import _ipc as ipc
from . import auth
from . import paths
from cdp_use.client import CDPClient  # type: ignore[import-not-found]


def _load_env():
    # The package controller supplies the complete managed environment. Loading
    # a legacy workspace/repo .env here could reintroduce a second CDP endpoint
    # or a cloud browser after the controller deliberately cleared it.
    if ipc.managed_mode():
        return
    repo_root = Path(__file__).resolve().parents[2]
    workspace = paths.workspace_dir()
    for p in (repo_root / ".env", workspace / ".env"):
        if not p.exists():
            continue
        _load_env_file(p)


def _load_env_file(p):
    for line in p.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

NAME = "managed" if ipc.managed_mode() else os.environ.get("BU_NAME", "default")
SOCK = ipc.sock_addr(NAME)
LOG = str(ipc.log_path(NAME))
PID = str(ipc.pid_path(NAME))
BUF = 500
_MAC_PROFILES = (
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Google/Chrome Canary",
    "Library/Application Support/Comet",
    "Library/Application Support/Arc/User Data",
    "Library/Application Support/Dia/User Data",
    "Library/Application Support/Microsoft Edge",
    "Library/Application Support/Microsoft Edge Beta",
    "Library/Application Support/Microsoft Edge Dev",
    "Library/Application Support/Microsoft Edge Canary",
    "Library/Application Support/BraveSoftware/Brave-Browser",
)
_LINUX_PROFILES = (
    ".config/google-chrome",
    ".config/chromium",
    ".config/chromium-browser",
    ".config/microsoft-edge",
    ".config/microsoft-edge-beta",
    ".config/microsoft-edge-dev",
    ".var/app/org.chromium.Chromium/config/chromium",
    ".var/app/com.google.Chrome/config/google-chrome",
    ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser",
    ".var/app/com.microsoft.Edge/config/microsoft-edge",
)
_WINDOWS_PROFILES = (  # relative to %LOCALAPPDATA%; SxS = Canary channel
    "Google/Chrome/User Data",
    "Google/Chrome SxS/User Data",
    "Google/Chrome Beta/User Data",
    "Google/Chrome Dev/User Data",
    "Chromium/User Data",
    "Microsoft/Edge/User Data",
    "Microsoft/Edge Beta/User Data",
    "Microsoft/Edge Dev/User Data",
    "Microsoft/Edge SxS/User Data",
    "BraveSoftware/Brave-Browser/User Data",
)


def profile_dirs(system=None):
    system = system or platform.system()
    if system == "Windows":
        local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return [local / p for p in _WINDOWS_PROFILES]
    if system == "Darwin":
        return [Path.home() / p for p in _MAC_PROFILES]
    return [Path.home() / p for p in _LINUX_PROFILES]


PROFILES = profile_dirs()
INTERNAL = (
    "chrome://",
    "chrome-untrusted://",
    "devtools://",
    "chrome-extension://",
    "about:",
)
BU_API = "https://api.browser-use.com/api/v3"
REMOTE_ID = os.environ.get("BU_BROWSER_ID")
BROWSER_KIND = (
    "cloud"
    if REMOTE_ID
    else (
        "cdp"
        if (os.environ.get("BU_CDP_WS") or os.environ.get("BU_CDP_URL"))
        else "local"
    )
)
# Chrome 144+ shows a per-connection popup. Keep popup open enough to click.
LOCAL_HANDSHAKE_TIMEOUT = 45
# How long get_ws_url() keeps waiting for DevToolsActivePort before giving up
NO_TOGGLE_GRACE = 3
TOGGLE_BOOT_GRACE = 12

MANAGED_MODES = frozenset({"headless", "headed-tmp-profile", "main-profile"})
# Controller may treat this health failure as pending readiness; all other
# managed errors are direct policy/lifecycle failures and are not retried.
MANAGED_TRANSIENT_ERROR_CODES = frozenset({"managed_cdp_unavailable"})
_MANAGED_MARKER_RE = re.compile(r"\A[A-Za-z0-9._~-]{1,160}\Z")
_MANAGED_DENIED_METHODS = frozenset(
    {
        "Browser.close",
        "Browser.crash",
        "Page.close",
        "Target.closeTarget",
        "Target.createBrowserContext",
        "Target.createTarget",
        "Target.attachToBrowserTarget",
        "Target.detachFromTarget",
        "Target.disposeBrowserContext",
        "Target.sendMessageToTarget",
        "Target.setAutoAttach",
        "Target.setDiscoverTargets",
    }
)


class ManagedModeError(RuntimeError):
    """An expected managed-lane policy or lifecycle failure."""

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass
class ManagedLease:
    lease_id: str
    mode: str
    profile: object
    marker: str
    root_target_id: str


def _managed_error(code, message, details=None):
    """Agent-facing error retaining the upstream string ``error`` field."""
    response = {"error": code, "code": code, "message": message}
    if details:
        response["details"] = details
    return response


def _managed_control_error(code, message, details=None):
    response = {"ok": False, "error": {"code": code, "message": message}}
    if details:
        response["error"]["details"] = details
    return response


def _managed_control_ok(data):
    return {"ok": True, "data": data}


def _devtools_port_live(base):
    """True when something is listening on the profile's DevToolsActivePort port.

    A stale file left behind by a closed browser must not count as a running
    instance — it would route recovery to "click Allow" on a popup that can't
    exist."""
    try:
        port = int(
            (base / "DevToolsActivePort")
            .read_text(encoding="utf-8", errors="replace")
            .splitlines()[0]
            .strip()
        )
    except (OSError, ValueError, IndexError):
        return False
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


def remote_debugging_user_enabled():
    """chrome://inspect's "Allow remote debugging" toggle

    True only when a toggle-on profile also has a live DevTools port.
    False if a profile records it off, None when no profile records it."""
    seen = None
    for base in PROFILES:
        try:
            state = json.loads(
                (base / "Local State").read_text(encoding="utf-8", errors="replace")
            )
            enabled = ((state.get("devtools") or {}).get("remote_debugging") or {}).get(
                "user-enabled"
            )
        except (OSError, ValueError, AttributeError):
            continue
        if enabled is True and _devtools_port_live(base):
            return True
        if enabled is False:
            seen = False
    return seen


def remote_debugging_toggle_profiles():
    """Profile dirs whose chrome://inspect toggle is recorded on in Local State"""
    out = []
    for base in PROFILES:
        try:
            state = json.loads(
                (base / "Local State").read_text(encoding="utf-8", errors="replace")
            )
            if ((state.get("devtools") or {}).get("remote_debugging") or {}).get(
                "user-enabled"
            ) is True:
                out.append(base)
        except (OSError, ValueError, AttributeError):
            continue
    return out


def browser_running_for_profile(base):
    """True when a running browser instance holds this user-data-dir (POSIX)"""
    try:
        target = os.readlink(str(base / "SingletonLock"))
    except OSError:
        return False
    try:
        pid = int(target.rsplit("-", 1)[-1])
    except ValueError:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError as error:
        return not isinstance(error, ProcessLookupError)


def supported_browser_running():
    """Is any browser whose profile we scan actually running?"""
    if platform.system() == "Windows":
        # Chromium on Windows uses a named mutex instead of SingletonLock —
        import subprocess

        try:
            out = subprocess.check_output(
                ["tasklist"], text=True, errors="replace", timeout=5
            ).lower()
        except Exception:
            return True  # can't tell — assume running so recovery stays on the popup/toggle path
        return any(
            n in out
            for n in (
                "chrome.exe",
                "msedge.exe",
                "chromium.exe",
                "brave.exe",
                "helium.exe",
            )
        )
    return any(browser_running_for_profile(base) for base in PROFILES)


def log(msg):
    open(LOG, "a", encoding="utf-8", errors="replace").write(f"{msg}\n")


async def _silent(coro):
    try:
        await coro
    except Exception as error:
        _ = error


def _ws_from_devtools_active_port(http_url: str) -> str | None:
    """When /json/version returns 404 (Chrome 147+ default profile), match DevToolsActivePort by port."""
    p = urlparse(http_url)
    want_port = str(p.port) if p.port else ""
    if not want_port:
        return None
    host = p.hostname or "127.0.0.1"
    if ":" in host:  # urlparse strips IPv6 brackets; restore them for the ws:// URL
        host = f"[{host}]"
    for base in PROFILES:
        try:
            active = (
                (base / "DevToolsActivePort")
                .read_text(encoding="utf-8", errors="replace")
                .splitlines()
            )
        except (FileNotFoundError, NotADirectoryError):
            continue
        port = active[0].strip() if active else ""
        ws_path = active[1].strip() if len(active) > 1 else ""
        if port == want_port and ws_path:
            return f"ws://{host}:{port}{ws_path}"
    return None


def _managed_ws_from_url(url):
    """Resolve the controller's one explicit HTTP CDP endpoint without discovery."""
    deadline = time.time() + 30
    last_error = None
    endpoint = url.rstrip("/")
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                f"{endpoint}/json/version", timeout=5
            ) as response:
                payload = json.loads(response.read() or b"{}")
            websocket_url = payload.get("webSocketDebuggerUrl")
            if isinstance(websocket_url, str) and websocket_url:
                return websocket_url
            last_error = "endpoint response has no webSocketDebuggerUrl"
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code == 403:
                raise ManagedModeError(
                    "managed_cdp_permission_denied",
                    "the explicit CDP endpoint rejected access (HTTP 403)",
                ) from error
        except (OSError, KeyError, TypeError, ValueError) as error:
            last_error = error
        time.sleep(0.2)
    raise ManagedModeError(
        "managed_cdp_unavailable",
        f"BU_CDP_URL={url} was unreachable after 30s: {last_error}",
    )


def get_ws_url():
    if ipc.managed_mode():
        websocket_url = os.environ.get("BU_CDP_WS")
        http_url = os.environ.get("BU_CDP_URL")
        if bool(websocket_url) == bool(http_url):
            raise ManagedModeError(
                "managed_endpoint_required",
                "managed mode requires exactly one of BU_CDP_URL or BU_CDP_WS",
            )
        if websocket_url:
            return websocket_url
        return _managed_ws_from_url(http_url)
    if url := os.environ.get("BU_CDP_WS"):
        return url
    if url := os.environ.get("BU_CDP_URL"):
        # HTTP DevTools endpoint (e.g. http://127.0.0.1:9333) — resolve to ws via /json/version.
        # Use this for a dedicated automation Chrome on a non-default profile, which avoids the
        # M144 "Allow remote debugging" dialog and the M136 default-profile lockdown.
        deadline = time.time() + 30
        last_err = None
        base_url = url.rstrip("/")
        while time.time() < deadline:
            try:
                return json.loads(
                    urllib.request.urlopen(f"{base_url}/json/version", timeout=5).read()
                )["webSocketDebuggerUrl"]
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code == 403:
                    raise RuntimeError(
                        "permission-blocked: Chrome is reachable, but the per-session Allow remote debugging popup has not been accepted"
                    )
                if e.code == 404 and (ws := _ws_from_devtools_active_port(url)):
                    return ws
                time.sleep(1)
            except Exception as e:
                last_err = e
                time.sleep(1)
        hint = "is the dedicated automation Chrome running? Launch it with --remote-debugging-port=<port> --user-data-dir=<dedicated dir>"
        if platform.system() == "Windows":
            hint += "; on Windows also check that a firewall/antivirus isn't blocking localhost connections"
        raise RuntimeError(
            f"BU_CDP_URL={url} unreachable after 30s: {last_err} -- {hint}"
        )
    deadline = time.time() + 30
    next_liveness_check = 0.0
    while time.time() < deadline:
        for base in PROFILES:
            try:
                active = (
                    (base / "DevToolsActivePort")
                    .read_text(encoding="utf-8", errors="replace")
                    .splitlines()
                )
            except (FileNotFoundError, NotADirectoryError):
                continue
            port = active[0].strip() if active else ""
            ws_path = active[1].strip() if len(active) > 1 else ""
            if not port:
                continue
            # Resolve the live WS URL via /json/version instead of trusting the path stored
            # alongside the port in DevToolsActivePort: if Chrome was previously launched
            # with a different --user-data-dir on the same port, that file is left behind
            # with a stale browser UUID and the WS upgrade returns 404.
            try:
                return json.loads(
                    urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/json/version", timeout=1
                    ).read()
                )["webSocketDebuggerUrl"]
            except urllib.error.HTTPError as e:
                if e.code == 403:
                    raise RuntimeError(
                        "permission-blocked: Chrome is reachable, but the per-session Allow remote debugging popup has not been accepted"
                    )
                # Chrome 147+ disables /json/* HTTP discovery on the default user-data-dir;
                # the ws path Chrome wrote to DevToolsActivePort still works.
                if e.code == 404 and ws_path:
                    return f"ws://127.0.0.1:{port}{ws_path}"
            except (OSError, KeyError, ValueError):
                continue
        # Closed browser leaves stale DevToolsActivePort files
        now = time.time()
        if now >= next_liveness_check:
            if not supported_browser_running():
                raise RuntimeError(
                    "chrome-not-running: no supported Chromium-family browser is running -- start Chrome, then retry"
                )
            next_liveness_check = now + 2
        # The browser is running but the port isn't up; waiting 30s
        grace = (
            TOGGLE_BOOT_GRACE if remote_debugging_toggle_profiles() else NO_TOGGLE_GRACE
        )
        if now > deadline - 30 + grace:
            break
        time.sleep(0.2)
    for probe_port in (9222, 9223):
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{probe_port}/json/version", timeout=1
            ) as r:
                return json.loads(r.read())["webSocketDebuggerUrl"]
        except urllib.error.HTTPError as e:
            if e.code == 403:
                raise RuntimeError(
                    "permission-blocked: Chrome is reachable, but the per-session Allow remote debugging popup has not been accepted"
                )
        except (OSError, KeyError, ValueError):
            continue
    if remote_debugging_user_enabled() is False:
        raise RuntimeError(
            'remote debugging is turned off for this browser instance — enable chrome://inspect/#remote-debugging (tick "Allow remote debugging for this browser instance")'
        )
    raise RuntimeError(
        f"DevToolsActivePort not found in {[str(p) for p in PROFILES]} — enable chrome://inspect/#remote-debugging, or set BU_CDP_WS for a remote browser"
    )


def stop_remote():
    # Managed sessions are always attached to the controller's explicit CDP
    # endpoint.  They cannot own a cloud browser or perform a remote stop.
    if ipc.managed_mode():
        return
    if not REMOTE_ID:
        return
    try:
        key = auth.get_browser_use_api_key()
        req = urllib.request.Request(
            f"{BU_API}/browsers/{REMOTE_ID}",
            data=json.dumps({"action": "stop"}).encode(),
            method="PATCH",
            headers={"X-Browser-Use-API-Key": key, "Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=15).read()
        log(f"stopped remote browser {REMOTE_ID}")
    except Exception as e:
        log(f"stop_remote failed ({REMOTE_ID}): {e}")


def is_real_page(t):
    return t["type"] == "page" and not t.get("url", "").startswith(INTERNAL)


def is_reusable_blank_page(t):
    """A plain about:blank tab that is safe to attach to and navigate"""
    url = t.get("url", "")
    return (
        t["type"] == "page"
        and (url == "about:blank" or url.startswith("about:blank#"))
        and not t.get("title", "").startswith("Starting agent ")
    )


def is_inspect_tab(t):
    """A chrome://inspect tab — normally the one the permission flow opened"""
    return t["type"] == "page" and t.get("url", "").startswith("chrome://inspect")


def harness_opened_inspect():
    """True when admin's recovery flow opened a chrome://inspect tab that is
    still awaiting cleanup (the marker survives until the next connect)."""
    try:
        return paths.inspect_marker().exists()
    except OSError:
        return False


def is_reusable_new_tab_page(t):
    """The browser's own New Tab Page, ex: from a fresh launch"""
    return t["type"] == "page" and t.get("url", "").startswith(
        ("chrome://newtab", "chrome://new-tab-page", "edge://newtab", "about:newtab")
    )


class _PatientCDPClient(CDPClient):
    """CDPClient with the WS opening handshake stretched to LOCAL_HANDSHAKE_TIMEOUT."""

    async def start(self):
        import websockets

        if self.ws is not None:
            raise RuntimeError("Client is already started")
        connect_kwargs = {
            "max_size": self.max_ws_frame_size,
            "open_timeout": LOCAL_HANDSHAKE_TIMEOUT,
        }
        if self.additional_headers:
            connect_kwargs["additional_headers"] = self.additional_headers
        self.ws = await websockets.connect(self.url, **connect_kwargs)
        self._message_handler_task = asyncio.create_task(self._handle_messages())


class Daemon:
    def __init__(self):
        self.cdp: Any = None
        self.session = None
        self.target_id = None
        self.dedicated_target_id = None
        self._dedicated_target_lock = asyncio.Lock()
        self._session_state_lock = asyncio.Lock()
        self._session_replacements = {}
        self.events = deque(maxlen=BUF)
        self.dialog = None
        self.stop: Any = None  # asyncio.Event, set inside start()

        # Managed mode deliberately lives beside the upstream daemon rather
        # than replacing it.  The fields below are inert for the normal
        # browser-harness path and form one session-scoped target lease for the
        # package controller.
        self.managed = ipc.managed_mode()
        self._managed_control_token = os.environ.get("BH_MANAGED_CONTROL_TOKEN")
        self._managed_lease_lock = asyncio.Lock()
        self.lease = None
        self.root_target_id = None
        self.owned_target_ids = set()
        self._managed_target_infos = {}
        self._managed_root_created = False
        self._managed_session_targets = {}

    def _validate_managed_startup(self):
        if ipc.managed_socket_path() is None:
            raise ManagedModeError(
                "managed_socket_required",
                "managed mode requires an absolute BH_MANAGED_SOCKET",
            )
        self._managed_control_token = self._managed_control_token or os.environ.get(
            "BH_MANAGED_CONTROL_TOKEN"
        )
        if not self._managed_control_token:
            raise ManagedModeError(
                "managed_control_token_required",
                "managed mode requires BH_MANAGED_CONTROL_TOKEN",
            )
        has_ws = bool(os.environ.get("BU_CDP_WS"))
        has_url = bool(os.environ.get("BU_CDP_URL"))
        if has_ws == has_url:
            raise ManagedModeError(
                "managed_endpoint_required",
                "managed mode requires exactly one of BU_CDP_URL or BU_CDP_WS",
            )
        if os.environ.get("BU_BROWSER_ID"):
            raise ManagedModeError(
                "managed_cloud_disabled",
                "managed mode cannot use a Browser Use cloud browser",
            )

    async def _managed_target_infos_from_cdp(self):
        if self.cdp is None:
            raise ManagedModeError(
                "managed_cdp_unavailable", "managed daemon is not connected to CDP"
            )
        response = await self.cdp.send_raw("Target.getTargets")
        if not isinstance(response, dict):
            raise ManagedModeError(
                "managed_cdp_protocol_error", "Target.getTargets returned a non-object"
            )
        infos = response.get("targetInfos")
        if not isinstance(infos, list):
            raise ManagedModeError(
                "managed_cdp_protocol_error",
                "Target.getTargets returned no targetInfos list",
            )
        return [info for info in infos if isinstance(info, dict)]

    @staticmethod
    def _managed_related_parent_ids(info):
        """Return target-level parent links usable for managed ownership.

        ``parentId`` is emitted by modern CDP TargetInfo for iframe/worker
        targets and identifies the parent target directly.  ``parentFrameId``
        is only a frame id and has no target owner in TargetInfo; it is
        intentionally not used as an ownership signal because guessing from
        it could expose an unrelated user's iframe.
        """
        if not isinstance(info, dict):
            return ()
        parents = []
        for key in ("openerId", "parentId"):
            parent_id = info.get(key)
            if isinstance(parent_id, str) and parent_id:
                parents.append(parent_id)
        return tuple(parents)

    @classmethod
    def _managed_owned_tree(cls, root_target_id, infos):
        """Return root plus every transitive opener/parent descendant."""
        by_id = {
            info.get("targetId"): info
            for info in infos
            if isinstance(info.get("targetId"), str)
        }
        owned = {root_target_id}
        changed = True
        while changed:
            changed = False
            for target_id, info in by_id.items():
                if target_id in owned:
                    continue
                if any(
                    parent_id in owned
                    for parent_id in cls._managed_related_parent_ids(info)
                ):
                    owned.add(target_id)
                    changed = True
        return owned

    def _managed_event_target_ids(self, params, session_id):
        """Find target identities carried by a CDP event without trusting its text."""
        target_ids = set()
        if isinstance(session_id, str):
            mapped_target_id = self._managed_session_targets.get(session_id)
            if isinstance(mapped_target_id, str):
                target_ids.add(mapped_target_id)
            if session_id == self.session and isinstance(self.target_id, str):
                target_ids.add(self.target_id)
        if not isinstance(params, dict):
            return target_ids
        target_id = params.get("targetId")
        if isinstance(target_id, str):
            target_ids.add(target_id)
        event_session_id = params.get("sessionId")
        if isinstance(event_session_id, str):
            mapped_target_id = self._managed_session_targets.get(event_session_id)
            if isinstance(mapped_target_id, str):
                target_ids.add(mapped_target_id)
        info = params.get("targetInfo")
        if isinstance(info, dict):
            target_id = info.get("targetId")
            if isinstance(target_id, str):
                target_ids.add(target_id)
        return target_ids

    def _managed_event_is_owned(self, method, params, session_id):
        """Whether an event may enter the managed agent-visible event buffer."""
        if not self.managed:
            return True
        if method == "Target.targetCreated":
            info = params.get("targetInfo") if isinstance(params, dict) else None
            target_id = info.get("targetId") if isinstance(info, dict) else None
            if not isinstance(target_id, str):
                return False
            owned = target_id in self.owned_target_ids or any(
                parent_id in self.owned_target_ids
                for parent_id in self._managed_related_parent_ids(info)
            )
            if owned:
                # Cache the event's exact info so release can still close this
                # target if discovery is temporarily unavailable.
                self.owned_target_ids.add(target_id)
                self._managed_target_infos[target_id] = info
            return owned
        explicit_target_ids = set()
        if isinstance(params, dict):
            target_id = params.get("targetId")
            if isinstance(target_id, str):
                explicit_target_ids.add(target_id)
            info = params.get("targetInfo")
            if isinstance(info, dict):
                target_id = info.get("targetId")
                if isinstance(target_id, str):
                    explicit_target_ids.add(target_id)
        if explicit_target_ids:
            # If an event names a target explicitly, every such identity must
            # be owned. Do not let an owned session id mask a user target id.
            return explicit_target_ids <= self.owned_target_ids
        return bool(
            self._managed_event_target_ids(params, session_id) & self.owned_target_ids
        )

    def _record_event(self, method, params, session_id, mark_js):
        """Buffer only events attributable to this daemon's managed targets."""
        if not self._managed_event_is_owned(method, params, session_id):
            return False
        self.events.append(
            {"method": method, "params": params, "session_id": session_id}
        )
        if method == "Page.javascriptDialogOpening":
            self.dialog = params
        elif method == "Page.javascriptDialogClosed":
            self.dialog = None
        elif method in ("Page.loadEventFired", "Page.domContentEventFired") and (
            session_id or self.session
        ):
            marker_session = (
                session_id or self.session if self.managed else self.session
            )
            asyncio.create_task(
                _silent(
                    asyncio.wait_for(
                        self.cdp.send_raw(
                            "Runtime.evaluate",
                            {"expression": mark_js},
                            session_id=marker_session,
                        ),
                        timeout=2,
                    )
                )
            )
        elif self.managed and method == "Target.targetCreated":
            # _managed_event_is_owned() records the target and its parent link.
            pass
        elif self.managed and method == "Target.attachedToTarget":
            info = params.get("targetInfo") if isinstance(params, dict) else None
            target_id = info.get("targetId") if isinstance(info, dict) else None
            attached_session = (
                params.get("sessionId") if isinstance(params, dict) else None
            )
            if (
                isinstance(target_id, str)
                and target_id in self.owned_target_ids
                and isinstance(attached_session, str)
            ):
                self._managed_session_targets[attached_session] = target_id
        elif self.managed and method == "Target.targetInfoChanged":
            info = params.get("targetInfo") if isinstance(params, dict) else None
            target_id = info.get("targetId") if isinstance(info, dict) else None
            if isinstance(target_id, str) and target_id in self.owned_target_ids:
                self._managed_target_infos[target_id] = info
        elif self.managed and method == "Target.targetDestroyed":
            for target_id in self._managed_event_target_ids(params, session_id):
                self.owned_target_ids.discard(target_id)
                self._managed_target_infos.pop(target_id, None)
                for attached_session, mapped_target_id in list(
                    self._managed_session_targets.items()
                ):
                    if mapped_target_id == target_id:
                        self._managed_session_targets.pop(attached_session, None)
        elif self.managed and method == "Target.detachedFromTarget":
            detached_session = (
                params.get("sessionId") if isinstance(params, dict) else None
            )
            if isinstance(detached_session, str):
                self._managed_session_targets.pop(detached_session, None)
        return True

    async def _refresh_managed_ownership(self, infos=None):
        if self.lease is None:
            self._managed_target_infos = {}
            self.owned_target_ids = set()
            return []
        infos = await self._managed_target_infos_from_cdp() if infos is None else infos
        self._managed_target_infos = {
            info.get("targetId"): info
            for info in infos
            if isinstance(info.get("targetId"), str)
        }
        self.owned_target_ids = self._managed_owned_tree(
            self.lease.root_target_id, infos
        )
        return infos

    @staticmethod
    def _managed_marker_url(marker):
        return f"about:blank#{quote(marker, safe='A-Za-z0-9._~-')}"

    @staticmethod
    def _managed_target_has_marker(info, marker):
        if not isinstance(info, dict) or not isinstance(marker, str):
            return False
        raw_url = str(info.get("url") or "")
        fragment = urlparse(raw_url).fragment
        return unquote(fragment) == marker

    @staticmethod
    def _managed_payload(lease, owned_target_ids):
        return {
            "leaseId": lease.lease_id,
            "rootTargetId": lease.root_target_id,
            "ownedTargetIds": sorted(owned_target_ids),
            "mode": lease.mode,
        }

    async def _managed_is_owned(self, target_id):
        if self.lease is None or not isinstance(target_id, str) or not target_id:
            return False
        await self._refresh_managed_ownership()
        return (
            target_id in self.owned_target_ids
            and target_id in self._managed_target_infos
        )

    async def _managed_attach_exact(self, target_id):
        if self.cdp is None:
            raise ManagedModeError(
                "managed_cdp_unavailable", "managed daemon is not connected to CDP"
            )
        result = await self.cdp.send_raw(
            "Target.attachToTarget", {"targetId": target_id, "flatten": True}
        )
        session_id = result.get("sessionId") if isinstance(result, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise ManagedModeError(
                "managed_attach_failed",
                f"CDP did not return a session for exact target {target_id}",
            )
        return session_id

    async def _managed_acquire_root(self, request):
        mode = request.get("mode")
        marker = request.get("marker")
        profile = request.get("profile")
        target_id = request.get("targetId")
        if not isinstance(mode, str) or mode not in MANAGED_MODES:
            raise ManagedModeError(
                "managed_invalid_mode",
                f"mode must be one of {sorted(MANAGED_MODES)}",
            )
        if not isinstance(marker, str) or not _MANAGED_MARKER_RE.fullmatch(marker):
            raise ManagedModeError(
                "managed_invalid_marker",
                "marker must be 1-160 ASCII unreserved characters [A-Za-z0-9._~-]",
            )
        if profile is not None and not isinstance(profile, (str, dict)):
            raise ManagedModeError(
                "managed_invalid_profile", "profile must be text, object, or null"
            )

        async with self._managed_lease_lock:
            if self.lease is not None:
                same_request = (
                    self.lease.mode == mode
                    and self.lease.marker == marker
                    and self.lease.profile == profile
                    and (target_id is None or target_id == self.lease.root_target_id)
                )
                if not same_request:
                    raise ManagedModeError(
                        "managed_lease_active",
                        "a different managed root lease is already active",
                        {"leaseId": self.lease.lease_id, "mode": self.lease.mode},
                    )
                await self._refresh_managed_ownership()
                if self.lease.root_target_id not in self._managed_target_infos:
                    raise ManagedModeError(
                        "managed_root_missing",
                        "the leased root target disappeared; release and acquire again",
                        {"rootTargetId": self.lease.root_target_id},
                    )
                return self._managed_payload(self.lease, self.owned_target_ids)

            infos = await self._managed_target_infos_from_cdp()
            by_id = {
                info.get("targetId"): info
                for info in infos
                if isinstance(info.get("targetId"), str)
            }
            created = False
            if target_id is not None:
                if not isinstance(target_id, str) or not target_id:
                    raise ManagedModeError(
                        "managed_invalid_target", "targetId must be non-empty text"
                    )
                root = by_id.get(target_id)
                if root is None:
                    raise ManagedModeError(
                        "managed_root_target_not_found",
                        f"the exact root target {target_id} does not exist",
                        {"targetId": target_id},
                    )
                if root.get("type") != "page":
                    raise ManagedModeError(
                        "managed_root_target_invalid",
                        "the managed root target must be a page",
                        {"targetId": target_id, "type": root.get("type")},
                    )
                if not self._managed_target_has_marker(root, marker):
                    raise ManagedModeError(
                        "managed_root_marker_mismatch",
                        "the exact root target does not carry the requested marker",
                        {"targetId": target_id},
                    )
                root_target_id = target_id
            else:
                candidates = [
                    info
                    for info in infos
                    if info.get("type") == "page"
                    and self._managed_target_has_marker(info, marker)
                ]
                if len(candidates) > 1:
                    raise ManagedModeError(
                        "managed_root_ambiguous",
                        "more than one page carries the requested root marker",
                        {"marker": marker},
                    )
                if candidates:
                    root_target_id = candidates[0]["targetId"]
                else:
                    result = await self.cdp.send_raw(
                        "Target.createTarget",
                        {
                            "url": self._managed_marker_url(marker),
                            "background": True,
                        },
                    )
                    root_target_id = (
                        result.get("targetId") if isinstance(result, dict) else None
                    )
                    if not isinstance(root_target_id, str) or not root_target_id:
                        raise ManagedModeError(
                            "managed_root_create_failed",
                            "CDP did not return the created root target id",
                        )
                    created = True

            try:
                session_id = await self._managed_attach_exact(root_target_id)
            except Exception:
                if created:
                    try:
                        await self.cdp.send_raw(
                            "Target.closeTarget", {"targetId": root_target_id}
                        )
                    except Exception as error:
                        _ = error
                raise

            self.lease = ManagedLease(
                lease_id=str(uuid.uuid4()),
                mode=mode,
                profile=profile,
                marker=marker,
                root_target_id=root_target_id,
            )
            self.root_target_id = root_target_id
            self.target_id = root_target_id
            self.session = session_id
            self._managed_root_created = created
            self._managed_session_targets = {session_id: root_target_id}
            await self._refresh_managed_ownership()
            await self._enable_default_domains(session_id)
            return self._managed_payload(self.lease, self.owned_target_ids)

    async def _managed_release_root(self):
        async with self._managed_lease_lock:
            lease = self.lease
            if lease is None:
                return {"released": False, "leaseId": None, "closedTargetIds": []}
            cached_owned_target_ids = set(self.owned_target_ids)
            cached_target_infos = dict(self._managed_target_infos)
            target_inventory_available = True
            try:
                infos = await self._managed_target_infos_from_cdp()
            except Exception:
                infos = []
                target_inventory_available = False
            if target_inventory_available:
                await self._refresh_managed_ownership(infos)
                by_id = self._managed_target_infos
                target_ids = [
                    target_id
                    for target_id in self.owned_target_ids
                    if target_id in by_id
                ]
            else:
                # Keep the ownership and target-info snapshots from before the
                # failed discovery. Calling _refresh_managed_ownership([])
                # here would erase opener/parent descendants and leak them on
                # release.
                by_id = cached_target_infos
                target_ids = sorted(cached_owned_target_ids)
            if self._managed_root_created and lease.root_target_id not in target_ids:
                # Target.createTarget returned this exact id even if Chrome has
                # not published it in a subsequent inventory response yet.
                target_ids.append(lease.root_target_id)

            def depth(target_id):
                value = 0
                seen = set()
                frontier = [target_id]
                while frontier:
                    parents = []
                    for current_id in frontier:
                        current = by_id.get(current_id)
                        for parent in self._managed_related_parent_ids(current):
                            if parent in by_id and parent not in seen:
                                seen.add(parent)
                                parents.append(parent)
                    if not parents:
                        break
                    value += 1
                    frontier = parents
                return value

            closed = []
            errors = []
            for target_id in sorted(
                target_ids, key=lambda target_id: (-depth(target_id), target_id)
            ):
                try:
                    await self.cdp.send_raw(
                        "Target.closeTarget", {"targetId": target_id}
                    )
                    closed.append(target_id)
                except Exception as error:
                    errors.append({"targetId": target_id, "message": str(error)})

            self.lease = None
            self.root_target_id = None
            self.owned_target_ids = set()
            self._managed_target_infos = {}
            self._managed_root_created = False
            self._managed_session_targets = {}
            self.session = None
            self.target_id = None
            data = {
                "released": True,
                "leaseId": lease.lease_id,
                "closedTargetIds": closed,
            }
            if errors:
                data["closeErrors"] = errors
            return data

    async def _managed_status_data(self, refresh=True):
        if refresh and self.lease is not None:
            try:
                await self._refresh_managed_ownership()
            except Exception as error:
                _ = error
        root_present = bool(
            self.lease and self.lease.root_target_id in self._managed_target_infos
        )
        return {
            "managed": True,
            "connected": self.cdp is not None,
            "active": root_present,
            "leaseId": self.lease.lease_id if self.lease else None,
            "rootTargetId": self.lease.root_target_id if self.lease else None,
            "ownedTargetIds": sorted(self.owned_target_ids),
            "mode": self.lease.mode if self.lease else None,
            "currentTargetId": self.target_id,
        }

    async def _managed_health(self):
        if self.cdp is None:
            return _managed_control_error(
                "managed_cdp_unavailable", "managed daemon is not connected to CDP"
            )
        try:
            infos = await self._managed_target_infos_from_cdp()
        except Exception as error:
            return _managed_control_error(
                "managed_cdp_unavailable", f"CDP health check failed: {error}"
            )
        if self.lease is not None:
            await self._refresh_managed_ownership(infos)
        data = await self._managed_status_data(refresh=False)
        data["ready"] = True
        data["targetCount"] = len(infos)
        return _managed_control_ok(data)

    @staticmethod
    def _managed_release_control_response(released):
        close_errors = (
            released.get("closeErrors") if isinstance(released, dict) else None
        )
        if close_errors:
            return _managed_control_error(
                "managed_release_incomplete",
                "one or more managed targets could not be closed",
                {
                    "leaseId": released.get("leaseId"),
                    "closedTargetIds": released.get("closedTargetIds", []),
                    "failedTargetIds": [
                        error.get("targetId")
                        for error in close_errors
                        if isinstance(error, dict) and error.get("targetId")
                    ],
                    "closeErrors": close_errors,
                },
            )
        return _managed_control_ok(released)

    async def _handle_managed_control(self, request):
        expected = self._managed_control_token or os.environ.get(
            "BH_MANAGED_CONTROL_TOKEN"
        )
        provided = request.get("token")
        if not expected or not isinstance(provided, str):
            return _managed_control_error(
                "managed_control_unauthorized", "managed control token is invalid"
            )
        if not hmac.compare_digest(provided, expected):
            return _managed_control_error(
                "managed_control_unauthorized", "managed control token is invalid"
            )
        action = request.get("action")
        try:
            if action == "health":
                return await self._managed_health()
            if action == "acquire-root":
                return _managed_control_ok(await self._managed_acquire_root(request))
            if action == "release-root":
                return self._managed_release_control_response(
                    await self._managed_release_root()
                )
            if action == "status":
                return _managed_control_ok(await self._managed_status_data())
            if action == "shutdown":
                try:
                    released = await self._managed_release_root()
                finally:
                    if self.stop is None:
                        self.stop = asyncio.Event()
                    self.stop.set()
                release_response = self._managed_release_control_response(released)
                if not release_response["ok"]:
                    return release_response
                return _managed_control_ok({"shutdown": True, "release": released})
            return _managed_control_error(
                "managed_unknown_action",
                "action must be health, acquire-root, release-root, status, or shutdown",
            )
        except ManagedModeError as error:
            return _managed_control_error(error.code, error.message, error.details)
        except Exception as error:
            log(f"managed control {action!r} failed: {error}")
            return _managed_control_error("managed_control_failed", str(error))

    async def _managed_current_tab(self):
        if self.lease is None:
            return _managed_error(
                "managed_no_active_lease", "acquire a managed root lease first"
            )
        if not await self._managed_is_owned(self.target_id):
            return _managed_error(
                "managed_target_missing", "the current owned target no longer exists"
            )
        try:
            info = await self.cdp.send_raw(
                "Target.getTargetInfo", {"targetId": self.target_id}
            )
        except Exception as error:
            return _managed_error("managed_cdp_error", str(error))
        target_info = info.get("targetInfo") if isinstance(info, dict) else None
        if not isinstance(target_info, dict):
            return _managed_error(
                "managed_cdp_protocol_error",
                "Target.getTargetInfo returned no targetInfo",
            )
        return {
            "targetId": target_info.get("targetId"),
            "url": target_info.get("url", ""),
            "title": target_info.get("title", ""),
        }

    async def _managed_set_session(self, request):
        if self.lease is None:
            return _managed_error(
                "managed_no_active_lease", "acquire a managed root lease first"
            )
        session_id = request.get("session_id")
        target_id = request.get("target_id") or self.target_id
        if not isinstance(session_id, str) or not session_id:
            return _managed_error(
                "managed_invalid_session", "session_id must be non-empty text"
            )
        if self._managed_session_targets.get(session_id) != target_id:
            return _managed_error(
                "managed_session_not_owned",
                "set_session may only select a daemon-attached session for the same owned target",
                {"sessionId": session_id, "targetId": target_id},
            )
        if not await self._managed_is_owned(target_id):
            return _managed_error(
                "managed_target_not_owned",
                "set_session may only select an owned target",
                {"targetId": target_id},
            )
        async with self._session_state_lock:
            old_session = self.session
            self.session = session_id
            self.target_id = target_id
            self._managed_session_targets[session_id] = target_id
        tasks = []
        if old_session and old_session != session_id:

            async def disable_old():
                try:
                    await asyncio.wait_for(
                        self.cdp.send_raw("Network.disable", session_id=old_session),
                        timeout=2,
                    )
                except Exception as error:
                    _ = error

            tasks.append(disable_old())
        tasks.append(self._enable_default_domains(session_id))
        await asyncio.gather(*tasks)
        return {"session_id": session_id}

    async def _handle_managed_cdp(self, request):
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(method, str) or not method:
            return _managed_error("managed_invalid_method", "method is required")
        if not isinstance(params, dict):
            return _managed_error(
                "managed_invalid_params", "params must be a JSON object"
            )
        if method in _MANAGED_DENIED_METHODS:
            return _managed_error(
                "managed_target_lifecycle_denied",
                f"{method} is controlled by the extension lifecycle channel",
            )
        if self.lease is None:
            return _managed_error(
                "managed_no_active_lease", "acquire a managed root lease first"
            )

        if method == "Target.getTargets":
            try:
                infos = await self._managed_target_infos_from_cdp()
                await self._refresh_managed_ownership(infos)
            except ManagedModeError as error:
                return _managed_error(error.code, error.message, error.details)
            return {
                "result": {
                    "targetInfos": [
                        info
                        for info in infos
                        if info.get("targetId") in self.owned_target_ids
                    ]
                }
            }

        if method == "Target.getTargetInfo":
            target_id = params.get("targetId") if isinstance(params, dict) else None
            if not await self._managed_is_owned(target_id):
                return _managed_error(
                    "managed_target_not_owned",
                    "Target.getTargetInfo may only inspect an owned target",
                    {"targetId": target_id},
                )

        if method in {"Target.attachToTarget", "Target.activateTarget"}:
            target_id = params.get("targetId") if isinstance(params, dict) else None
            if not await self._managed_is_owned(target_id):
                return _managed_error(
                    "managed_target_not_owned",
                    f"{method} may only use an owned target",
                    {"targetId": target_id},
                )
        if (
            "targetId" in params
            and not method.startswith("Target.")
            and not await self._managed_is_owned(params.get("targetId"))
        ):
            return _managed_error(
                "managed_target_not_owned",
                "a targetId may only reference an owned target",
                {"targetId": params.get("targetId")},
            )

        session_id = request.get("session_id") or self.session
        if method.startswith("Target."):
            session_id = None
        elif session_id not in self._managed_session_targets:
            return _managed_error(
                "managed_session_not_owned",
                "the requested CDP session is not attached to an owned target",
            )
        try:
            response = await self.cdp.send_raw(method, params, session_id=session_id)
            if method == "Target.attachToTarget" and isinstance(response, dict):
                attached_session = response.get("sessionId")
                target_id = params.get("targetId")
                if isinstance(attached_session, str) and isinstance(target_id, str):
                    self._managed_session_targets[attached_session] = target_id
            return {"result": response}
        except Exception as error:
            message = str(error)
            # Unlike upstream, managed mode never re-attaches or retries a
            # stale session.  The controller can report the failure directly.
            if "Session with given id not found" in message:
                return _managed_error(
                    "managed_stale_session",
                    "the managed CDP session is stale; no automatic recovery was attempted",
                )
            return _managed_error("managed_cdp_error", message)

    async def _handle_managed(self, request):
        if request.get("meta") == "managed_control":
            return await self._handle_managed_control(request)
        meta = request.get("meta")
        if meta == "ping":
            return {"pong": True, "pid": os.getpid(), "browser_kind": "cdp"}
        if meta == "managed_status":
            return await self._managed_status_data()
        if meta == "drain_events":
            out = list(self.events)
            self.events.clear()
            return {"events": out}
        if meta == "session":
            if self.lease is None:
                return _managed_error(
                    "managed_no_active_lease", "acquire a managed root lease first"
                )
            return {"session_id": self.session}
        if meta == "current_tab":
            return await self._managed_current_tab()
        if meta == "connection_status":
            current = await self._managed_current_tab()
            if "error" in current:
                return current
            return {
                "target_id": current["targetId"],
                "session_id": self.session,
                "page": current,
            }
        if meta == "set_session":
            return await self._managed_set_session(request)
        if meta == "pending_dialog":
            return {"dialog": self.dialog}
        if meta in {"shutdown", "retain-root", "release-root", "acquire-root"}:
            return _managed_error(
                "managed_control_required",
                "lifecycle actions require the privileged managed control channel",
            )
        return await self._handle_managed_cdp(request)

    async def attach_first_page(self, replaces_session=None, enable_domains=True):
        if self.managed:
            raise ManagedModeError(
                "managed_exact_attach_required",
                "managed mode attaches only the extension-selected root via acquire-root",
            )
        """Attach to a real page (or any page). Sets self.session. Returns attached target or None."""
        targets = (await self.cdp.send_raw("Target.getTargets"))["targetInfos"]
        # Named daemons (BU_NAME != "default") share one browser with other
        # daemons — attaching to the first page makes parallel daemons fight
        # over a single tab (navigations clobber each other). Give each named
        # daemon its own dedicated tab instead. REMOTE_ID (cloud) browsers are
        # already exclusive to this daemon, so first-page attach stays.
        if NAME != "default" and not REMOTE_ID:
            # The permission recovery flow can leave chrome://inspect open.
            # Clean it up before returning from this early path as well.
            if BROWSER_KIND == "local":
                await self._close_inspect_tabs(targets)
            pages_by_id = {t["targetId"]: t for t in targets if t["type"] == "page"}
            # A stale CDP session does not necessarily mean its tab disappeared.
            # Reattach to the current tab first, then the daemon's dedicated tab.
            page = pages_by_id.get(self.target_id) or pages_by_id.get(
                self.dedicated_target_id
            )
            if page is None:
                # Two stale IPC requests can recover concurrently. Recheck
                # inside a narrow lock so they share one replacement tab.
                async with self._dedicated_target_lock:
                    refreshed = (await self.cdp.send_raw("Target.getTargets"))[
                        "targetInfos"
                    ]
                    pages_by_id = {
                        t["targetId"]: t for t in refreshed if t["type"] == "page"
                    }
                    page = pages_by_id.get(self.target_id) or pages_by_id.get(
                        self.dedicated_target_id
                    )
                    if page is None:
                        tid = (
                            await self.cdp.send_raw(
                                "Target.createTarget",
                                {"url": "about:blank", "background": True},
                            )
                        )["targetId"]
                        self.dedicated_target_id = tid
                        log(f"named daemon {NAME}: created dedicated tab ({tid})")
                        page = {"targetId": tid, "url": "about:blank", "type": "page"}
            tid = page["targetId"]
            self.session = (
                await self.cdp.send_raw(
                    "Target.attachToTarget", {"targetId": tid, "flatten": True}
                )
            )["sessionId"]
            self._record_session_replacement(replaces_session, self.session)
            self.target_id = tid
            log(f"attached {tid} ({page.get('url', '')[:80]}) session={self.session}")
            if enable_domains:
                await self._enable_default_domains(self.session)
            return page

        pages = [t for t in targets if is_real_page(t)]
        if not pages:
            # Fresh browser (ex: BU cloud) starts w about:blank; reuse it
            pages = [t for t in targets if is_reusable_blank_page(t)]
        if not pages:
            # Freshly launched browser (ex: harness relaunching closed Chrome)
            # starts with just the New Tab Page. Reuse it — creating about:blank
            pages = [t for t in targets if is_reusable_new_tab_page(t)]
        take_over = None
        if not pages and harness_opened_inspect():
            # After perms granted, only tab is often chrome://inspect
            # Attach to it instead of creating a new about:blank
            inspect_tabs = [t for t in targets if is_inspect_tab(t)]
            if inspect_tabs:
                pages = [inspect_tabs[0]]
                take_over = inspect_tabs[0]["targetId"]
        if not pages:
            # No usable pages - create one instead of attaching to omnibox popup.
            tid = (
                await self.cdp.send_raw(
                    "Target.createTarget", {"url": "about:blank", "background": True}
                )
            )["targetId"]
            log(f"no real pages found, created about:blank ({tid})")
            pages = [{"targetId": tid, "url": "about:blank", "type": "page"}]
        self.session = (
            await self.cdp.send_raw(
                "Target.attachToTarget",
                {"targetId": pages[0]["targetId"], "flatten": True},
            )
        )["sessionId"]
        self._record_session_replacement(replaces_session, self.session)
        self.target_id = pages[0]["targetId"]
        log(
            f"attached {pages[0]['targetId']} ({pages[0].get('url', '')[:80]}) session={self.session}"
        )
        if take_over:
            try:
                await self.cdp.send_raw(
                    "Page.navigate", {"url": "about:blank"}, session_id=self.session
                )
                log(f"took over inspect tab {take_over} -> about:blank")
            except Exception as e:
                log(f"take over inspect tab {take_over}: {e}")
        if BROWSER_KIND == "local":
            await self._close_inspect_tabs(targets)
        if enable_domains:
            await self._enable_default_domains(self.session)
        return pages[0]

    async def _close_inspect_tabs(self, targets):
        """Close chrome://inspect tabs left open by the permission recovery flow"""
        if not harness_opened_inspect():
            return
        for t in targets:
            if t["targetId"] != self.target_id and is_inspect_tab(t):
                try:
                    await self.cdp.send_raw(
                        "Target.closeTarget", {"targetId": t["targetId"]}
                    )
                    log(f"closed leftover chrome://inspect tab {t['targetId']}")
                except Exception as e:
                    log(f"close inspect tab {t['targetId']}: {e}")
        try:
            paths.inspect_marker().unlink()
        except OSError as error:
            _ = error

    async def _enable_default_domains(self, session_id):
        """Enable Page/DOM/Runtime/Network on a CDP session.

        Used by both initial attach and set_session (called after switch_tab/
        new_tab). Without this, helpers that depend on Network.* events —
        notably wait_for_network_idle() — silently stop receiving events
        after a tab switch, because each fresh CDP session starts with all
        domains disabled.

        Runs the four enables in parallel via gather so the worst-case time is
        bounded by a single CDP round trip rather than four sequential ones —
        important on the set_session path, where the helper's IPC socket has
        a 5s read timeout.
        """

        async def enable_one(d):
            try:
                await asyncio.wait_for(
                    self.cdp.send_raw(f"{d}.enable", session_id=session_id),
                    timeout=4,
                )
            except Exception as e:
                log(f"enable {d} on {session_id}: {e}")

        await asyncio.gather(
            *(enable_one(d) for d in ("Page", "DOM", "Runtime", "Network"))
        )

    def _record_session_replacement(self, stale_session, replacement_session):
        """Remember which recovered session still controls the same tab."""
        if (
            not stale_session
            or not replacement_session
            or stale_session == replacement_session
        ):
            return
        # Preserve chains so requests delayed across multiple recoveries still
        # land on their original tab, never whichever tab is current now.
        for source, replacement in list(self._session_replacements.items()):
            if replacement == stale_session:
                self._session_replacements[source] = replacement_session
        self._session_replacements[stale_session] = replacement_session
        while len(self._session_replacements) > 32:
            self._session_replacements.pop(next(iter(self._session_replacements)))

    async def start(self):
        self.stop = asyncio.Event()
        if self.managed:
            self._validate_managed_startup()
        url = get_ws_url()
        log(f"connecting to {url}")
        self.cdp = _PatientCDPClient(url) if BROWSER_KIND == "local" else CDPClient(url)
        if BROWSER_KIND == "local":
            # Allow while this handshake is still parked on the popup
            log(
                "handshake-wait: if Chrome shows an 'Allow remote debugging?' popup, click Allow"
            )
        try:
            await self.cdp.start()
        except Exception as error:
            self._raise_cdp_start_error(error)
        # Normal browser-harness keeps its upstream first-page attach.  A
        # managed daemon must stay unattached until the privileged controller
        # supplies the exact extension-created root marker/target.
        if not self.managed:
            await self.attach_first_page()
        event_registry = getattr(self.cdp, "_event_registry", None)
        if event_registry is None:
            return
        orig = event_registry.handle_event
        mark_js = "if(!document.title.startsWith('\U0001f434'))document.title='\U0001f434 '+document.title"

        async def tap(method, params, session_id=None):
            self._record_event(method, params, session_id, mark_js)
            return await orig(method, params, session_id)

        event_registry.handle_event = tap

    def _raise_cdp_start_error(self, error):
        """Raise the direct startup error without any recovery branch."""
        if self.managed:
            raise ManagedModeError(
                "managed_cdp_unavailable",
                f"managed CDP WebSocket handshake failed: {error}",
            ) from error
        if os.environ.get("BU_CDP_WS"):
            raise RuntimeError(
                f"CDP WS handshake failed: {error} -- remote browser WebSocket connection failed. "
                "This can happen when network policy blocks the connection, the WS URL is wrong or expired, or the remote endpoint is down. "
                "If you use Browser Use cloud, verify auth and get a fresh URL via start_remote_daemon()."
            ) from error
        if (
            BROWSER_KIND == "local"
            and ("timed out" in str(error).lower() or "403" in str(error))
            and remote_debugging_user_enabled()
        ):
            raise RuntimeError(
                f"permission-blocked: Chrome's 'Allow remote debugging?' popup was not accepted within {LOCAL_HANDSHAKE_TIMEOUT}s"
                " -- wait for the user to click Allow, then retry"
            ) from error
        raise RuntimeError(
            f"CDP WS handshake failed: {error} -- click Allow in Chrome if prompted, then retry"
        ) from error

    async def handle(self, req):
        if not isinstance(req, dict):
            if self.managed:
                return _managed_error(
                    "managed_invalid_request", "request must be a JSON object"
                )
            return {"error": "request must be a JSON object"}
        # Token guard for Windows TCP loopback: any local process can otherwise
        # connect and issue CDP commands. expected_token() is None on POSIX so
        # this check is a no-op there (AF_UNIX + chmod 600 is the boundary).
        expected = ipc.expected_token()
        if expected is not None and req.get("token") != expected:
            return {"error": "unauthorized"}
        if self.managed:
            return await self._handle_managed(req)
        meta = req.get("meta")
        # Liveness probe — lets clients confirm the listener is actually this
        # daemon and not an unrelated process that reused our port post-crash.
        # `pid` lets restart_daemon() verify the live daemon's identity before
        # signaling — protects against SIGTERM-by-stale-pid-file after PID reuse.
        if meta == "ping":
            return {"pong": True, "pid": os.getpid(), "browser_kind": BROWSER_KIND}
        if meta == "drain_events":
            out = list(self.events)
            self.events.clear()
            return {"events": out}
        if meta == "session":
            return {"session_id": self.session}
        if meta == "current_tab":
            # Resolve the attached page's target info server-side. Helpers can't
            # send Target.getTargetInfo themselves: daemon strips session_id for
            # any Target.* method (browser-level call), and without a targetId
            # Chrome silently returns the *browser* target.
            if not self.target_id:
                return {"error": "not_attached"}
            try:
                info = (
                    await self.cdp.send_raw(
                        "Target.getTargetInfo", {"targetId": self.target_id}
                    )
                )["targetInfo"]
            except Exception:
                return {"error": "cdp_disconnected"}
            return {
                "targetId": info.get("targetId"),
                "url": info.get("url", ""),
                "title": info.get("title", ""),
            }
        if meta == "connection_status":
            if not self.target_id:
                return {"error": "not_attached"}
            try:
                info = (
                    await self.cdp.send_raw(
                        "Target.getTargetInfo", {"targetId": self.target_id}
                    )
                )["targetInfo"]
            except Exception:
                return {"error": "cdp_disconnected"}
            page = None
            if is_real_page(info):
                page = {
                    "targetId": info.get("targetId"),
                    "title": info.get("title") or "(untitled)",
                    "url": info.get("url") or "",
                }
            return {
                "target_id": self.target_id,
                "session_id": self.session,
                "page": page,
            }
        if meta == "set_session":
            async with self._session_state_lock:
                old_session = self.session
                self.session = req.get("session_id")
                self.target_id = req.get("target_id") or self.target_id
                new_session = self.session
            # Run the old-session Network.disable (defense in depth — keeps
            # background-tab traffic out of the global event buffer; the
            # consumer-side filter in wait_for_network_idle is the actual
            # correctness gate) in parallel with the four enables on the new
            # session. Different sessions, independent CDP requests. Keeps
            # the synchronous reply under the helper's 5s IPC read timeout
            # even on a remote daemon — sequentially these would have stacked
            # to ~22s worst case.
            tasks = []
            if old_session and old_session != new_session:

                async def disable_old():
                    try:
                        await asyncio.wait_for(
                            self.cdp.send_raw(
                                "Network.disable", session_id=old_session
                            ),
                            timeout=2,
                        )
                    except Exception as error:
                        _ = error

                tasks.append(disable_old())
            tasks.append(self._enable_default_domains(new_session))
            await asyncio.gather(*tasks)
            # 🐴 tab-marker title prefix is purely cosmetic — fire-and-forget so
            # it doesn't add to the synchronous IPC budget.
            asyncio.create_task(
                _silent(
                    asyncio.wait_for(
                        self.cdp.send_raw(
                            "Runtime.evaluate",
                            {
                                "expression": "if(!document.title.startsWith('\U0001f434'))document.title='\U0001f434 '+document.title"
                            },
                            session_id=new_session,
                        ),
                        timeout=2,
                    )
                )
            )
            return {"session_id": new_session}
        if meta == "pending_dialog":
            return {"dialog": self.dialog}
        if meta == "shutdown":
            self.stop.set()
            return {"ok": True}

        method = req["method"]
        params = req.get("params") or {}
        # Browser-level Target.* calls must not use a session (stale or otherwise).
        # For everything else, explicit session in req wins; else default.
        sid = (
            None
            if method.startswith("Target.")
            else (req.get("session_id") or self.session)
        )
        try:
            return {"result": await self.cdp.send_raw(method, params, session_id=sid)}
        except Exception as e:
            msg = str(e)
            if "Session with given id not found" in msg:  # noqa: SIM102
                if sid:
                    # Explicit session callers asked for that exact session;
                    # do not silently redirect them to the current tab.
                    if req.get("session_id"):
                        return {"error": msg}
                    recovered_here = False
                    async with self._session_state_lock:
                        replacement_session = self._session_replacements.get(sid)
                        if replacement_session is None:  # noqa: SIM102
                            if sid == self.session:
                                log(f"stale session {sid}, re-attaching")
                                if not await self.attach_first_page(
                                    replaces_session=sid, enable_domains=False
                                ):
                                    return {"error": msg}
                                replacement_session = self._session_replacements.get(
                                    sid
                                )
                                recovered_here = replacement_session is not None
                    if recovered_here:
                        await self._enable_default_domains(replacement_session)
                    # Retry only on a session known to replace this exact stale
                    # session. self.session may instead have changed because the
                    # user deliberately switched tabs while this request waited.
                    if replacement_session:
                        try:
                            return {
                                "result": await self.cdp.send_raw(
                                    method, params, session_id=replacement_session
                                )
                            }
                        except Exception as retry_error:
                            return {"error": str(retry_error)}
            return {"error": msg}


async def serve(d):
    async def handler(reader, writer):
        try:
            line = await reader.readline()
            if not line:
                return
            resp = await d.handle(json.loads(line))
            writer.write((json.dumps(resp, default=str) + "\n").encode())
            await writer.drain()
        except Exception as e:
            log(f"conn: {e}")
            try:
                if d.managed:
                    response = _managed_control_error("managed_request_failed", str(e))
                else:
                    response = {"error": str(e)}
                writer.write((json.dumps(response) + "\n").encode())
                await writer.drain()
            except Exception as error:
                _ = error
        finally:
            writer.close()

    serve_task = asyncio.create_task(ipc.serve(NAME, handler))
    stop_task = asyncio.create_task(d.stop.wait())
    await asyncio.sleep(
        0.05
    )  # let serve() bind so sock_addr() resolves to the live endpoint
    log(
        f"listening on {ipc.sock_addr(NAME)} (name={NAME}, remote={REMOTE_ID or 'local'})"
    )
    try:
        await asyncio.wait({serve_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
        if serve_task.done():
            await serve_task  # surfaces a serve crash
    finally:
        for t in (serve_task, stop_task):
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception) as error:
                _ = error
        ipc.cleanup_endpoint(NAME)


async def main():
    d = Daemon()
    await d.start()
    await serve(d)


def already_running():
    # Ping handshake (not a bare connect) so a stale .port file + port reuse
    # after a daemon crash doesn't make us mistake an unrelated listener for ours.
    return ipc.ping(NAME, timeout=1.0)


if __name__ == "__main__":
    if already_running():
        print(f"daemon already running on {SOCK}", file=sys.stderr)
        sys.exit(0)
    Path(LOG).parent.mkdir(parents=True, exist_ok=True)
    Path(LOG).write_text("", encoding="utf-8")
    Path(PID).parent.mkdir(parents=True, exist_ok=True)
    Path(PID).write_text(str(os.getpid()), encoding="utf-8")
    try:
        asyncio.run(main())
    except KeyboardInterrupt as error:
        _ = error
    except ManagedModeError as error:
        log(f"fatal [{error.code}]: {error.message}")
        print(
            json.dumps(
                _managed_control_error(error.code, error.message, error.details)
            ),
            file=sys.stderr,
            flush=True,
        )
        sys.exit(1)
    except Exception as error:
        log(f"fatal: {error}")
        if ipc.managed_mode():
            print(
                json.dumps(_managed_control_error("managed_daemon_failed", str(error))),
                file=sys.stderr,
                flush=True,
            )
        else:
            print(f"browser-harness daemon: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
    finally:
        stop_remote()
        try:
            os.unlink(PID)
        except FileNotFoundError as error:
            _ = error
