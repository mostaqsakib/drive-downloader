"""
Run this ONCE on your local machine to obtain a Google Drive refresh token.

Steps:
  1. Go to https://console.cloud.google.com/ -> create a project.
  2. APIs & Services -> Library -> enable "Google Drive API".
  3. APIs & Services -> OAuth consent screen -> External -> fill app name +
     your email. Add your Gmail as a Test User.
  4. APIs & Services -> Credentials -> Create Credentials -> OAuth Client ID
     -> Application type: "Desktop app". Download the JSON, save as
     `client_secret.json` next to this file.
  5. pip install google-auth-oauthlib
  6. python get_refresh_token.py
  7. Browser opens -> log in with your Google account -> allow Drive access.
  8. Copy the printed refresh_token into Railway env var GOOGLE_REFRESH_TOKEN.
     Also copy client_id and client_secret from client_secret.json into
     GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.
"""

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/drive.file"]

if __name__ == "__main__":
    flow = InstalledAppFlow.from_client_secrets_file("client_secret.json", SCOPES)
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent")
    print("\n=== COPY THESE INTO RAILWAY ===")
    print(f"GOOGLE_CLIENT_ID={creds.client_id}")
    print(f"GOOGLE_CLIENT_SECRET={creds.client_secret}")
    print(f"GOOGLE_REFRESH_TOKEN={creds.refresh_token}")
