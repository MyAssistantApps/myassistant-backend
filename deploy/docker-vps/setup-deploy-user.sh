#!/usr/bin/env bash
# ONE-TIME: let GitHub Actions deploy without root SSH.
#
# Root login over SSH is off (/etc/ssh/sshd_config.d/01-hardening.conf), so
# the deploy key lives on the unprivileged user `ghdeploy`, with a forced
# command: the key can run /usr/local/bin/myassistant-deploy and nothing
# else, and that wrapper may only `sudo /opt/myassistant/deploy.sh` with a
# validated command. No shell, no port forwarding, no other sudo.
#
# Usage (as root, once):  bash setup-deploy-user.sh "<public key line>"
set -euo pipefail
PUB="${1:?pass the deploy public key line}"

id ghdeploy >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash ghdeploy
install -d -m 700 -o ghdeploy -g ghdeploy /home/ghdeploy/.ssh

cat > /usr/local/bin/myassistant-deploy <<'WRAP'
#!/usr/bin/env bash
# Forced command for the GitHub deploy key: validates, then runs the deploy.
set -euo pipefail
read -r mode sha extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "${extra:-}" ] || { echo "unexpected arguments" >&2; exit 2; }
case "$mode" in
  deploy-image) [[ "${sha:-}" =~ ^[0-9a-f]{7,40}$ ]] || { echo "bad sha" >&2; exit 2; }
                exec sudo -n /opt/myassistant/deploy.sh deploy-image "$sha" ;;
  deploy)       exec sudo -n /opt/myassistant/deploy.sh deploy ;;
  *)            echo "allowed: deploy-image <sha> | deploy" >&2; exit 2 ;;
esac
WRAP
chmod 755 /usr/local/bin/myassistant-deploy

cat > /etc/sudoers.d/ghdeploy <<'SUDO'
ghdeploy ALL=(root) NOPASSWD: /opt/myassistant/deploy.sh deploy-image *, /opt/myassistant/deploy.sh deploy
SUDO
chmod 440 /etc/sudoers.d/ghdeploy
visudo -cf /etc/sudoers.d/ghdeploy

echo "command=\"/usr/local/bin/myassistant-deploy\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty $PUB" \
  > /home/ghdeploy/.ssh/authorized_keys
chown ghdeploy:ghdeploy /home/ghdeploy/.ssh/authorized_keys
chmod 600 /home/ghdeploy/.ssh/authorized_keys
echo "ghdeploy ready"
