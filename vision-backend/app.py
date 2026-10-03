"""
DriverSentinel Vision Backend — app.py

Flask application providing face-verification, driver-enrollment, and
multi-factor fatigue monitoring endpoints.

Routes
------
GET  /health            → { "status": "ok" }
POST /verify            → multipart image → { "verified": bool, "name": str }
POST /enroll            → multipart image+name+rfid → { "enrolled": bool, ... }
GET  /drivers           → { "drivers": [...] }
POST /monitor/start     → start fatigue-detection thread
POST /monitor/stop      → stop fatigue-detection thread
GET  /monitor/status    → real-time telemetry (EAR, MAR, pitch, fatigue score, ...)
POST /monitor/calibrate → trigger re-calibration of adaptive thresholds
GET  /video_feed        → MJPEG stream with annotated HUD
POST /verify/prepare    → release camera for browser face capture
"""

import io
import logging
import os
import pickle
import time
from datetime import datetime, timezone

import face_recognition
import numpy as np
from dotenv import load_dotenv
from flask import Flask, jsonify, request, Response
from flask_cors import CORS

from fatigue_detector import FatigueMonitor
from serial_bridge import serial_bridge

# Start USB Serial background listener for ESP32 COM port
serial_bridge.start()

# ── configuration ────────────────────────────────────────────────────────────
load_dotenv()

ESP32_IP = os.getenv("ESP32_IP", "192.168.1.100")
PORT = int(os.getenv("PORT", "5000"))
FACES_PKL = os.path.join(os.path.dirname(__file__), "faces.pkl")

# ── app setup ────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)  # allow cross-origin from the Vite dev-server

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger("drivesafe")

# ── face database ────────────────────────────────────────────────────────────
# faces.pkl stores a list of dicts:
#   { "name": str, "rfid": str, "encoding": np.ndarray, "enrolled_at": str }


def _load_faces() -> list[dict]:
    """Load the enrolled-faces database from disk."""
    if not os.path.isfile(FACES_PKL):
        return []
    with open(FACES_PKL, "rb") as fh:
        return pickle.load(fh)


def _save_faces(faces: list[dict]) -> None:
    """Persist the enrolled-faces database to disk."""
    with open(FACES_PKL, "wb") as fh:
        pickle.dump(faces, fh) 


# ── fatigue monitor singleton ────────────────────────────────────────────────
monitor = FatigueMonitor(esp32_ip=ESP32_IP)


# ── routes ───────────────────────────────────────────────────────────────────
@app.route("/health", methods=["GET"])
def health():
    """Health-check endpoint consumed by the frontend navbar status dot."""
    return jsonify({"status": "ok"}), 200


@app.route("/verify", methods=["POST"])
def verify():
    """
    Accept a multipart/form-data POST with an ``image`` file field.
    Compare against enrolled faces and return the match result.

    On success, automatically POSTs to the ESP32 /verify endpoint with the
    matched driver name and their enrolled RFID UID to unlock the pending
    RFID-to-face verification on the device.

    Success → 200  { "verified": true, "name": "...", "rfid": "...", "esp32_unlocked": bool }
    Failure → 404  { "verified": false, "error": "<reason>" }
    """
    # ── Release the camera if the fatigue monitor is using it ────────
    # On Windows the webcam is exclusive; the browser needs it for the
    # face-capture, so we must stop OpenCV's hold on the device first.
    monitor_was_running = monitor.running
    if monitor_was_running:
        monitor.stop()
        logger.info("Monitor paused for face verification (camera released)")

    if "image" not in request.files:
        return jsonify({"verified": False, "error": "No image provided"}), 400

    file = request.files["image"]
    img_bytes = file.read()
    if not img_bytes:
        return jsonify({"verified": False, "error": "Empty image file"}), 400

    # Decode image
    img_array = face_recognition.load_image_file(io.BytesIO(img_bytes))
    encodings = face_recognition.face_encodings(img_array)

    if not encodings:
        return jsonify({"verified": False, "error": "No face detected in image"}), 404

    probe = encodings[0]
    faces = _load_faces()

    if not faces:
        return jsonify({"verified": False, "error": "No drivers enrolled yet"}), 404

    known_encodings = [f["encoding"] for f in faces]
    known_names = [f["name"] for f in faces]

    # Compare against all enrolled faces
    distances = face_recognition.face_distance(known_encodings, probe)
    best_idx = int(np.argmin(distances))
    best_distance = distances[best_idx]

    # face_recognition tolerance (0.65 allows typical webcam lighting variations)
    if best_distance <= 0.65:
        matched_face = faces[best_idx]
        matched_name = matched_face["name"]
        matched_rfid = matched_face.get("rfid", "")
        logger.info("Verified: %s (distance %.3f, RFID %s)", matched_name, best_distance, matched_rfid)

        # ── Auto-POST to ESP32 in background so verify responds immediately ──
        import threading
        def notify_esp32_bg():
            # 1. Direct USB Serial unlock
            try:
                serial_bridge.send_unlock()
            except Exception as e:
                logger.debug("Serial unlock failed: %s", e)

            # 2. Network backup (try both /unlock and /verify endpoints on ESP32)
            try:
                import requests as http_requests
                payload = {"name": matched_name, "rfid": matched_rfid}
                for ep in ["/unlock", "/verify"]:
                    try:
                        esp32_url = f"http://{ESP32_IP}{ep}"
                        logger.info("Sending unlock to ESP32: %s → %s", esp32_url, payload)
                        resp = http_requests.post(
                            esp32_url,
                            json=payload,
                            timeout=2.0,
                        )
                        if resp.status_code == 200:
                            logger.info("ESP32 unlock OK via %s (HTTP %d)", ep, resp.status_code)
                            break
                    except Exception as ep_err:
                        logger.debug("ESP32 endpoint %s failed: %s", ep, ep_err)
            except Exception as exc:
                logger.warning("Could not reach ESP32 at %s: %s", ESP32_IP, exc)

        threading.Thread(target=notify_esp32_bg, daemon=True).start()

        result = {
            "verified": True,
            "name": matched_name,
            "rfid": matched_rfid,
            "esp32_unlocked": True,
        }
        return jsonify(result), 200
    else:
        logger.info("Verification failed (best distance %.3f, closest: %s)", best_distance, known_names[best_idx])
        return jsonify({
            "verified": False,
            "error": f"Face not recognized (Closest match: {known_names[best_idx]} with distance {best_distance:.2f}, limit: 0.65). Please enroll your face on Admin page.",
            "closest": known_names[best_idx],
            "distance": float(best_distance),
        }), 404


@app.route("/enroll", methods=["POST"])
def enroll():
    """
    Accept a multipart/form-data POST with ``image``, ``name``, and ``rfid``
    fields.  Compute a face encoding and persist it to faces.pkl.

    Success → 200  { "enrolled": true, "name": "...", "rfid": "..." }
    Failure → 400  { "error": "<reason>" }
    """
    if "image" not in request.files:
        return jsonify({"error": "No image provided"}), 400

    name = request.form.get("name", "").strip()
    rfid = request.form.get("rfid", "").strip()

    if not name:
        return jsonify({"error": "Driver name is required"}), 400
    if not rfid:
        return jsonify({"error": "RFID UID is required"}), 400

    file = request.files["image"]
    img_bytes = file.read()
    if not img_bytes:
        return jsonify({"error": "Empty image file"}), 400

    # Decode image and compute encoding
    img_array = face_recognition.load_image_file(io.BytesIO(img_bytes))
    encodings = face_recognition.face_encodings(img_array)

    if not encodings:
        return jsonify({"error": "No face detected in the image"}), 400

    encoding = encodings[0]

    # Persist
    faces = _load_faces()
    faces.append(
        {
            "name": name,
            "rfid": rfid,
            "encoding": encoding,
            "enrolled_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    _save_faces(faces)

    logger.info("Enrolled driver: %s (RFID %s)", name, rfid)
    return (
        jsonify({"enrolled": True, "name": name, "rfid": rfid}),
        200,
    )


@app.route("/drivers", methods=["GET"])
def get_drivers():
    """Return list of all enrolled drivers from faces.pkl."""
    faces = _load_faces()
    drivers_list = [
        {
            "name": f.get("name", "Unknown"),
            "rfid": f.get("rfid", ""),
            "enrolledAt": f.get("enrolled_at", ""),
        }
        for f in faces
    ]
    return jsonify({"drivers": drivers_list}), 200



@app.route("/monitor/start", methods=["POST"])
def monitor_start():
    """Start the multi-factor fatigue detection background thread."""
    try:
        started = monitor.start()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 500

    if started:
        logger.info("Fatigue monitor started via /monitor/start")
        return jsonify({"monitoring": True, "message": "Fatigue monitor started"}), 200
    else:
        return jsonify({"monitoring": True, "message": "Monitor already running"}), 200


@app.route("/monitor/stop", methods=["POST"])
def monitor_stop():
    """Stop the fatigue detection background thread."""
    stopped = monitor.stop()
    if stopped:
        logger.info("Fatigue monitor stopped via /monitor/stop")
        return jsonify({"monitoring": False, "message": "Fatigue monitor stopped"}), 200
    else:
        return jsonify({"monitoring": False, "message": "Monitor was not running"}), 200


@app.route("/monitor/calibrate", methods=["POST"])
def monitor_calibrate():
    """Trigger re-calibration of adaptive thresholds for the current driver."""
    success = monitor.recalibrate()
    if success:
        logger.info("Re-calibration requested via /monitor/calibrate")
        return jsonify({"calibrating": True, "message": "Re-calibration started"}), 200
    else:
        return jsonify({"calibrating": False, "message": "Monitor is not running"}), 400


@app.route("/verify/prepare", methods=["POST"])
def verify_prepare():
    """
    Release the camera so the browser can access it for face verification.
    Called by the frontend before opening the webcam in the auto-popup modal.
    """
    was_running = monitor.running
    if was_running:
        monitor.stop()
        logger.info("Camera released for browser face verification")
    return jsonify({"camera_released": True, "monitor_was_running": was_running}), 200


@app.route("/esp32/register", methods=["POST", "GET"])
def esp32_register():
    """Register ESP32 device IP address automatically when it boots and connects to WiFi."""
    global ESP32_IP
    ip = request.args.get("ip") or (request.is_json and request.json.get("ip")) or request.remote_addr
    if ip:
        ESP32_IP = ip
        monitor._esp32_ip = ip
        logger.info("ESP32 registered with IP: %s", ip)
        return jsonify({"registered": True, "esp32_ip": ip}), 200
    return jsonify({"error": "No IP provided"}), 400


@app.route("/esp32/rfid", methods=["POST", "GET"])
def esp32_rfid():
    """Triggered directly by ESP32 via HTTP when RFID card is tapped."""
    driver = request.args.get("driver") or (request.is_json and request.json.get("driver")) or "DRIVER 1"
    rfid = request.args.get("rfid") or (request.is_json and request.json.get("rfid")) or "B33D0204"
    logger.info("[ESP32] Direct RFID tap received from ESP32: %s (%s)", driver, rfid)
    try:
        import requests as http_requests
        url = "https://driver-72b57-default-rtdb.asia-southeast1.firebasedatabase.app/pending.json"
        http_requests.put(url, json={"driver": driver, "rfid": rfid, "time": int(time.time() * 1000)}, timeout=3)
        logger.info("[ESP32] Synced to Firebase /pending: %s", driver)
    except Exception as e:
        logger.warning("[ESP32] Failed to sync /pending to Firebase: %s", e)
    return jsonify({"status": "ok", "driver": driver, "rfid": rfid}), 200


@app.route("/video_feed")
def video_feed():
    """Stream live camera feed with real-time multi-factor fatigue HUD."""
    if not monitor.running:
        return Response("Fatigue monitor is currently offline. Start fatigue detection to view stream.", status=503)

    def generate():
        last_id = -1
        while monitor.running:
            frame_bytes, fid = monitor.get_latest_frame_with_id()
            if frame_bytes is not None and fid != last_id:
                last_id = fid
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
                )
            time.sleep(0.01)

    return Response(generate(), mimetype="multipart/x-mixed-replace; boundary=frame")


def to_native(obj):
    if isinstance(obj, dict):
        return {k: to_native(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [to_native(i) for i in obj]
    elif isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj


@app.route("/monitor/status", methods=["GET"])
def monitor_status():
    """Get comprehensive real-time fatigue telemetry.

    Returns all detection metrics, adaptive thresholds, composite score,
    and reliability information for the dashboard.
    """
    raw_telemetry = monitor.get_telemetry()
    telemetry = to_native(raw_telemetry)
    telemetry["running"] = bool(monitor.running)
    return jsonify(telemetry), 200


@app.route("/pending", methods=["GET"])
def get_pending_rfid():
    """Get pending driver RFID scan from USB Serial."""
    pending = serial_bridge.get_pending()
    if pending:
        return jsonify(pending), 200
    return jsonify({"pending": False}), 200


@app.route("/pending/clear", methods=["POST"])
def clear_pending_rfid():
    """Clear local pending driver RFID scan."""
    serial_bridge.clear_pending()
    return jsonify({"cleared": True}), 200


# ── entry-point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
