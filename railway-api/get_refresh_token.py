"""
Run ONCE locally to get a Google Drive refresh token.

Steps:
  1. https://console.cloud.google.com/ -> create a project.
  2. APIs & Services -> Library -> enable "Google Drive API".
  3. OAuth consent screen -> External -> add your Gmail as Test User.
  4. Credentials -> Create Credentials -> OAuth Client ID ->
     Application type: "Desktop app". Download JSON as `client_secret.json`
     next to this file.
  5. pip install google-auth-oauthlib
  6. python get_refresh_token.py
  7. Copy the printed values into Railway env vars.
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
