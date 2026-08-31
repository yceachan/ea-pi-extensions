"""Fake-CDP regression coverage for the managed target lease boundary."""

import asyncio
import contextlib
import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from browser_harness import daemon, helpers

CONTROL_TOKEN = "x" * 48


class FakeCDP:
    def __init__(self, targets=None):
        self.targets = list(targets or [])
        self.calls = []
        self.created = 0
        self.stale_methods = set()
        self.fail_get_targets = False
        self.fail_close_target_ids = set()

    async def send_raw(self, method, params=None, session_id=None):
        params = params or {}
        self.calls.append((method, params, session_id))
        if method in self.stale_methods:
            raise RuntimeError("Session with given id not found")
        if method == "Target.getTargets":
            if self.fail_get_targets:
                raise RuntimeError("target discovery unavailable")
            return {"targetInfos": list(self.targets)}
        if method == "Target.createTarget":
            self.created += 1
            target_id = f"created-{self.created}"
            self.targets.append(
                {
                    "targetId": target_id,
                    "type": "page",
                    "url": params["url"],
                    "title": "",
                }
            )
            return {"targetId": target_id}
        if method == "Target.attachToTarget":
            return {"sessionId": f"session-{params['targetId']}"}
        if method == "Target.getTargetInfo":
            target = next(
                target
                for target in self.targets
                if target["targetId"] == params["targetId"]
            )
            return {"targetInfo": target}
        if method == "Target.closeTarget":
            target_id = params["targetId"]
            if target_id in self.fail_close_target_ids:
                raise RuntimeError(f"cannot close {target_id}")
            self.targets = [
                target for target in self.targets if target["targetId"] != target_id
            ]
            return {"success": True}
        return {}


def run(coro):
    return asyncio.run(coro)


def make_daemon(monkeypatch, targets):
    monkeypatch.setenv("BH_MANAGED", "1")
    monkeypatch.setenv("BH_MANAGED_CONTROL_TOKEN", CONTROL_TOKEN)
    monkeypatch.setenv("BU_CDP_WS", "ws://127.0.0.1:9222/devtools/browser/test")
    monkeypatch.delenv("BU_CDP_URL", raising=False)
    d = daemon.Daemon()
    d.managed = True
    d.cdp = FakeCDP(targets)
    d.stop = asyncio.Event()
    return d


def page(target_id, url, **extra):
    return {"targetId": target_id, "type": "page", "url": url, **extra}


def test_managed_startup_does_not_hydrate_workspace_env(monkeypatch, tmp_path):
    """Controller env remains authoritative over a legacy workspace .env."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text(
        """BU_CDP_WS=ws://legacy-workspace-endpoint
BU_BROWSER_ID=legacy-cloud-browser
""",
        encoding="utf-8",
    )
    monkeypatch.setenv("BH_MANAGED", "1")
    monkeypatch.setenv("BH_MANAGED_SOCKET", str(tmp_path / "managed.sock"))
    monkeypatch.setenv("BH_MANAGED_CONTROL_TOKEN", CONTROL_TOKEN)
    monkeypatch.setenv("BH_AGENT_WORKSPACE", str(workspace))
    monkeypatch.setenv("BU_CDP_URL", "http://controller-endpoint")
    monkeypatch.delenv("BU_CDP_WS", raising=False)
    monkeypatch.delenv("BU_BROWSER_ID", raising=False)

    daemon._load_env()

    assert os.environ["BU_CDP_URL"] == "http://controller-endpoint"
    assert "BU_CDP_WS" not in os.environ
    assert "BU_BROWSER_ID" not in os.environ
    daemon.Daemon()._validate_managed_startup()


def test_managed_run_keeps_controller_env_and_admin_guard(tmp_path):
    """The runtime entrypoint must not rehydrate legacy dotenv settings."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text(
        """BU_CDP_URL=http://legacy-workspace-url
BU_CDP_WS=ws://legacy-workspace-endpoint
BU_BROWSER_ID=legacy-cloud-browser
BU_NAME=legacy-daemon
""",
        encoding="utf-8",
    )
    env = os.environ.copy()
    for key in ("BU_CDP_WS", "BU_BROWSER_ID", "BU_NAME"):
        env.pop(key, None)
    env.update(
        {
            "PYTHONPATH": str(Path(daemon.__file__).resolve().parents[1]),
            "BH_HOME": str(tmp_path / "home"),
            "BH_AGENT_WORKSPACE": str(workspace),
            "BH_MANAGED": "1",
            "BH_MANAGED_SOCKET": str(tmp_path / "managed.sock"),
            "BH_MANAGED_CONTROL_TOKEN": CONTROL_TOKEN,
            "BH_RUNTIME_DIR": str(tmp_path / "runtime"),
            "BH_TMP_DIR": str(tmp_path / "tmp"),
            "BU_CDP_URL": "http://controller-endpoint",
            "BU_NAME": "controller-name",
        }
    )
    probe = """\
import json
import os
import browser_harness.run
import browser_harness.admin as admin

try:
    admin._managed_disabled("ensure_daemon")
except RuntimeError as error:
    admin_guard = str(error)
else:
    admin_guard = "not-disabled"

print(json.dumps({
    "url": os.environ.get("BU_CDP_URL"),
    "ws": os.environ.get("BU_CDP_WS"),
    "browser": os.environ.get("BU_BROWSER_ID"),
    "name": os.environ.get("BU_NAME"),
    "adminName": admin.NAME,
    "adminGuard": admin_guard,
}))
"""
    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=Path(__file__).resolve().parents[2],
        env=env,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == {
        "url": "http://controller-endpoint",
        "ws": None,
        "browser": None,
        "name": "controller-name",
        "adminName": "managed",
        "adminGuard": "managed_admin_disabled: ensure_daemon is unavailable in managed mode",
    }


def control(d, action, **payload):
    return run(
        d.handle(
            {
                "meta": "managed_control",
                "token": CONTROL_TOKEN,
                "action": action,
                **payload,
            }
        )
    )


def test_health_requires_the_privileged_control_token(monkeypatch):
    d = make_daemon(monkeypatch, [])

    denied = run(
        d.handle(
            {
                "meta": "managed_control",
                "token": "not-the-token",
                "action": "health",
            }
        )
    )
    assert denied == {
        "ok": False,
        "error": {
            "code": "managed_control_unauthorized",
            "message": "managed control token is invalid",
        },
    }

    healthy = control(d, "health")
    assert healthy["ok"] is True
    assert healthy["data"]["ready"] is True
    assert healthy["data"]["targetCount"] == 0


def test_acquire_uses_exact_marker_not_first_user_page(monkeypatch):
    marker = "pi-wsl-browser-" + "a" * 32 + "-z1-abc"
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("extension-root", f"about:blank#{marker}"),
        ],
    )

    result = control(d, "acquire-root", mode="headless", marker=marker)

    assert result["ok"] is True
    assert result["data"]["rootTargetId"] == "extension-root"
    assert result["data"]["ownedTargetIds"] == ["extension-root"]
    assert [
        params
        for method, params, _sid in d.cdp.calls
        if method == "Target.attachToTarget"
    ] == [{"targetId": "extension-root", "flatten": True}]
    assert not any(method == "Target.createTarget" for method, _p, _s in d.cdp.calls)


def test_acquire_without_visible_marker_creates_only_marked_root(monkeypatch):
    d = make_daemon(monkeypatch, [page("user-tab", "https://user.example/")])

    result = control(d, "acquire-root", mode="headed-tmp-profile", marker="new-root")

    assert result["ok"] is True
    assert result["data"]["rootTargetId"] == "created-1"
    create_calls = [
        params
        for method, params, _sid in d.cdp.calls
        if method == "Target.createTarget"
    ]
    assert create_calls == [{"url": "about:blank#new-root", "background": True}]
    assert d.cdp.targets == [
        page("user-tab", "https://user.example/"),
        page("created-1", "about:blank#new-root", title=""),
    ]


def test_target_id_must_carry_the_requested_marker(monkeypatch):
    d = make_daemon(monkeypatch, [page("user-tab", "https://user.example/")])

    result = control(
        d,
        "acquire-root",
        mode="headless",
        marker="root-marker",
        targetId="user-tab",
    )

    assert result["ok"] is False
    assert result["error"]["code"] == "managed_root_marker_mismatch"
    assert not any(method == "Target.attachToTarget" for method, _p, _s in d.cdp.calls)


def test_opener_descendants_are_switchable_and_user_tabs_are_hidden(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("root", "about:blank#marker"),
            page("popup", "https://popup.example/", openerId="root"),
            page("nested", "https://nested.example/", openerId="popup"),
            page("unrelated", "https://other.example/", openerId="user-tab"),
        ],
    )
    acquired = control(d, "acquire-root", mode="headless", marker="marker")
    assert acquired["data"]["ownedTargetIds"] == ["nested", "popup", "root"]

    tabs = run(d.handle({"method": "Target.getTargets", "params": {}}))
    assert [info["targetId"] for info in tabs["result"]["targetInfos"]] == [
        "root",
        "popup",
        "nested",
    ]
    attached = run(
        d.handle(
            {
                "method": "Target.attachToTarget",
                "params": {"targetId": "popup"},
            }
        )
    )
    assert attached["result"]["sessionId"] == "session-popup"
    switched = run(
        d.handle(
            {
                "meta": "set_session",
                "session_id": "session-popup",
                "target_id": "popup",
            }
        )
    )
    assert switched == {"session_id": "session-popup"}

    denied = run(
        d.handle(
            {"method": "Target.attachToTarget", "params": {"targetId": "user-tab"}}
        )
    )
    assert denied["error"] == "managed_target_not_owned"


def test_set_session_rejects_forged_session_provenance(monkeypatch):
    d = make_daemon(monkeypatch, [page("root", "about:blank#marker")])
    control(d, "acquire-root", mode="headless", marker="marker")
    previous_session = d.session

    forged = run(
        d.handle(
            {
                "meta": "set_session",
                "session_id": "not-returned-by-attach",
                "target_id": "root",
            }
        )
    )

    assert forged["error"] == "managed_session_not_owned"
    assert forged["details"] == {
        "sessionId": "not-returned-by-attach",
        "targetId": "root",
    }
    assert d.session == previous_session
    assert d.target_id == "root"


def test_parent_target_owns_oopif_but_parent_frame_id_alone_does_not(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("root", "about:blank#marker"),
            page(
                "oopif",
                "https://embedded.example/",
                type="iframe",
                parentId="root",
                parentFrameId="root-frame",
            ),
            page(
                "nested-oopif",
                "https://nested-embedded.example/",
                type="iframe",
                parentId="oopif",
                parentFrameId="nested-frame",
            ),
            page(
                "orphan-iframe",
                "https://unrelated.example/",
                type="iframe",
                parentFrameId="root-frame",
            ),
        ],
    )

    acquired = control(d, "acquire-root", mode="headless", marker="marker")

    assert acquired["data"]["ownedTargetIds"] == [
        "nested-oopif",
        "oopif",
        "root",
    ]
    visible = run(d.handle({"method": "Target.getTargets", "params": {}}))
    assert [info["targetId"] for info in visible["result"]["targetInfos"]] == [
        "root",
        "oopif",
        "nested-oopif",
    ]
    attached = run(
        d.handle(
            {
                "method": "Target.attachToTarget",
                "params": {"targetId": "oopif"},
            }
        )
    )
    assert attached["result"]["sessionId"] == "session-oopif"
    denied = run(
        d.handle(
            {
                "method": "Target.attachToTarget",
                "params": {"targetId": "orphan-iframe"},
            }
        )
    )
    assert denied["error"] == "managed_target_not_owned"

    released = control(d, "release-root")
    assert released["data"]["closedTargetIds"] == [
        "nested-oopif",
        "oopif",
        "root",
    ]


def test_agent_cannot_create_or_close_targets(monkeypatch):
    d = make_daemon(monkeypatch, [page("root", "about:blank#marker")])
    control(d, "acquire-root", mode="headless", marker="marker")

    for method in ("Target.createTarget", "Target.closeTarget"):
        result = run(d.handle({"method": method, "params": {}}))
        assert result["error"] == "managed_target_lifecycle_denied"
    assert not any(
        method in {"Target.createTarget", "Target.closeTarget"} and params == {}
        for method, params, _sid in d.cdp.calls
    )


def test_release_closes_only_owned_tree_and_clears_lease(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("root", "about:blank#marker"),
            page("popup", "https://popup.example/", openerId="root"),
        ],
    )
    acquired = control(d, "acquire-root", mode="headless", marker="marker")
    released = control(d, "release-root")

    assert released["ok"] is True
    assert released["data"]["leaseId"] == acquired["data"]["leaseId"]
    assert released["data"]["closedTargetIds"] == ["popup", "root"]
    assert [target["targetId"] for target in d.cdp.targets] == ["user-tab"]
    status = control(d, "status")
    assert status["data"]["leaseId"] is None
    assert status["data"]["ownedTargetIds"] == []


def test_release_uses_cached_owned_tree_when_discovery_fails(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("root", "about:blank#marker"),
            page("popup", "https://popup.example/", openerId="root"),
        ],
    )
    control(d, "acquire-root", mode="headless", marker="marker")
    d.cdp.fail_get_targets = True

    released = control(d, "release-root")

    assert released["ok"] is True
    assert released["data"]["closedTargetIds"] == ["popup", "root"]
    assert [target["targetId"] for target in d.cdp.targets] == ["user-tab"]


def test_release_reports_incomplete_close_as_control_failure(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/"),
            page("root", "about:blank#marker"),
            page("popup", "https://popup.example/", openerId="root"),
        ],
    )
    control(d, "acquire-root", mode="headless", marker="marker")
    d.cdp.fail_close_target_ids.add("popup")

    released = control(d, "release-root")

    assert released["ok"] is False
    assert released["error"]["code"] == "managed_release_incomplete"
    assert released["error"]["details"]["closedTargetIds"] == ["root"]
    assert released["error"]["details"]["failedTargetIds"] == ["popup"]
    assert released["error"]["details"]["closeErrors"][0]["targetId"] == "popup"
    status = control(d, "status")
    assert status["data"]["leaseId"] is None


def test_stale_session_is_reported_without_attach_or_retry(monkeypatch):
    d = make_daemon(monkeypatch, [page("root", "about:blank#marker")])
    control(d, "acquire-root", mode="headless", marker="marker")
    d.cdp.stale_methods.add("Runtime.evaluate")
    before = len(
        [
            method
            for method, _params, _sid in d.cdp.calls
            if method == "Target.attachToTarget"
        ]
    )

    result = run(
        d.handle(
            {
                "method": "Runtime.evaluate",
                "params": {"expression": "1"},
            }
        )
    )

    assert result["error"] == "managed_stale_session"
    after = len(
        [
            method
            for method, _params, _sid in d.cdp.calls
            if method == "Target.attachToTarget"
        ]
    )
    assert after == before


def test_helper_list_tabs_filters_to_daemon_owned_targets(monkeypatch):
    monkeypatch.setattr(helpers.ipc, "managed_mode", lambda: True)
    monkeypatch.setattr(
        helpers,
        "_send",
        lambda request: (
            {"ownedTargetIds": ["root"]}
            if request.get("meta") == "managed_status"
            else {}
        ),
    )
    monkeypatch.setattr(
        helpers,
        "cdp",
        lambda method, **_kwargs: {
            "targetInfos": [
                page("root", "https://owned.example/"),
                page("user", "https://user.example/"),
            ]
        },
    )

    assert helpers.list_tabs() == [
        {
            "targetId": "root",
            "target_id": "root",
            "title": "",
            "url": "https://owned.example/",
        }
    ]


def test_managed_events_hide_user_targets_but_keep_owned_events(monkeypatch):
    d = make_daemon(
        monkeypatch,
        [
            page("user-tab", "https://user.example/", title="User secret"),
            page("root", "about:blank#marker"),
        ],
    )
    control(d, "acquire-root", mode="headless", marker="marker")
    root_session = d.session

    assert not d._record_event(
        "Target.targetCreated",
        {
            "targetInfo": page(
                "user-popup", "https://private-user.example/", title="Private tab"
            )
        },
        None,
        "",
    )
    assert d._record_event(
        "Target.targetCreated",
        {
            "targetInfo": page(
                "owned-popup",
                "https://owned.example/",
                openerId="root",
                title="Owned popup",
            )
        },
        None,
        "",
    )
    assert d._record_event(
        "Network.requestWillBeSent",
        {"requestId": "owned-request"},
        root_session,
        "",
    )
    assert d._record_event(
        "Page.javascriptDialogOpening",
        {"type": "alert", "message": "owned dialog"},
        root_session,
        "",
    )
    assert d._record_event(
        "Target.targetDestroyed", {"targetId": "owned-popup"}, None, ""
    )
    assert not d._record_event(
        "Target.targetInfoChanged",
        {"targetInfo": page("user-tab", "https://private-user.example/")},
        None,
        "",
    )
    assert not d._record_event(
        "Target.targetDestroyed", {"targetId": "user-tab"}, None, ""
    )

    drained = run(d.handle({"meta": "drain_events"}))
    assert [event["method"] for event in drained["events"]] == [
        "Target.targetCreated",
        "Network.requestWillBeSent",
        "Page.javascriptDialogOpening",
        "Target.targetDestroyed",
    ]
    assert all(
        "private-user.example" not in json.dumps(event)
        and "Private tab" not in json.dumps(event)
        for event in drained["events"]
    )
    assert d.dialog == {"type": "alert", "message": "owned dialog"}


def test_managed_unix_socket_ndjson_control_contract(monkeypatch, tmp_path):
    socket_path = tmp_path / "managed.sock"
    monkeypatch.setenv("BH_MANAGED_SOCKET", str(socket_path))
    monkeypatch.setattr(daemon, "log", lambda _message: None)

    async def exchange(request):
        reader, writer = await asyncio.open_unix_connection(str(socket_path))
        writer.write((json.dumps(request) + "\n").encode())
        await writer.drain()
        line = await asyncio.wait_for(reader.readline(), timeout=1)
        writer.close()
        await writer.wait_closed()
        return json.loads(line)

    async def exercise():
        d = make_daemon(monkeypatch, [page("user-tab", "https://user.example/")])
        server_task = asyncio.create_task(daemon.serve(d))
        try:
            for _ in range(100):
                if socket_path.exists():
                    break
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.01)
            assert socket_path.exists()
            assert stat.S_IMODE(os.stat(socket_path).st_mode) == 0o600

            unauthorized = await exchange(
                {
                    "meta": "managed_control",
                    "token": "wrong-token",
                    "action": "health",
                }
            )
            assert unauthorized == {
                "ok": False,
                "error": {
                    "code": "managed_control_unauthorized",
                    "message": "managed control token is invalid",
                },
            }

            healthy = await exchange(
                {
                    "meta": "managed_control",
                    "token": CONTROL_TOKEN,
                    "action": "health",
                }
            )
            assert healthy["ok"] is True
            assert healthy["data"]["ready"] is True
            assert healthy["data"]["targetCount"] == 1

            acquired = await exchange(
                {
                    "meta": "managed_control",
                    "token": CONTROL_TOKEN,
                    "action": "acquire-root",
                    "mode": "headless",
                    "marker": "wire-root",
                }
            )
            assert acquired["ok"] is True
            assert acquired["data"]["rootTargetId"] == "created-1"
            assert acquired["data"]["ownedTargetIds"] == ["created-1"]

            status = await exchange(
                {
                    "meta": "managed_control",
                    "token": CONTROL_TOKEN,
                    "action": "status",
                }
            )
            assert status["ok"] is True
            assert status["data"]["leaseId"] == acquired["data"]["leaseId"]
            assert status["data"]["ownedTargetIds"] == ["created-1"]

            released = await exchange(
                {
                    "meta": "managed_control",
                    "token": CONTROL_TOKEN,
                    "action": "release-root",
                }
            )
            assert released == {
                "ok": True,
                "data": {
                    "released": True,
                    "leaseId": acquired["data"]["leaseId"],
                    "closedTargetIds": ["created-1"],
                },
            }

            shutdown = await exchange(
                {
                    "meta": "managed_control",
                    "token": CONTROL_TOKEN,
                    "action": "shutdown",
                }
            )
            assert shutdown["ok"] is True
            assert shutdown["data"]["shutdown"] is True
            await asyncio.wait_for(server_task, timeout=1)
        finally:
            if not server_task.done():
                d.stop.set()
                server_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await server_task

    run(exercise())


def test_helper_gates_do_not_search_or_create_in_managed_mode(monkeypatch):
    monkeypatch.setattr(helpers.ipc, "managed_mode", lambda: True)
    with pytest.raises(RuntimeError, match="managed_new_tab_denied"):
        helpers.new_tab()

    current = {
        "targetId": "root",
        "target_id": "root",
        "url": "about:blank",
        "title": "",
    }
    monkeypatch.setattr(helpers, "current_tab", lambda: current)
    monkeypatch.setattr(
        helpers,
        "list_tabs",
        lambda **_kwargs: pytest.fail("managed ensure_real_tab must not search tabs"),
    )
    assert helpers.ensure_real_tab() == current
