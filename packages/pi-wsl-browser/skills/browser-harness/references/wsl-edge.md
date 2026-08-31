# WSL → Windows browser discovery

The extension discovers Windows paths at runtime. It queries Windows LocalAppData and checks the Edge executable and:

```text
%LOCALAPPDATA%\Microsoft\Edge\User Data\Local State
```

`profile.last_used` selects the profile directory for `main-profile`. A user config can override `browser`, `executable`, `userDataDir`, or `profileDirectory` in:

```text
$PI_CODING_AGENT_DIR/pi-wsl-browser/config.json
```

No Windows username is bundled in the package.

## Modes

`headless` and `headed-tmp-profile` create a unique temporary user-data directory under discovered Windows `%TEMP%`/`LocalAppData\\Temp` storage and launch Edge with `--remote-debugging-port=0`. The WSL controller converts the Windows-backed root to `/mnt/<drive>/...` for `mkdir`/`mkdtemp`, then passes a Windows drive path to Edge. WSL `/tmp` and `/home` roots are rejected because they would become `\\wsl.localhost` profile paths. The controller reads that profile's `DevToolsActivePort`, so sessions never share a fixed port or profile. Session shutdown terminates only the process carrying the package marker and removes that temporary directory.

`main-profile` targets the inferred profile with a marker URL. It uses the WebSocket path from the profile's `DevToolsActivePort` and holds one authorization attempt for 180 seconds. If Windows shows an authorization prompt, ask the user to approve it once; do not retry by launching another daemon. Session shutdown closes the package daemon but never kills the user's main Edge process or existing tabs.

If the Edge executable is absent, discovery may select Chrome using the same LocalAppData/profile rules; leftover Edge user data alone does not count as Edge presence. If the Edge executable exists but cannot start or connect, report the Edge error and stop.
