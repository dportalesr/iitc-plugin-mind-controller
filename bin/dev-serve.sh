#!/usr/bin/env bash
# Serve the plugin over localhost so IITC Button's "Custom channel" can
# re-fetch it on every page load — saves you the install / refresh dance.
#
# Usage:
#   bin/dev-serve.sh           # default port 8765
#   bin/dev-serve.sh 9000      # custom port
#   PORT=9000 bin/dev-serve.sh
set -euo pipefail

PORT="${1:-${PORT:-8765}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_FILE="iitc-plugin-mind-controller.user.js"

cd "$ROOT_DIR"

if [ ! -f "$PLUGIN_FILE" ]; then
  echo "error: $PLUGIN_FILE not found in $ROOT_DIR" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required (brew install python or install from python.org)" >&2
  exit 1
fi

URL4="http://127.0.0.1:${PORT}/${PLUGIN_FILE}"
URL6="http://[::1]:${PORT}/${PLUGIN_FILE}"

cat <<EOF
Mind Controller dev server (IPv4 + IPv6 loopback)
  serving:  ${ROOT_DIR}
  IPv4:     ${URL4}
  IPv6:     ${URL6}

Paste one of the URLs into IITC Button or your userscript manager.
For IITC Button: navigate Firefox to the URL above to trigger the
install prompt; on update, the extension re-fetches automatically.

Ctrl-C to stop.
----
EOF

# Bind to both IPv4 and IPv6 loopback. Firefox extensions often resolve
# "localhost" to ::1 first; a single-stack server then looks "unreachable".
exec python3 -c "
import http.server, socket
class DualStack(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        return super().server_bind()
with DualStack(('::', ${PORT}), http.server.SimpleHTTPRequestHandler) as httpd:
    httpd.serve_forever()
"
