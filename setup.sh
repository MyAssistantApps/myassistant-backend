#!/usr/bin/env bash
# ONE-COMMAND DEV SETUP for MyAssistant — backend + Flutter app.
#
# The same file lives in both repos (myassistant-backend/setup.sh and
# myassistant-flutter/setup.sh). Run either one; it sets up BOTH:
#
#   ./setup.sh                    full setup, then backend + app running
#   ./setup.sh --no-run           set everything up, start nothing
#   ./setup.sh --publish-secrets  OWNER ONLY: upload this machine's secret
#                                 files to Bitwarden for the team
#
# What it does, in order:
#   1. checks the tools (git, node 22+, docker, flutter, java 17, adb, bw)
#   2. clones the other repo if it is missing, then in BOTH repos:
#      backs up and DISCARDS local changes, checks out `hardening` and
#      resets it to origin/hardening. Git-ignored files (.env,
#      node_modules, google-services.json …) are never touched.
#   3. pulls the secrets from the team Bitwarden vault (both repos are
#      PUBLIC — secrets never go in git) and writes .env,
#      firebase-adminsdk.json, google-services.json, the App Check debug
#      token, .env.dev.json and the team debug keystore
#   4. starts Postgres in Docker, installs packages, starts the backend in
#      the background and waits for /health
#   5. builds the app and runs it on the connected phone (flutter run stays
#      attached: r = hot reload, R = hot restart, q = quit)
#
# Env overrides: BRANCH (default hardening), ADB_DEVICE, BW_COLLECTION.
set -euo pipefail

# Re-run from a temp copy: step 2 rewrites this very file, and bash reads
# a running script lazily — a changed file mid-run would execute garbage.
if [ -z "${MYA_SETUP_COPY:-}" ]; then
  ORIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  COPY="$(mktemp "${TMPDIR:-/tmp}/myassistant-setup.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$COPY"
  MYA_SETUP_COPY="$COPY" MYA_SETUP_ORIG="$ORIG_DIR" exec bash "$COPY" "$@"
fi
trap 'rm -f "$MYA_SETUP_COPY"' EXIT

BRANCH="${BRANCH:-hardening}"
GH_ORG="https://github.com/MyAssistantApps"
BACKEND_REPO="myassistant-backend"
FLUTTER_REPO="myassistant-flutter"
WORKSPACE="$(dirname "$MYA_SETUP_ORIG")"
BACKEND="$WORKSPACE/$BACKEND_REPO"
FLUTTER="$WORKSPACE/$FLUTTER_REPO"
DB_NAME="myassistant_dev"
DEV_DIR="$BACKEND/data/dev" # git-ignored (data/): backend log + pid

# Bitwarden secure notes, found by name (personal vault or org collection).
BW_COLLECTION="${BW_COLLECTION:-Dev secrets}"
ITEM_ENV="MyAssistant backend .env"
ITEM_ADMINSDK="MyAssistant firebase-adminsdk.json"
ITEM_GSERVICES="MyAssistant google-services.json"
ITEM_APPCHECK="MyAssistant app-check-debug-token"
ITEM_KEYSTORE="MyAssistant debug.keystore (base64)"
# Lines that differ per machine: never uploaded, always written locally.
PER_MACHINE_KEYS="JWT_SECRET|ADMIN_KEY|DATABASE_URL|PUBLIC_BASE_URL"

MODE=setup
case "${1:-}" in
  "") ;;
  --no-run) MODE=norun ;;
  --publish-secrets) MODE=publish ;;
  -h|--help) sed -n 2,30p "$MYA_SETUP_COPY"; exit 0 ;;
  *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
esac

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- tools --
find_java17() {
  if [ -x /usr/libexec/java_home ]; then /usr/libexec/java_home -v 17 2>/dev/null && return; fi
  for d in /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-17-openjdk-arm64 \
           /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/temurin-17*; do
    [ -x "$d/bin/java" ] && { echo "$d"; return; }
  done
  return 1
}

check_tools() {
  say "1/6 checking tools"
  local missing=()
  have git || missing+=("git")
  if have node; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 22 ] || missing+=("node 22+ (found $(node -v))")
  else missing+=("node 22+"); fi
  have docker || missing+=("docker (with the compose plugin)")
  if [ "$MODE" != publish ]; then
    have flutter || missing+=("flutter")
    have adb || missing+=("adb (Android platform-tools)")
    JAVA17="$(find_java17)" || missing+=("Java 17 JDK (e.g. apt install openjdk-17-jdk)")
  fi
  # A user-level install (~/.local) needs no sudo.
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac
  if ! have bw; then
    warn "Bitwarden CLI not found — installing it into ~/.local"
    npm install -g --prefix "$HOME/.local" @bitwarden/cli --no-audit --no-fund --loglevel=error >/dev/null 2>&1 \
      || missing+=("Bitwarden CLI: npm install -g --prefix ~/.local @bitwarden/cli")
  fi
  [ ${#missing[@]} -eq 0 ] || die "install these first:$(printf '\n  - %s' "${missing[@]}")"
  ok "all tools present"
}

# ------------------------------------------------------------ bitwarden --
bw_unlock() {
  local status; status="$(bw status 2>/dev/null | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch(e){console.log("unknown")}})')"
  if [ "$status" = unauthenticated ]; then
    echo "    Log in to the team's Bitwarden account:"
    bw login >/dev/null </dev/tty
  fi
  if [ -z "${BW_SESSION:-}" ]; then
    echo "    Unlock your Bitwarden vault:"
    BW_SESSION="$(bw unlock --raw </dev/tty)" || die "could not unlock Bitwarden"
    export BW_SESSION
  fi
  bw sync >/dev/null
  ok "Bitwarden vault unlocked"
}

bw_note() { # name -> note text on stdout; fails if the item is missing
  bw get notes "$1" 2>/dev/null || return 1
}

# ------------------------------------------------------------------ git --
sync_repo() { # dir repo-name
  local dir="$1" name="$2"
  if [ ! -d "$dir/.git" ]; then
    git clone -q "$GH_ORG/$name.git" "$dir"
    ok "$name cloned"
  fi
  git -C "$dir" fetch -q origin
  git -C "$dir" rev-parse -q --verify "origin/$BRANCH" >/dev/null \
    || die "$name has no branch origin/$BRANCH"

  # Keep a copy of whatever is about to be discarded.
  local dirty untracked
  dirty="$(git -C "$dir" status --porcelain)"
  if [ -n "$dirty" ]; then
    local bk="$HOME/.myassistant-setup-backups/$(date +%Y%m%d-%H%M%S)-$name"
    mkdir -p "$bk"
    git -C "$dir" diff HEAD > "$bk/changes.patch" 2>/dev/null || true
    untracked="$(git -C "$dir" ls-files --others --exclude-standard)"
    if [ -n "$untracked" ]; then
      (cd "$dir" && printf '%s\n' "$untracked" | tar -czf "$bk/untracked.tgz" -T -)
    fi
    warn "$name: local changes discarded — backup in $bk"
  fi

  git -C "$dir" checkout -q -f -B "$BRANCH" "origin/$BRANCH"
  git -C "$dir" reset -q --hard "origin/$BRANCH"
  git -C "$dir" clean -q -fd   # untracked only; ignored files are kept
  # The team's pre-push guard (.githooks/pre-push): never push over a
  # teammate's commits. See CLAUDE.md.
  [ -d "$dir/.githooks" ] && git -C "$dir" config core.hooksPath .githooks
  ok "$name at $(git -C "$dir" log --oneline -1)"
}

# -------------------------------------------------------------- secrets --
env_get() { grep -E "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2- || true; }
rand_hex() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }

lan_ip() {
  local ip=""
  if have ip; then ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
  [ -z "$ip" ] && have ipconfig && ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$ip" ] || die "could not find this machine's LAN IP address"
  echo "$ip"
}

write_secrets() {
  say "3/6 writing secrets from Bitwarden"
  bw_unlock
  umask 077

  # backend .env: the shared vault copy + this machine's own values.
  local envf="$BACKEND/.env" jwt admin
  jwt="$(env_get JWT_SECRET "$envf")";  [ -n "$jwt" ]   || jwt="$(rand_hex 48)"
  admin="$(env_get ADMIN_KEY "$envf")"; [ -n "$admin" ] || admin="$(rand_hex 16)"
  local shared; shared="$(bw_note "$ITEM_ENV")" || die "Bitwarden item '$ITEM_ENV' not found"
  {
    printf '%s\n' "$shared" | grep -vE "^($PER_MACHINE_KEYS)="
    echo
    echo "# --- this machine (written by setup.sh) ---"
    echo "DATABASE_URL=postgres://myassistant:localdev@localhost:5432/$DB_NAME"
    echo "PUBLIC_BASE_URL=http://localhost:3000"
    echo "JWT_SECRET=$jwt"
    echo "ADMIN_KEY=$admin"
  } > "$envf"
  ok "backend .env"

  if bw_note "$ITEM_ADMINSDK" > "$BACKEND/firebase-adminsdk.json"; then
    ok "backend firebase-adminsdk.json"
  else
    rm -f "$BACKEND/firebase-adminsdk.json"
    warn "no '$ITEM_ADMINSDK' in Bitwarden — push notifications will be skipped"
  fi

  [ "$MODE" = publish ] && return
  bw_note "$ITEM_GSERVICES" > "$FLUTTER/android/app/google-services.json" \
    || die "Bitwarden item '$ITEM_GSERVICES' not found"
  ok "app google-services.json"

  if bw_note "$ITEM_APPCHECK" | tr -d '[:space:]' > "$FLUTTER/android/app-check-debug-token.txt" \
     && [ -s "$FLUTTER/android/app-check-debug-token.txt" ]; then
    ok "app App Check debug token"
  else
    rm -f "$FLUTTER/android/app-check-debug-token.txt"
    warn "no '$ITEM_APPCHECK' in Bitwarden — the app's own Firebase AI calls will be refused"
  fi

  # Shared debug keystore: its SHA-1 is the one registered for Google
  # Sign-In, so every machine signs debug builds the same way.
  local ks="$HOME/.android/debug.keystore" tmpks
  tmpks="$(mktemp)"
  if bw_note "$ITEM_KEYSTORE" | base64 -d > "$tmpks" 2>/dev/null && [ -s "$tmpks" ]; then
    mkdir -p "$HOME/.android"
    if [ -f "$ks" ] && ! cmp -s "$ks" "$tmpks"; then
      cp "$ks" "$ks.bak-$(date +%Y%m%d-%H%M%S)"
      warn "your old debug keystore was backed up next to $ks"
    fi
    mv "$tmpks" "$ks"
    ok "team debug keystore installed (Google Sign-In works in debug builds)"
  else
    rm -f "$tmpks"
    warn "no '$ITEM_KEYSTORE' in Bitwarden — Google Sign-In needs your own SHA-1 registered"
  fi

  # The app's compile-time settings, pointing at THIS machine.
  local ip; ip="$(lan_ip)"
  cat > "$FLUTTER/.env.dev.json" <<EOF
{
  "BASE_URL": "http://$ip:3000",
  "APP_API_KEY": "$(env_get APP_API_KEY "$envf")",
  "GOOGLE_WEB_CLIENT_ID": "$(env_get GOOGLE_WEB_CLIENT_ID "$envf")"
}
EOF
  ok "app .env.dev.json (backend at http://$ip:3000)"
  umask 022
}

# -------------------------------------------------------------- backend --
ensure_docker() {
  if ! docker info >/dev/null 2>&1; then
    warn "Docker is not running — starting it (may ask for your password)"
    if have systemctl; then sudo systemctl start docker; fi
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info >/dev/null 2>&1 || die "Docker is not running (on Linux also check you are in the 'docker' group)"
  fi
}

start_postgres() {
  say "4/6 Postgres"
  ensure_docker
  # docker-compose.yml keeps Postgres internal; publish it to localhost only.
  cat > "$BACKEND/docker-compose.override.yml" <<'EOF'
# Written by setup.sh (git-ignored): lets `npm run dev` on the host reach Postgres.
services:
  postgres:
    ports:
      - "127.0.0.1:5432:5432"
EOF
  (cd "$BACKEND" && docker compose up -d postgres >/dev/null 2>&1) \
    || die "could not start Postgres (is port 5432 already used by a local Postgres?)"
  for _ in $(seq 1 30); do
    (cd "$BACKEND" && docker compose exec -T postgres pg_isready -U myassistant -d myassistant) >/dev/null 2>&1 && break
    sleep 2
  done
  if ! (cd "$BACKEND" && docker compose exec -T postgres psql -U myassistant -d postgres -Atc \
        "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'") | grep -q 1; then
    (cd "$BACKEND" && docker compose exec -T postgres createdb -U myassistant "$DB_NAME")
    ok "database $DB_NAME created"
  fi
  ok "Postgres ready on 127.0.0.1:5432"
}

stop_backend() {
  local pidf="$DEV_DIR/backend.pid"
  if [ -f "$pidf" ]; then
    local pid; pid="$(cat "$pidf")"
    if kill -0 "$pid" 2>/dev/null; then kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true; sleep 2; fi
    rm -f "$pidf"
  fi
}

start_backend() {
  say "5/6 backend"
  (cd "$BACKEND" && npm ci --no-audit --no-fund --loglevel=error)
  ok "npm packages installed"
  mkdir -p "$DEV_DIR"
  stop_backend
  if (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null; then
    die "port 3000 is already in use by another program — stop it and run setup again"
  fi
  # setsid: its own process group, so the next run can stop it cleanly.
  # exec: no shell is left behind waiting on it (or holding our stdout).
  (cd "$BACKEND" && exec nohup setsid npm run dev < /dev/null > "$DEV_DIR/backend.log" 2>&1) &
  echo $! > "$DEV_DIR/backend.pid"
  for _ in $(seq 1 45); do
    if curl -fsS -m 2 http://localhost:3000/health 2>/dev/null | grep -q '"ok":true'; then
      ok "backend running — http://localhost:3000 (log: $DEV_DIR/backend.log)"
      return
    fi
    sleep 2
  done
  tail -20 "$DEV_DIR/backend.log" >&2
  die "backend did not become healthy — see the log above"
}

# ------------------------------------------------------------------ app --
run_app() {
  say "6/6 Flutter app"
  export JAVA_HOME="$JAVA17"
  (cd "$FLUTTER" && flutter pub get >/dev/null)
  ok "packages fetched"
  [ "$MODE" = norun ] && return

  local dev="${ADB_DEVICE:-}"
  if [ -z "$dev" ]; then
    echo "    Connect your Android phone with USB debugging on (same Wi-Fi as this machine)…"
    for _ in $(seq 1 60); do
      dev="$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')"
      [ -n "$dev" ] && break
      sleep 2
    done
    [ -n "$dev" ] || die "no phone found (check 'adb devices'; accept the USB debugging prompt)"
  fi
  ok "phone $dev"

  local defines=(--dart-define-from-file=.env.dev.json)
  local tok; tok="$(tr -d '[:space:]' < "$FLUTTER/android/app-check-debug-token.txt" 2>/dev/null || true)"
  [ -n "$tok" ] && defines+=("--dart-define=APP_CHECK_DEBUG_TOKEN=$tok")

  echo
  echo "    Backend keeps running in the background. Stop it with:"
  echo "      kill -- -\$(cat $DEV_DIR/backend.pid)"
  echo "    Building and launching the app (first build takes a few minutes)…"
  cd "$FLUTTER"
  exec flutter run -d "$dev" "${defines[@]}"
}

# -------------------------------------------------------------- publish --
publish_secrets() {
  say "publishing this machine's secrets to Bitwarden"
  bw_unlock
  # An organization collection when one exists; otherwise the account's own
  # vault (the team shares one account, so that is enough).
  local coll org=""
  coll="$(bw list collections --search "$BW_COLLECTION" 2>/dev/null | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const c=JSON.parse(s).find(x=>x.name===process.argv[1]);if(c)console.log(c.id+" "+c.organizationId)}catch(e){}})' "$BW_COLLECTION")"
  if [ -n "$coll" ]; then
    org="${coll#* }"; coll="${coll% *}"
    ok "using collection '$BW_COLLECTION'"
  else
    ok "using the account's personal vault"
  fi

  local tmp; tmp="$(mktemp -d)"; chmod 700 "$tmp"
  grep -E '^[A-Z_]+=' "$BACKEND/.env" | grep -vE "^($PER_MACHINE_KEYS)=" > "$tmp/env"
  cp "$FLUTTER/android/app/google-services.json" "$tmp/gs" 2>/dev/null || true
  cp "$BACKEND/firebase-adminsdk.json" "$tmp/admin" 2>/dev/null || true
  cp "$FLUTTER/android/app-check-debug-token.txt" "$tmp/token" 2>/dev/null || true
  base64 < "$HOME/.android/debug.keystore" | tr -d '\n' > "$tmp/ks" 2>/dev/null || true

  put() { # item-name file
    [ -s "$2" ] || { warn "skipped '$1' (no local file)"; return; }
    local existing; existing="$(bw list items --search "$1" | node -e \
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s).find(x=>x.name===process.argv[1]);if(i)console.log(i.id)})' "$1")"
    local json; json="$(node -e '
      const fs=require("fs"); const [name,file,org,coll]=process.argv.slice(1);
      console.log(JSON.stringify({type:2,secureNote:{type:0},name,notes:fs.readFileSync(file,"utf8"),
        organizationId:org||null,collectionIds:coll?[coll]:[]}))' "$1" "$2" "$org" "$coll")"
    if [ -n "$existing" ]; then
      printf '%s' "$json" | bw encode | bw edit item "$existing" >/dev/null && ok "updated '$1'"
    else
      printf '%s' "$json" | bw encode | bw create item >/dev/null && ok "created '$1'"
    fi
  }
  put "$ITEM_ENV" "$tmp/env"
  put "$ITEM_ADMINSDK" "$tmp/admin"
  put "$ITEM_GSERVICES" "$tmp/gs"
  put "$ITEM_APPCHECK" "$tmp/token"
  put "$ITEM_KEYSTORE" "$tmp/ks"
  rm -rf "$tmp"
  bw sync >/dev/null
  echo; echo "Done. Teammates can now run ./setup.sh"
}

# ----------------------------------------------------------------- main --
check_tools
if [ "$MODE" = publish ]; then publish_secrets; exit 0; fi

say "2/6 updating both repos to origin/$BRANCH (local changes are discarded)"
sync_repo "$BACKEND" "$BACKEND_REPO"
sync_repo "$FLUTTER" "$FLUTTER_REPO"

write_secrets
start_postgres
start_backend
run_app
say "setup finished (--no-run: the app was not started)"
