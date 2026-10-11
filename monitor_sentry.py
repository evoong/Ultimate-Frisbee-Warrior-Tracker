import requests, json, os

SENTRY_URL = "https://sentry.io/api/0/projects/eric-4a/ufwt-backend/issues/"
SENTRY_AUTH = os.environ.get("SENTRY_AUTH_TOKEN") # Note: This script assumes auth token provided via env.
# PUTER doesn't have secrets.

def get_sentry_issues():
    if not SENTRY_AUTH:
        print("SENTRY_AUTH_TOKEN missing")
        return []
    res = requests.get(SENTRY_URL, headers={"Authorization": f"Bearer {SENTRY_AUTH}"})
    return res.json()

def check_frisbee_app():
    # Production URL from CLOUDFLARE_DEPLOYMENT.md
    url = "https://ultimate-frisbee-warrior-tracker.ericxvoong.workers.dev/"
    try:
        res = requests.get(url, timeout=10)
        return res.status_code == 200
    except:
        return False

print(f"App healthy: {check_frisbee_app()}")
