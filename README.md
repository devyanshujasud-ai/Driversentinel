# DriverSentinel — Multi-Factor Driver Fatigue Detection System

> **PS-17**: Real-time driver drowsiness detection using computer vision with adaptive thresholds,
> no false alarms, imperfect lighting support, and reliability reporting.

An end-to-end IoT system combining facial recognition, **multi-factor fatigue detection**
(eye closure + yawning + head nodding), RFID-based driver authentication, and a live fleet dashboard.

## PS-17 Compliance

| Requirement | Implementation |
|---|---|
| **Prolonged eye closure** | EAR (Eye Aspect Ratio) + PERCLOS (% closure over 60s sliding window) |
| **Yawning detection** | MAR (Mouth Aspect Ratio) using inner lip landmarks 60–67 |
| **Head nodding detection** | 3D head pose estimation via `cv2.solvePnP` (pitch/yaw/roll) |
| **Adaptive thresholds (no fixed cutoffs)** | 5-second per-driver calibration sets EAR/MAR baselines relative to individual face |
| **Avoid false alarms (blink filtering)** | Normal blinks (<350ms) filtered out; only closures >1.5s trigger micro-sleep |
| **Imperfect lighting** | CLAHE preprocessing on luminance channel before detection |
| **Reliability reporting** | Real-time confidence score (0–100%) based on lighting, landmark stability, head pose |
| **Composite fatigue metric** | Weighted multi-factor score (0–100): Eye 40% + Yawn 25% + Nod 20% + PERCLOS 15% |

## Architecture

```
┌───────────────┐     ┌──────────────────┐     ┌─────────────┐
│  TanStack      │ ←──→│  Flask Backend   │ ←──→│   ESP32     │
│  Frontend      │     │  (vision-backend)│     │  Firmware   │
│  (drivesafe/)  │     │                  │     │             │
└───────┬───────┘     └────────┬─────────┘     └──────┬──────┘
        │                      │                       │
        └──────────┬───────────┘───────────────────────┘
                   ▼
          Firebase Realtime DB
          (live dashboard data)
```

---

## 1. Backend Setup (`vision-backend/`)

### Install dependencies

```bash
cd vision-backend
pip install -r requirements.txt
```

### Download the dlib landmark model

```bash
python download_model.py
```

This downloads the 68-point facial landmark predictor (~100 MB) from dlib.net.

### Configure environment

```bash
cp .env.example .env
# Edit .env with your ESP32 IP address and desired port
```

| Variable    | Description                         | Default           |
|-------------|-------------------------------------|-------------------|
| `ESP32_IP`  | ESP32 IP address on local network   | `192.168.1.100`   |
| `PORT`      | Flask server port                   | `5000`            |

### Run the backend

```bash
python app.py
```

The server starts on `http://0.0.0.0:5000` by default.

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check — `{ "status": "ok" }` |
| `/verify` | POST | Face verification (multipart image) |
| `/enroll` | POST | Enroll driver (multipart image + name + rfid) |
| `/drivers` | GET | List enrolled drivers |
| `/monitor/start` | POST | Start multi-factor fatigue detection |
| `/monitor/stop` | POST | Stop fatigue detection |
| `/monitor/status` | GET | **Full telemetry**: EAR, MAR, pitch, fatigue score, PERCLOS, reliability, alert state |
| `/monitor/calibrate` | POST | Trigger re-calibration for current driver |
| `/video_feed` | GET | MJPEG stream with annotated HUD |
| `/verify/prepare` | POST | Release camera for browser face capture |

### Monitor Status Response (example)

```json
{
  "running": true,
  "ear": 0.312,
  "mar": 0.185,
  "head_pitch": -3.2,
  "head_yaw": 1.5,
  "head_roll": 0.8,
  "is_calibrated": true,
  "calibration_progress": 100,
  "fatigue_score": 18,
  "reliability_score": 92,
  "reliability_status": "Optimal",
  "is_yawning": false,
  "is_nodding": false,
  "is_eye_closed": false,
  "is_drowsy": false,
  "alert_state": "Normal",
  "perclos": 3.2,
  "blink_rate": 14,
  "yawn_count": 0,
  "ear_threshold": 0.221,
  "mar_threshold": 0.574,
  "baseline_ear": 0.316,
  "baseline_mar": 0.319
}
```

---

## 2. Frontend Setup (`drivesafe/`)

### Environment variables

The frontend reads from `drivesafe/.env` (or the workspace root `.env`):

| Variable                  | Description                        |
|---------------------------|------------------------------------|
| `VITE_FIREBASE_API_KEY`   | Firebase API key                   |
| `VITE_FIREBASE_DB_URL`    | Firebase Realtime Database URL     |
| `VITE_FIREBASE_PROJECT_ID`| Firebase project ID                |
| `VITE_BACKEND_URL`        | Vision backend URL (e.g. `http://localhost:5000`) |

### Install and run

```bash
cd drivesafe
npm install   # or: bun install
npm run dev   # or: bun run dev
```

The frontend runs on `http://localhost:3000` (default Vite port).

---

## 3. Seed Firebase with sample data

```bash
cd vision-backend
python seed_firebase.py
```

---

## 4. ESP32 Firmware (`esp32-firmware/`)

### Required Arduino libraries

Install via Arduino Library Manager:
- **Firebase_ESP_Client** (by mobizt)
- **Adafruit SSD1306**
- **Adafruit GFX**
- **ArduinoJson**

### Configuration

Edit `esp32-firmware/config.h`:
- Set `WIFI_SSID` and `WIFI_PASSWORD`
- Set `BACKEND_URL` to your Flask backend IP
- Firebase credentials are pre-filled from the project `.env`

### Upload

1. Open `esp32-firmware/esp32-firmware.ino` in Arduino IDE
2. Select board: **ESP32 Dev Module**
3. Upload

---

## 5. Detection Algorithm Details

### Adaptive Calibration (5-second auto-calibration)
1. When monitoring starts, the system collects EAR, MAR, and head pitch samples for 5 seconds
2. Median values become the driver's **baseline** (robust to blinks during calibration)
3. Thresholds are set **relative** to the baseline:
   - `EAR_threshold = baseline_EAR × 0.70`
   - `MAR_threshold = max(0.45, baseline_MAR × 1.80)`
4. Re-calibration can be triggered via `/monitor/calibrate` endpoint

### CLAHE Preprocessing
- Converts frame to grayscale
- Applies `cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))`
- Normalizes contrast for dim, twilight, and harsh-shadow conditions

### Blink vs. Micro-sleep Filter
| Duration | Classification | Action |
|---|---|---|
| < 350ms | Normal blink | Counted for blink rate only |
| 350ms – 1.5s | Long blink | Monitored, no alert |
| > 1.5s | **Micro-sleep** | Alert triggered to ESP32 |

### Head Pose Estimation
- Uses 6 landmark points (nose, chin, eye corners, mouth corners)
- Maps to a generic 3D face model
- `cv2.solvePnP` computes pitch/yaw/roll
- Head nodding = pitch drop > 15° from baseline for > 1 second

### Composite Fatigue Score
```
Fatigue = 0.40 × EyeScore + 0.25 × YawnScore + 0.20 × NodScore + 0.15 × PERCLOSScore
```

### Reliability Score
```
Reliability = 0.35 × LightingScore + 0.35 × LandmarkStability + 0.30 × (100 - PosePenalty)
```

---

## 6. Project Structure

```
DriverSentinel/
├── .env                           # shared Firebase + backend env vars
├── README.md                      # ← you are here
├── drivesafe/                     # TanStack Start + React 19 frontend
│   ├── src/
│   │   ├── routes/                # verify, admin, dashboard pages
│   │   ├── components/            # Navbar, StatusBadge, CameraPanel
│   │   └── lib/                   # backend.ts, firebase.ts, env.ts
│   └── package.json
├── vision-backend/                # Python Flask backend
│   ├── app.py                     # main Flask app (all routes)
│   ├── fatigue_detector.py        # ★ multi-factor detection engine
│   ├── drowsiness.py              # legacy EAR-only module (kept for reference)
│   ├── download_model.py          # dlib model downloader
│   ├── seed_firebase.py           # Firebase RTDB seeder
│   ├── requirements.txt
│   ├── .env.example
│   └── faces.pkl                  # (generated) enrolled face encodings
└── esp32-firmware/                # Arduino ESP32 firmware
    ├── esp32-firmware.ino
    └── config.h
```
