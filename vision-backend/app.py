"""
DriveSafe Vision Backend — app.py

Flask application providing face-verification, driver-enrollment, and
drowsiness-monitoring endpoints for the DriveSafe IoT system.

Routes
------
GET  /health          → { "status": "ok" }
POST /verify          → multipart image → { "verified": bool, "name": str }
POST /enroll          → multipart image+name+rfid → { "enrolled": bool, ... }
POST /monitor/start   → start drowsiness-detection thread
POST /monitor/stop    → stop drowsiness-detection thread
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

from drowsiness import DrowsinessMonitor

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


# ── drowsiness monitor singleton ─────────────────────────────────────────────
monitor = DrowsinessMonitor(esp32_ip=ESP32_IP)


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

    # face_recognition default tolerance is 0.6
    if best_distance <= 0.6:
        matched_face = faces[best_idx]
        matched_name = matched_face["name"]
        matched_rfid = matched_face.get("rfid", "")
        logger.info("Verified: %s (distance %.3f, RFID %s)", matched_name, best_distance, matched_rfid)

        # ── Auto-POST to ESP32 to unlock the pending RFID ────────────
        esp32_unlocked = False
        esp32_error = ""
        try:
            import requests as http_requests
            esp32_url = f"http://{ESP32_IP}/verify"
            payload = {"name": matched_name, "rfid": matched_rfid}
            logger.info("Sending unlock to ESP32: %s → %s", esp32_url, payload)
            resp = http_requests.post(
                esp32_url,
                json=payload,
                timeout=5,
            )
            esp32_data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            esp32_unlocked = esp32_data.get("ok", False)
            esp32_error = esp32_data.get("error", "")
            logger.info("ESP32 response: %d → %s", resp.status_code, esp32_data)
        except Exception as exc:
            logger.warning("Could not reach ESP32 at %s: %s", ESP32_IP, exc)
            esp32_error = str(exc)

        result = {
            "verified": True,
            "name": matched_name,
            "rfid": matched_rfid,
            "esp32_unlocked": esp32_unlocked,
        }
        if esp32_error:
            result["esp32_error"] = esp32_error

        return jsonify(result), 200
    else:
        logger.info("Verification failed (best distance %.3f)", best_distance)
        return jsonify({"verified": False, "error": "No matching face found"}), 404


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


@app.route("/monitor/start", methods=["POST"])
def monitor_start():
    """Start the drowsiness-detection background thread."""
    try:
        started = monitor.start()
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 500

    if started:
        logger.info("Monitor started via /monitor/start")
        return jsonify({"monitoring": True, "message": "Drowsiness monitor started"}), 200
    else:
        return jsonify({"monitoring": True, "message": "Monitor already running"}), 200


@app.route("/monitor/stop", methods=["POST"])
def monitor_stop():
    """Stop the drowsiness-detection background thread."""
    stopped = monitor.stop()
    if stopped:
        logger.info("Monitor stopped via /monitor/stop")
        return jsonify({"monitoring": False, "message": "Drowsiness monitor stopped"}), 200
    else:
        return jsonify({"monitoring": False, "message": "Monitor was not running"}), 200


@app.route("/video_feed")
def video_feed():
    """Stream live camera feed with real-time 68-point facial landmarks and EAR."""
    if not monitor.running:
        monitor.start()

    def generate():
        while True:
            frame_bytes = monitor.get_latest_frame()
            if frame_bytes is not None:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame_bytes + b"\r\n"
                )
            time.sleep(0.033)

    return Response(generate(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.route("/monitor/status", methods=["GET"])
def monitor_status():
    """Get real-time monitoring status, current EAR value, and drowsiness alert flag."""
    return jsonify({
        "running": monitor.running,
        "ear": monitor.latest_ear,
        "is_drowsy": monitor.is_drowsy,
    }), 200


# ── entry-point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)

