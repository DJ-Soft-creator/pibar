#!/bin/sh
# Container start: copy the mounted SSH files (read-only, owned by the Docker host's user) to a folder the
# node user owns with the permissions ssh insists on, then drop root and start the server.
set -e

if [ "$(id -u)" = "0" ]; then
  if [ -d "${SSH_MOUNT:-/ssh}" ]; then
    target=/home/node/.pibar-ssh
    rm -rf "$target"
    mkdir -p "$target"
    cp -R "${SSH_MOUNT:-/ssh}"/. "$target"/
    chown -R node:node "$target"
    chmod 700 "$target"
    find "$target" -type f -exec chmod 600 {} \;
    export SSH_DIR="$target"
  fi
  chown -R node:node "${DATA_DIR:-/data}"
  exec su-exec node "$@"
fi

# already running as a normal user: use the mount as it is
if [ -z "$SSH_DIR" ] && [ -d "${SSH_MOUNT:-/ssh}" ]; then export SSH_DIR="${SSH_MOUNT:-/ssh}"; fi
exec "$@"
