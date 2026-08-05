// ─────────────────────────────────────────────────────────────────────────────
// config.h — DriveSafe ESP32 firmware configuration
// ─────────────────────────────────────────────────────────────────────────────

#ifndef CONFIG_H
#define CONFIG_H

// ── WiFi ─────────────────────────────────────────────────────────────────────
#define WIFI_SSID     "0110"
#define WIFI_PASSWORD "devyanshu"

// ── Vision Backend (Python Flask) ────────────────────────────────────────────
// IP of the PC running the Flask backend on your local network
#define BACKEND_URL   "http://10.126.148.19:5000"

// ── Firebase Realtime Database ───────────────────────────────────────────────
#define FIREBASE_API_KEY    "AIzaSyA3N-HQseI0gVZ6CHtAYMX5dXi57jJjJUA"
#define FIREBASE_DB_URL     "https://driver-72b57-default-rtdb.asia-southeast1.firebasedatabase.app/"
#define FIREBASE_PROJECT_ID "driver-72b57"

// ── Firebase Database Secret (legacy auth for RTDB writes) ───────────────────
#define FIREBASE_DB_SECRET  "GOeEcP8jnFxRBo1zTfrs4wtkEb69jXxaTiarWslz"

#endif // CONFIG_H
