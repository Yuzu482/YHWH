#!/usr/bin/env bash
set -euo pipefail

NODE_VERSION="22.23.1"
PI_VERSION="0.84.4"
LSP_VERSION="1.3.0"
CLAUDE_PROVIDER_VERSION="0.1.4"
CLAUDE_CODE_VERSION="2.1.250"
PYRIGHT_VERSION="1.1.413"
TSLS_VERSION="6.0.0"
TYPESCRIPT_VERSION="7.0.2"
VSCODE_LSP_VERSION="3.17.5"
JDTLS_VERSION="1.60.0"
JDTLS_BUILD="202606262232"
DOTNET_VERSION="10.0.400"
CSHARP_LS_VERSION="0.26.0"
HARDEN_DISTRO="${PI_KETHER_HARDEN_DISTRO:-0}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends python3 ca-certificates curl xz-utils tar unzip bubblewrap util-linux diffutils coreutils openjdk-21-jre-headless clangd

tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

node_archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}" -o "$tmp/$node_archive"
curl --fail --location --retry 3 "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
(cd "$tmp" && grep " ${node_archive}$" SHASUMS256.txt | sha256sum --check --strict -)
rm -rf /opt/node.new
mkdir -p /opt/node.new
tar -xJf "$tmp/$node_archive" --strip-components=1 -C /opt/node.new
rm -rf /opt/node
mv /opt/node.new /opt/node

id pi-sandbox >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/pi-sandbox --shell /usr/sbin/nologin pi-sandbox
install -d -o root -g root -m 0755 /opt/pi-kether /opt/pi-kether/extensions /opt/pi-kether/scripts /opt/pi-kether/dotnet-tools
cat >/opt/pi-kether/package.json <<JSON
{"private":true,"dependencies":{"@earendil-works/pi-coding-agent":"${PI_VERSION}","@anthropic-ai/claude-code":"${CLAUDE_CODE_VERSION}","pi-claude-code-provider":"${CLAUDE_PROVIDER_VERSION}","pi-lsp-extension":"${LSP_VERSION}","pyright":"${PYRIGHT_VERSION}","typescript-language-server":"${TSLS_VERSION}","typescript":"${TYPESCRIPT_VERSION}","vscode-languageserver-protocol":"${VSCODE_LSP_VERSION}"}}
JSON
install -o root -g root -m 0644 /tmp/pi-kether-install/wsl-package-lock.json /opt/pi-kether/package-lock.json
(cd /opt/pi-kether && /opt/node/bin/npm ci --omit=dev --ignore-scripts=false)
/opt/node/bin/node /tmp/pi-kether-install/patch-pi-lsp.mjs /opt/pi-kether/node_modules/pi-lsp-extension

install -o root -g root -m 0755 /tmp/pi-kether-install/pi-kether-sandbox /usr/local/libexec/pi-kether-sandbox
install -o root -g root -m 0644 /tmp/pi-kether-install/validate-write-scope.mjs /opt/pi-kether/scripts/validate-write-scope.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/write-scope-guard.js /opt/pi-kether/extensions/write-scope-guard.js
install -o root -g root -m 0644 /tmp/pi-kether-install/auth-scrub.js /opt/pi-kether/extensions/auth-scrub.js
install -o root -g root -m 0644 /tmp/pi-kether-install/read-scope-guard.js /opt/pi-kether/extensions/read-scope-guard.js
install -o root -g root -m 0644 /tmp/pi-kether-install/snapshot-scope.py /opt/pi-kether/scripts/snapshot-scope.py
install -o root -g root -m 0644 /tmp/pi-kether-install/lsp-result.mjs /opt/pi-kether/scripts/lsp-result.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/prepare-credentials.mjs /opt/pi-kether/scripts/prepare-credentials.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/direct-lsp-bootstrap.mjs /opt/pi-kether/scripts/direct-lsp-bootstrap.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/secure-pi-bootstrap.mjs /opt/pi-kether/scripts/secure-pi-bootstrap.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/editor-pi-bootstrap.mjs /opt/pi-kether/scripts/editor-pi-bootstrap.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/editor-rpc.mjs /opt/pi-kether/scripts/editor-rpc.mjs
install -o root -g root -m 0644 /tmp/pi-kether-install/editor-proxy.js /opt/pi-kether/extensions/editor-proxy.js
install -o root -g root -m 0644 /tmp/pi-kether-install/claude-review.ts /opt/pi-kether/extensions/claude-review.ts
install -d -o root -g root -m 0711 /var/lib/pi-kether/jobs

jdtls_archive="jdt-language-server-${JDTLS_VERSION}-${JDTLS_BUILD}.tar.gz"
jdtls_base="https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}"
curl --fail --location --retry 3 "$jdtls_base/$jdtls_archive" -o "$tmp/$jdtls_archive"
curl --fail --location --retry 3 "$jdtls_base/$jdtls_archive.sha256" -o "$tmp/$jdtls_archive.sha256"
expected_jdtls="$(grep -Eo '[a-fA-F0-9]{64}' "$tmp/$jdtls_archive.sha256" | head -n1 | tr 'A-F' 'a-f')"
actual_jdtls="$(sha256sum "$tmp/$jdtls_archive" | cut -d' ' -f1)"
[[ -n "$expected_jdtls" && "$actual_jdtls" == "$expected_jdtls" ]] || { echo 'JDT LS checksum mismatch' >&2; exit 11; }
rm -rf /opt/jdtls.new
mkdir -p /opt/jdtls.new
tar -xzf "$tmp/$jdtls_archive" -C /opt/jdtls.new
rm -rf /opt/jdtls
mv /opt/jdtls.new /opt/jdtls

curl --fail --location --retry 3 https://dot.net/v1/dotnet-install.sh -o "$tmp/dotnet-install.sh"
chmod 0755 "$tmp/dotnet-install.sh"
rm -rf /opt/dotnet.new
"$tmp/dotnet-install.sh" --version "$DOTNET_VERSION" --install-dir /opt/dotnet.new --no-path
rm -rf /opt/dotnet
mv /opt/dotnet.new /opt/dotnet
rm -rf /opt/pi-kether/dotnet-tools/*
/opt/dotnet/dotnet tool install csharp-ls --version "$CSHARP_LS_VERSION" --tool-path /opt/pi-kether/dotnet-tools

cat >/usr/local/bin/csharp-ls <<'SH'
#!/usr/bin/env bash
export DOTNET_ROOT=/opt/dotnet
exec /opt/pi-kether/dotnet-tools/csharp-ls "$@"
SH
chmod 0755 /usr/local/bin/csharp-ls

cat >/usr/local/bin/jdtls <<'SH'
#!/usr/bin/env bash
set -euo pipefail
launcher="$(find /opt/jdtls/plugins -maxdepth 1 -name 'org.eclipse.equinox.launcher_*.jar' -print -quit)"
[[ -n "$launcher" ]] || { echo 'JDT LS launcher missing' >&2; exit 1; }
workspace_hash="$(printf '%s' "${PWD:-/workspace}" | sha256sum | cut -c1-16)"
data_dir="${XDG_CACHE_HOME:-/tmp}/jdtls-${workspace_hash}"
mkdir -p "$data_dir"
jvm_args=()
app_args=()
for arg in "$@"; do
  if [[ "$arg" == --jvm-arg=* ]]; then jvm_args+=("${arg#--jvm-arg=}"); else app_args+=("$arg"); fi
done
exec java "${jvm_args[@]}" -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 \
  -Declipse.product=org.eclipse.jdt.ls.core.product -Dlog.protocol=true -Dlog.level=WARNING \
  -Xms256m -Xmx1g -jar "$launcher" -configuration /opt/jdtls/config_linux -data "$data_dir" "${app_args[@]}"
SH
chmod 0755 /usr/local/bin/jdtls

if [[ "$HARDEN_DISTRO" == 1 ]]; then
  cat >/etc/wsl.conf <<'CONF'
[automount]
enabled=false

[interop]
enabled=false
appendWindowsPath=false
CONF
fi

/opt/node/bin/node --version
/opt/node/bin/node /opt/pi-kether/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --version
command -v pyright-langserver typescript-language-server clangd jdtls csharp-ls >/dev/null
printf '{"ok":true,"hardened":%s,"node":"%s","pi":"%s"}\n' "$([[ "$HARDEN_DISTRO" == 1 ]] && echo true || echo false)" "$NODE_VERSION" "$PI_VERSION"
