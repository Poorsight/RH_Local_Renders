#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="exile.dreamsoft.us"
REMOTE_DIR="dmitriy.derevyanko/light-rig"
PUBLIC_URL="https://preview.3dsource.com/$REMOTE_DIR/"
FILES=(index.html light-rig-reference.html app.css app.js favicon.svg data/sectionals-indoor.csv)

[[ "$(git branch --show-current)" == "main" ]] || { echo "Deploy requires main" >&2; exit 1; }
git fetch --quiet origin main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse refs/remotes/origin/main)" ]] || { echo "Local main must match origin/main" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Tracked worktree changes must be committed" >&2; exit 1; }

NETRC="$(mktemp)"
chmod 600 "$NETRC"
trap 'rm -f "$NETRC"' EXIT

if [[ -n "${RH_FTP_USER:-}" && -n "${RH_FTP_PASSWORD:-}" ]]; then
  printf 'machine %s login %s password %s\n' "$HOST" "$RH_FTP_USER" "$RH_FTP_PASSWORD" > "$NETRC"
else
  PYTHON=""
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys' >/dev/null 2>&1; then PYTHON="$candidate"; break; fi
  done
  [[ -n "$PYTHON" ]] || { echo "Python 3 or RH_FTP_USER/RH_FTP_PASSWORD is required" >&2; exit 1; }
  "$PYTHON" - "$NETRC" "$HOST" <<'PY'
import base64, os, sys, xml.etree.ElementTree as ET
netrc_path, host = sys.argv[1], sys.argv[2]
home, appdata = os.path.expanduser('~'), os.environ.get('APPDATA')
paths = [
    os.path.join(home, '.config', 'filezilla', 'sitemanager.xml'),
    os.path.join(home, 'AppData', 'Roaming', 'FileZilla', 'sitemanager.xml'),
]
if appdata:
    paths.append(os.path.join(appdata, 'FileZilla', 'sitemanager.xml'))
config = next((item for item in paths if os.path.isfile(item)), None)
if not config:
    raise SystemExit('FileZilla sitemanager.xml not found')
for server in ET.parse(config).iter('Server'):
    if server.findtext('Host') != host:
        continue
    user, password_node = server.findtext('User'), server.find('Pass')
    if not user or password_node is None or password_node.text is None:
        raise SystemExit(f'No saved credentials for {host}')
    password = password_node.text
    if password_node.get('encoding') == 'base64':
        password = base64.b64decode(password).decode()
    with open(netrc_path, 'w', encoding='utf-8') as output:
        output.write(f'machine {host} login {user} password {password}\n')
    break
else:
    raise SystemExit(f'{host} not found in {config}')
PY
fi

for file in "${FILES[@]}"; do
  echo "Uploading $file"
  curl -sS --max-time 180 --netrc-file "$NETRC" --ftp-create-dirs -T "$file" "ftp://$HOST/$REMOTE_DIR/$file"
done

curl -sS -o /dev/null -w "Preview http=%{http_code} size=%{size_download}\n" --max-time 30 "$PUBLIC_URL"
echo "$PUBLIC_URL"
