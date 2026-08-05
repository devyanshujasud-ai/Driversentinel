# DriveSafe — IoT Driver Fatigue Monitoring System

An end-to-end IoT system combining facial recognition, real-time drowsiness detection, RFID-based driver authentication, and a live fleet dashboard.

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
|-------------|-------------------------------------|--------------------|
| `ESP32_IP`  | ESP32 IP address on local network   | `192.168.1.100`   |
| `PORT`      | Flask server port                   | `5000`            |

### Run the backend

```bash
python app.py
```

The server starts on `http://0.0.0.0:5000` by default.

### Enroll a test driver via curl

```bash
curl -X POST http://localhost:5000/enroll \
  -F "name=A. Ramírez" \
  -F "rfid=04 A2 3F 91" \
  -F "image=@path/to/face_photo.jpg"
```

Expected response:
```json
{ "enrolled": true, "name": "A. Ramírez", "rfid": "04 A2 3F 91" }
```

### Verify a driver via curl

```bash
curl -X POST http://localhost:5000/verify \
  -F "image=@path/to/face_photo.jpg"
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

This pushes sample data to `status`, `events`, and `drivers` paths so the dashboard has data to display immediately.

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

## 5. Manual End-to-End Test Checklist

### Prerequisites
- [ ] Backend running (`python app.py`)
- [ ] Frontend running (`npm run dev`)
- [ ] ESP32 powered on and connected to WiFi
- [ ] Firebase seeded (`python seed_firebase.py`)

### Test flow

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | Open the frontend in browser | Navbar backend dot turns **green** (Online) |
| 2 | Navigate to **Admin** page | Enrollment form loads, enrolled drivers table shows seeded data |
| 3 | Enroll a driver: fill name + RFID, capture photo, click Enroll | Toast says "Name enrolled", driver appears in table |
| 4 | Navigate to **Verify** page | Camera feed loads |
| 5 | Click **Capture & Verify** with enrolled face | Green success card: driver name + "Proceed to RFID tap" |
| 6 | Click **Capture & Verify** with unknown face | Red failure card: "Face not recognized — access denied" |
| 7 | Navigate to **Dashboard** | Live status card, event log, map showing vehicle position |
| 8 | On ESP32: tap RFID or trigger /verify | Dashboard updates: driver name, session timer starts |
| 9 | Wait or simulate drowsiness | Dashboard: Pre-Alert badge, Drowsiness event in log |
| 10 | Press SOS button on ESP32 (or exceed driving time) | Dashboard: "Exceeded / SOS" badge, red alert banner appears |
| 11 | Click **Acknowledge** on the SOS banner | Banner dismisses |

---

## Project Structure

```
anjuman/
├── .env                        # shared Firebase + backend env vars
├── README.md                   # ← you are here
├── drivesafe/                  # TanStack Start + React 19 frontend
│   ├── src/
│   │   ├── routes/             # verify, admin, dashboard pages
│   │   ├── components/         # Navbar, StatusBadge, CameraPanel
│   │   └── lib/                # backend.ts, firebase.ts, env.ts
│   └── package.json
├── vision-backend/             # Python Flask backend
│   ├── app.py                  # main Flask app
│   ├── drowsiness.py           # EAR-based drowsiness detection
│   ├── download_model.py       # dlib model downloader
│   ├── seed_firebase.py        # Firebase RTDB seeder
│   ├── requirements.txt
│   ├── .env.example
│   └── faces.pkl               # (generated) enrolled face encodings
└── esp32-firmware/             # Arduino ESP32 firmware
    ├── esp32-firmware.ino
    └── config.h
```
