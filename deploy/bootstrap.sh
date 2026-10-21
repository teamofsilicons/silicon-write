#!/bin/bash
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive
test "$(uname -m)" = aarch64
. /etc/os-release
test "$ID" = ubuntu
test "$VERSION_ID" = 22.04
install -d -m 755 /usr/share/postgresql-common/pgdg
curl -fsSL --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
printf '%s\n' 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main' > /etc/apt/sources.list.d/pgdg.list
apt-get update
apt-get install -y --no-install-recommends postgresql-16 postgresql-client-16 libreoffice-writer-nogui poppler-utils ffmpeg fonts-dejavu-core bubblewrap
dpkg -i "$(dirname "$0")/packages/pandoc-3.12.1-1-arm64.deb"
