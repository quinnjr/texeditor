#!/usr/bin/env bash
# Build the Flatpak bundle from the .deb the Tauri bundler produces.
#
#   scripts/build-flatpak.sh                 # build, install to --user, emit .flatpak
#   scripts/build-flatpak.sh --no-install    # build and emit the bundle only
#
# Packaging the existing deb rather than recompiling inside the sandbox keeps
# the Flatpak byte-identical to the binary the other Linux installers ship.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLATPAK_DIR="$ROOT/packaging/flatpak"
APP_ID="dev.joseph.texviewer"
BUILD_DIR="$ROOT/target/flatpak-build"
REPO_DIR="$ROOT/target/flatpak-repo"

install_bundle=1
[[ "${1:-}" == "--no-install" ]] && install_bundle=0

for tool in flatpak flatpak-builder ar; do
  command -v "$tool" >/dev/null || { echo "error: $tool is not installed" >&2; exit 1; }
done

# The deb is the input, so a stale one would silently ship yesterday's binary.
# Take the newest and print what was chosen.
deb="$(find "$ROOT/src-tauri/target/release/bundle/deb" -name '*.deb' -print0 2>/dev/null \
  | xargs -0 -r ls -t 2>/dev/null | head -1 || true)"
if [[ -z "$deb" ]]; then
  echo "error: no .deb found. Run 'pnpm tauri build --bundles deb' first." >&2
  exit 1
fi
echo "==> packaging $(basename "$deb") ($(date -r "$deb" '+%Y-%m-%d %H:%M'))"
cp "$deb" "$FLATPAK_DIR/tex-viewer.deb"

# The manifest pins these; a missing runtime otherwise fails deep inside the
# build with a less obvious message.
runtime_version="$(sed -n "s/^runtime-version: *'\{0,1\}\([0-9.]*\)'\{0,1\}/\1/p" \
  "$FLATPAK_DIR/$APP_ID.yml")"
for rt in "org.gnome.Platform" "org.gnome.Sdk"; do
  if ! flatpak info "$rt//$runtime_version" >/dev/null 2>&1; then
    echo "==> installing $rt//$runtime_version"
    flatpak install --user --noninteractive flathub "$rt//$runtime_version"
  fi
done

rm -rf "$BUILD_DIR" "$REPO_DIR"
args=(--force-clean --repo="$REPO_DIR")
(( install_bundle )) && args+=(--user --install)

flatpak-builder "${args[@]}" "$BUILD_DIR" "$FLATPAK_DIR/$APP_ID.yml"

out="$ROOT/target/$APP_ID.flatpak"
flatpak build-bundle "$REPO_DIR" "$out" "$APP_ID"

rm -f "$FLATPAK_DIR/tex-viewer.deb"
echo "==> $out ($(du -h "$out" | cut -f1))"
(( install_bundle )) && echo "==> installed; run: flatpak run $APP_ID"
exit 0
