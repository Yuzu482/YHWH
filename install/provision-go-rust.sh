#!/usr/bin/env bash
set -euo pipefail
# Fixed official artifacts; no user toolchain/profile or shell startup changes.
GO_VERSION=1.27.1
GOPLS_VERSION=v0.23.0
RUST_VERSION=1.98.1
RUST_DATE=2026-09-03
root=/opt/pi-kether
stage=$(mktemp -d "$root/go-rust-install-XXXXXX")
fetch() {
  local url=$1 name=$2 expected=$3
  curl --fail --location --retry 3 --silent --show-error "$url" -o "$stage/$name"
  printf '%s  %s\n' "$expected" "$stage/$name" | sha256sum --check --strict -
}
if [[ ! -d "$root/go" ]]; then
  fetch "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" go.tar.gz 63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445
  tar -xzf "$stage/go.tar.gz" -C "$stage"
  mv "$stage/go" "$root/go"
fi
[[ "$($root/go/bin/go version)" == *"go${GO_VERSION} "* ]] || { echo 'Go version mismatch' >&2; exit 1; }
if [[ ! -x "$root/gopls/gopls" ]]; then
  mkdir "$stage/gopls"
  GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
    GOMAXPROCS=2 GOFLAGS=-p=2 GOBIN="$stage/gopls" GOMODCACHE="$stage/mod" GOCACHE="$stage/cache" \
    "$root/go/bin/go" install "golang.org/x/tools/gopls@${GOPLS_VERSION}"
  mkdir -p "$stage/gopls/notices"
  find "$stage/mod" -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'COPYING*' \) -print0 |
    while IFS= read -r -d '' file; do
      relative=${file#"$stage/mod/"}; mkdir -p "$stage/gopls/notices/$(dirname "$relative")"; cp "$file" "$stage/gopls/notices/$relative"
    done
  "$root/go/bin/go" version -m "$stage/gopls/gopls" > "$stage/gopls/build-modules.txt"
  mv "$stage/gopls" "$root/gopls"
fi
[[ "$($root/gopls/gopls version)" == *"${GOPLS_VERSION}"* ]] || { echo 'gopls version mismatch' >&2; exit 1; }
if [[ ! -d "$root/rust" ]]; then
  mkdir "$stage/rust"
  while read -r name checksum; do
    archive="${name}-${RUST_VERSION}"
    [[ "$name" == rust-src ]] || archive+="-x86_64-unknown-linux-gnu"
    fetch "https://static.rust-lang.org/dist/${RUST_DATE}/${archive}.tar.xz" "$archive.tar.xz" "$checksum"
    tar -xJf "$stage/$archive.tar.xz" -C "$stage"
    bash "$stage/$archive/install.sh" --prefix="$stage/rust" --disable-ldconfig >/dev/null
  done <<'COMPONENTS'
rustc e974f036b28565f37c0f3bd92ddefa809bee16c04f9dcf07b9ed96e05aaaf7c4
rust-std fa3ff450172a16c026944030230c5069947af93c728d9179971d44e5e0cfb561
rust-src 5c846ebcebcc7e2e0777a4cdaa12051691593f16a7e94edbae5e6241cc62d98c
rust-analyzer 19beefa939b986be0086a36a24c540801ce849ee74f39ee933b60f947b0d4431
COMPONENTS
  mv "$stage/rust" "$root/rust"
fi
[[ "$($root/rust/bin/rustc --version)" == "rustc ${RUST_VERSION} "* ]] || { echo 'Rust version mismatch' >&2; exit 1; }
[[ "$($root/rust/bin/rust-analyzer --version)" == "rust-analyzer ${RUST_VERSION} "* ]] || { echo 'Rust analyzer version mismatch' >&2; exit 1; }
"$root/go/bin/go" version
"$root/gopls/gopls" version
"$root/rust/bin/rustc" --version
"$root/rust/bin/rust-analyzer" --version
# Retain downloaded archive checksums and upstream licenses as local evidence.
echo "Go/Rust runtime installed; staging evidence: $stage"
