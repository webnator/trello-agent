#!/bin/sh
# Fix ownership of mounted volumes (they may be created as root by Docker)
if [ "$(stat -c '%u' /home/agent/.claude 2>/dev/null)" != "$(id -u)" ]; then
  sudo chown -R agent:agent /home/agent/.claude 2>/dev/null || true
fi
if [ "$(stat -c '%u' /workspace 2>/dev/null)" != "$(id -u)" ]; then
  sudo chown -R agent:agent /workspace 2>/dev/null || true
fi

exec "$@"
