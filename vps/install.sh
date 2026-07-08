#!/usr/bin/env bash
# DriveGrabber VPS installer — Ubuntu 22.04+/Debian 12
# Run as root:  sudo bash install.sh
set -euo pipefail

APP_DIR="/opt/drivegrabber"
DATA_DIR="/var/lib/drivegrabber"
ENV_DIR="/etc/drivegrabber"
SERVICE_USER="drivegrabber"

echo "==> Installing system packages"
apt-get update -y
apt-get install -y curl ca-certificates gnupg build-essential python3 python3-pip ffmpeg unzip

echo "==> Installing Node.js 20"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing yt-dlp"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

echo "==> Installing rclone"
if ! command -v rclone >/dev/null; then
  curl -fsSL https://rclone.org/install.sh | bash
fi

echo "==> Creating service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"

mkdir -p "$APP_DIR" "$DATA_DIR/downloads" "$ENV_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

echo "==> Copying app files"
cp -f "$(dirname "$0")/server.js" "$APP_DIR/server.js"
cp -f "$(dirname "$0")/package.json" "$APP_DIR/package.json"

echo "==> Installing npm deps"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> Generating env file (if missing)"
if [[ ! -f "$ENV_DIR/env" ]]; then
  TOKEN="$(openssl rand -hex 32)"
  cat > "$ENV_DIR/env" <<EOF
API_TOKEN=$TOKEN
PORT=8787
DOWNLOAD_DIR=$DATA_DIR/downloads
DB_PATH=$DATA_DIR/jobs.db
RCLONE_REMOTE=gdrive
RCLONE_DEST=DriveGrabber
CONCURRENCY=2
EOF
  chmod 600 "$ENV_DIR/env"
  echo ""
  echo "  ✅ API_TOKEN generated. Copy this into your Lovable project secret VPS_API_TOKEN:"
  echo ""
  echo "      $TOKEN"
  echo ""
else
  echo "  (env file already exists at $ENV_DIR/env — keeping it)"
fi

echo "==> Writing systemd unit"
cat > /etc/systemd/system/drivegrabber.service <<UNIT
[Unit]
Description=DriveGrabber VPS worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_DIR/env
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable drivegrabber.service

echo ""
echo "==> Next steps:"
echo "   1. Run:  sudo -u $SERVICE_USER rclone config"
echo "      Create a remote named 'gdrive' → type: drive → follow OAuth prompts."
echo "   2. Start the service:  sudo systemctl start drivegrabber"
echo "   3. Check status:       sudo systemctl status drivegrabber"
echo "   4. Test:               curl http://localhost:8787/health"
echo "   5. Put HTTPS in front (Nginx + Certbot) — see README.md"
echo ""
