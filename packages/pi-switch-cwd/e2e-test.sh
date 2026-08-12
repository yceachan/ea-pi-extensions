#!/usr/bin/env bash
# e2e test for the /cwd extension — boots a real pi in tmux with -e and
# exercises: bare /cwd, auto-create, session relocation, tab completion,
# the agent's bash cwd after a switch (no cd needed), and round-trips.
#
# Requires: tmux, a configured default model in ~/.pi/agent/settings.json.
# Run from the repo root:  ./e2e-test.sh
set -u
ROOT=/tmp/pi-switch-cwd-e2e
EXT="$PWD/index.ts"
SES=cwdtest
mkdir -p $ROOT/home $ROOT/proj
tmux kill-session -t $SES 2>/dev/null
rm -rf ~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-* 2>/dev/null
tmux set -g extended-keys on 2>/dev/null
tmux new-session -d -s $SES -x 240 -y 60 -c $ROOT/home
sleep 1
tmux send-keys -t $SES "pi -e $EXT" Enter

wait_for() { # $1 = pattern, $2 = seconds
	for i in $(seq 1 $2); do
		sleep 1
		if tmux capture-pane -t $SES -p 2>/dev/null | grep -aq "$1"; then return 0; fi
	done
	return 1
}

step() { echo "== $1"; }

step "boot pi (up to 90s)"
if ! wait_for "pi v0.84" 90; then
	echo "BOOT FAILED"
	tmux capture-pane -t $SES -p | tail -20
	exit 1
fi
sleep 3
echo "booted ✓"

step "bare /cwd"
tmux send-keys -t $SES "/cwd" Enter
if ! wait_for "Current cwd" 10; then
	echo "bare /cwd FAILED"
	tmux capture-pane -t $SES -p | tail -15
	exit 1
fi
echo "✓ Current cwd shown"

step "/cwd to nonexistent dir (auto-create)"
tmux send-keys -t $SES "/cwd $ROOT/brand-new" Enter
if ! wait_for "Switched" 10; then
	echo "auto-create FAILED"
	tmux capture-pane -t $SES -p | tail -15
	exit 1
fi
[ -d $ROOT/brand-new ] && echo "✓ dir created + switched" || {
	echo "dir NOT created"
	exit 1
}

step "/cwd to proj"
tmux send-keys -t $SES "/cwd $ROOT/proj" Enter
if ! wait_for "Switched" 10; then
	echo "switch FAILED"
	tmux capture-pane -t $SES -p | tail -15
	exit 1
fi
sleep 1
echo "✓ switched"

step "session file relocation"
PROJ_SESS=~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-proj--
if [ -d "$PROJ_SESS" ] && [ -n "$(ls $PROJ_SESS/*.jsonl 2>/dev/null)" ]; then
	echo "✓ session file in proj session dir: $(basename $(ls $PROJ_SESS/*.jsonl | head -1))"
else
	echo "FAILED: no session file in $PROJ_SESS"
	exit 1
fi
OLD=$(ls ~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-home--/*.jsonl 2>/dev/null)
if [ -z "$OLD" ]; then echo "✓ old session file deleted"; else
	echo "FAILED: old file remains: $OLD"
	exit 1
fi

step "tab completion"
tmux send-keys -t $SES "/cwd $ROOT/" Tab
if wait_for "proj/\|brand-new/" 5; then echo "✓ completion lists dirs"; else
	echo "completion FAILED"
	tmux capture-pane -t $SES -p | tail -10
	exit 1
fi
tmux send-keys -t $SES Escape

step "agent bash cwd after switch (plain 'pwd', no cd)"
tmux send-keys -t $SES "pwd" Enter
if ! wait_for "$ROOT/proj" 90; then
	echo "agent pwd FAILED"
	tmux capture-pane -t $SES -p | tail -20
	exit 1
fi
echo "✓ agent bash cwd = $ROOT/proj"

step "/cwd back to home (round-trip)"
tmux send-keys -t $SES "/cwd $ROOT/home" Enter
if ! wait_for "Switched" 10; then
	echo "round-trip FAILED"
	tmux capture-pane -t $SES -p | tail -15
	exit 1
fi
sleep 1
HOME_SESS=~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-home--
if [ -n "$(ls $HOME_SESS/*.jsonl 2>/dev/null)" ] && [ -z "$(ls ~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-proj--/*.jsonl 2>/dev/null)" ]; then
	echo "✓ session moved back; no accumulation"
else
	echo "FAILED: round-trip relocation wrong"
	ls ~/.pi/agent/sessions/ | grep pi-switch-cwd-e2e
	exit 1
fi

echo "ALL E2E PASSED"
tmux kill-session -t $SES 2>/dev/null
rm -rf $ROOT ~/.pi/agent/sessions/--tmp-pi-switch-cwd-e2e-* 2>/dev/null
