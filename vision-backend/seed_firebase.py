"""
seed_firebase.py -- Push sample data into Firebase Realtime Database.

Reads the VITE_FIREBASE_* values from the sibling drivesafe/.env or root .env
and uses the Firebase REST API to seed:
  - status          (current driver state)
  - status/location (vehicle GPS position)
  - events          (sample event log)
  - drivers         (sample enrolled drivers)

Usage:
    python seed_firebase.py
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

# Force UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

# -- locate the frontend .env -------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE_ROOT = os.path.dirname(SCRIPT_DIR)

ENV_CANDIDATES = [
    os.path.join(WORKSPACE_ROOT, ".env"),
    os.path.join(WORKSPACE_ROOT, "drivesafe", ".env"),
    os.path.join(WORKSPACE_ROOT, "drivesafe-frontend", ".env"),
]


def _load_env_vars() -> dict:
    """Parse VITE_FIREBASE_* vars from the first .env file found."""
    for path in ENV_CANDIDATES:
        if os.path.isfile(path):
            print(f"Reading env from: {path}")
            env = {}
            with open(path, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, _, val = line.partition("=")
                        env[key.strip()] = val.strip()
            return env
    raise FileNotFoundError(
        "Could not find .env file. Looked in:\n  " + "\n  ".join(ENV_CANDIDATES)
    )


def _firebase_put(db_url: str, secret: str, path: str, data: object) -> None:
    """PUT JSON data to a Firebase RTDB path via the REST API."""
    url = f"{db_url.rstrip('/')}/{path}.json?auth={secret}"
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="PUT")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"  PUT {path} -> {resp.status}")
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        print(f"  PUT {path} -> ERROR {exc.code}: {err_body}")


# Firebase database secret (legacy auth)
FIREBASE_DB_SECRET = "GOeEcP8jnFxRBo1zTfrs4wtkEb69jXxaTiarWslz"


def main():
    env = _load_env_vars()

    db_url = env.get("VITE_FIREBASE_DB_URL", "")

    if not db_url:
        print("ERROR: VITE_FIREBASE_DB_URL not found in .env")
        return

    secret = FIREBASE_DB_SECRET
    print(f"Firebase DB: {db_url}")
    print()

    now_ms = int(time.time() * 1000)

    # -- status ----------------------------------------------------------------
    print("Seeding 'status' ...")
    _firebase_put(db_url, secret, "status", {
        "state": "normal",
        "driver": "A. Ramirez",
        "sessionStart": now_ms - 3_723_000,
        "battery": 82,
        "signal": "LTE - Strong",
        "location": {
            "lat": 19.0760,
            "lng": 72.8777,
            "updated": now_ms,
        },
    })

    # -- events ----------------------------------------------------------------
    print("Seeding 'events' ...")
    _firebase_put(db_url, secret, "events", {
        "evt_001": {
            "time": now_ms - 1_800_000,
            "type": "Face Verified",
            "driver": "A. Ramirez",
        },
        "evt_002": {
            "time": now_ms - 640_000,
            "type": "Drowsiness",
            "driver": "A. Ramirez",
        },
        "evt_003": {
            "time": now_ms - 62_000,
            "type": "Pre-Alert",
            "driver": "A. Ramirez",
        },
        "evt_004": {
            "time": now_ms - 30_000,
            "type": "Break Taken",
            "driver": "A. Ramirez",
        },
    })

    # -- drivers ---------------------------------------------------------------
    print("Seeding 'drivers' ...")
    _firebase_put(db_url, secret, "drivers", {
        "drv_001": {
            "name": "A. Ramirez",
            "rfid": "04 A2 3F 91",
            "enrolledAt": now_ms - 86_400_000,
        },
        "drv_002": {
            "name": "S. Patel",
            "rfid": "04 B7 21 E3",
            "enrolledAt": now_ms - 172_800_000,
        },
        "drv_003": {
            "name": "K. Tanaka",
            "rfid": "04 C9 55 F7",
            "enrolledAt": now_ms - 259_200_000,
        },
    })

    print()
    print("Done! Firebase seeded successfully.")


if __name__ == "__main__":
    main()
