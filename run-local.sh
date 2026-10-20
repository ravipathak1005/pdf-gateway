#!/bin/sh
cd "$(dirname "$0")" && (command -v xdg-open >/dev/null && xdg-open http://localhost:8765/index.html >/dev/null 2>&1 &) ; python3 -m http.server 8765
