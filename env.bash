# Source from any Bash directory:
#   source /path/to/mono/env.bash pi-wsl-browser
#   pi -e "$PKG"
#
# If pi-shelld is already configured with `pi install`, the command above reuses it.
# To ignore configured extensions and test both workspace packages in isolation:
#   pi --no-extensions -e "$SHELLD_PKG" -e "$PKG"

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	printf 'env.bash must be sourced: source ./env.bash <package>\n' >&2
	exit 2
fi

_mono_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || return
_pkg_input="${1:-${PKG:-}}"

if [[ -z "$_pkg_input" ]]; then
	printf 'usage: source %s/env.bash <package>\n' "$_mono_root" >&2
	printf 'example: source %s/env.bash pi-wsl-browser\n' "$_mono_root" >&2
	return 2
fi

case "$_pkg_input" in
	@*/*) _pkg_input="${_pkg_input#*/}" ;;
esac

if [[ "$_pkg_input" = /* ]]; then
	_pkg_path="$_pkg_input"
elif [[ "$_pkg_input" == packages/* ]]; then
	_pkg_path="$_mono_root/$_pkg_input"
else
	_pkg_path="$_mono_root/packages/$_pkg_input"
fi

if [[ ! -f "$_pkg_path/package.json" ]]; then
	printf 'package not found: %s\n' "$_pkg_path" >&2
	return 2
fi

PKG="$(cd -- "$_pkg_path" && pwd -P)" || return
SHELLD_PKG="$(cd -- "$_mono_root/packages/pi-shelld" && pwd -P)" || return
export PKG SHELLD_PKG
cd -- "$_mono_root" || return

unset _mono_root _pkg_input _pkg_path
