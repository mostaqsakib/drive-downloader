# DriveGrabber VPS Setup

This is the backend that runs on **your** VPS. It receives download requests
from the DriveGrabber Lovable site, runs `yt-dlp`, then uploads the file to
**your** Google Drive using `rclone`.

## Requirements

- Ubuntu 22.04+ / Debian 12 VPS (1 vCPU / 1 GB RAM works; 2 GB+ recommended)
- Root SSH access
- A domain pointing to the VPS (recommended, for HTTPS) — e.g. `dg.yourdomain.com`

## 1. Copy files to the VPS

From your local machine:

```bash
scp -r vps root@YOUR_VPS_IP:/root/drivegrabber
ssh root@YOUR_VPS_IP
cd /root/drivegrabber
```

Or download the files directly on the VPS from your Lovable project's GitHub export.

## 2. Run the installer

```bash
sudo bash install.sh
```

This installs Node 20, yt-dlp, ffmpeg, rclone, creates a `drivegrabber` system
user, sets up a systemd service, and generates a random `API_TOKEN`.

**⚠️ Copy the printed `API_TOKEN`** — you'll paste it into Lovable as `VPS_API_TOKEN`.

## 3. Connect Google Drive via rclone

Rclone must be configured as the `drivegrabber` user so the service can read
the config:

```bash
sudo -u drivegrabber rclone config
```

Answer the prompts:
- `n` → new remote
- name: `gdrive`
- storage: `drive` (Google Drive)
- `client_id` / `client_secret`: press Enter (use rclone's built-in — OK for personal use, or create your own at <https://console.cloud.google.com/apis/credentials>)
- scope: `1` (full access)  — needed to create/read files
- `service_account_file`: press Enter
- `Edit advanced config?`: `n`
- `Use auto config?`:
  - If your VPS has a browser: `y`
  - If headless (typical): `n` — rclone gives you a command to run **on your laptop**:
    ```
    rclone authorize "drive" "..."
    ```
    Run that locally, log in with Google, copy the token JSON back into the SSH prompt.
- `Configure this as a Shared Drive?`: `n`
- Confirm → `q` to quit.

Test it:

```bash
sudo -u drivegrabber rclone lsd gdrive:
```

You should see your Drive folders.

## 4. Start the service

```bash
sudo systemctl start drivegrabber
sudo systemctl status drivegrabber
curl http://localhost:8787/health
```

Expected: `{"ok":true,"queued":0,"running":0}`

## 5. Put HTTPS in front (recommended)

Lovable calls your VPS from Cloudflare Workers — it needs a valid HTTPS URL.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

# /etc/nginx/sites-available/drivegrabber
sudo tee /etc/nginx/sites-available/drivegrabber >/dev/null <<'NGINX'
server {
    listen 80;
    server_name dg.yourdomain.com;
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
NGINX

sudo ln -sf /etc/nginx/sites-available/drivegrabber /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d dg.yourdomain.com
```

Then test from anywhere:

```bash
curl https://dg.yourdomain.com/health
```

## 6. Connect Lovable

In your Lovable project, add two secrets:

| Name            | Value                                           |
|-----------------|-------------------------------------------------|
| `VPS_API_URL`   | `https://dg.yourdomain.com`                     |
| `VPS_API_TOKEN` | The `API_TOKEN` from step 2 (`/etc/drivegrabber/env`) |

That's it — paste a video URL on the site and it lands in your Drive under `DriveGrabber/`.

## Firewall (if not using Nginx/Cloudflare)

If you expose port `8787` directly instead of proxying through Nginx:

```bash
sudo ufw allow 8787/tcp
```

Prefer HTTPS in front — plain-HTTP tokens can be sniffed.

## Optional: cookies for Instagram / Facebook / etc.

Some sites require you to be logged in. Export cookies from your browser
(e.g. via the "Get cookies.txt" extension) and save the file:

```bash
sudo mkdir -p /etc/drivegrabber
sudo nano /etc/drivegrabber/cookies.txt   # paste the exported cookies
sudo chown drivegrabber:drivegrabber /etc/drivegrabber/cookies.txt
sudo chmod 600 /etc/drivegrabber/cookies.txt
```

Then add to `/etc/drivegrabber/env`:

```
COOKIES_FILE=/etc/drivegrabber/cookies.txt
```

Restart: `sudo systemctl restart drivegrabber`.

## Updating yt-dlp

yt-dlp releases fixes almost weekly:

```bash
sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
sudo chmod +x /usr/local/bin/yt-dlp
sudo systemctl restart drivegrabber
```

## Logs

```bash
sudo journalctl -u drivegrabber -f
```

## Uninstall

```bash
sudo systemctl disable --now drivegrabber
sudo rm /etc/systemd/system/drivegrabber.service
sudo rm -rf /opt/drivegrabber /var/lib/drivegrabber /etc/drivegrabber
sudo userdel drivegrabber
```
