"""
DriveSafe Vision Backend — drowsiness.py
EAR-based drowsiness detection using dlib 68-point facial landmarks.

Eye indices (0-indexed within the 68-point model):
  Left eye  : landmarks 36–41
  Right eye : landmarks 42–47

Algorithm:
  1. Compute the Eye Aspect Ratio (EAR) for each eye every frame.
  2. Average the two EARs.
  3. If the average EAR falls below EAR_THRESHOLD for EAR_CONSEC_FRAMES
     consecutive frames, the driver is classified as drowsy.
  4. On drowsiness detection, POST to the ESP32 /drowsy endpoint.
  5. Provide encoded annotated frames for real-time streaming in the web UI.
"""

import os
import threading
import time
import logging

import cv2
import dlib
import numpy as np
import requests
from scipy.spatial import distance as dist

logger = logging.getLogger(__name__)

# ── constants ────────────────────────────────────────────────────────────────
EAR_THRESHOLD = 0.25
EAR_CONSEC_FRAMES = 20

# dlib 68-point landmark indices (0-based)
LEFT_EYE_IDX = list(range(36, 42))
RIGHT_EYE_IDX = list(range(42, 48))

MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat"
)


# ── helpers ──────────────────────────────────────────────────────────────────
def eye_aspect_ratio(eye: np.ndarray) -> float:
    """Compute the Eye Aspect Ratio (EAR) for a single eye.

    eye: ndarray of shape (6, 2) — the six (x, y) landmark coordinates.
    """
    # vertical distances
    A = dist.euclidean(eye[1], eye[5])
    B = dist.euclidean(eye[2], eye[4])
    # horizontal distance
    C = dist.euclidean(eye[0], eye[3])
    return (A + B) / (2.0 * C)


def _notify_esp32(esp32_ip: str) -> None:
    """Send a drowsiness alert to the ESP32."""
    url = f"http://{esp32_ip}/drowsy"
    try:
        resp = requests.post(url, timeout=3)
        logger.info("ESP32 drowsy alert -> %s  (HTTP %s)", url, resp.status_code)
    except requests.RequestException as exc:
        logger.warning("ESP32 drowsy alert failed: %s", exc)


# ── background monitor ───────────────────────────────────────────────────────
class DrowsinessMonitor:
    """Runs EAR-based drowsiness detection in a background thread."""

    def __init__(self, esp32_ip: str, camera_index: int = 0):
        self._esp32_ip = esp32_ip
        self._camera_index = camera_index
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._latest_frame: bytes | None = None
        self._latest_ear: float = 0.0
        self._is_drowsy: bool = False
        self._frame_lock = threading.Lock()

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def latest_ear(self) -> float:
        return self._latest_ear

    @property
    def is_drowsy(self) -> bool:
        return self._is_drowsy

    def get_latest_frame(self) -> bytes | None:
        with self._frame_lock:
            return self._latest_frame

    def start(self) -> bool:
        """Start monitoring. Returns False if already running."""
        if self.running:
            return False

        if not os.path.isfile(MODEL_PATH):
            raise FileNotFoundError(
                f"Landmark model not found at {MODEL_PATH}. "
                "Run download_model.py first."
            )

        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        logger.info("Drowsiness monitor started (camera %s)", self._camera_index)
        return True

    def stop(self) -> bool:
        """Stop monitoring. Returns False if not running."""
        if not self.running:
            return False
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._thread = None
        with self._frame_lock:
            self._latest_frame = None
        self._is_drowsy = False
        logger.info("Drowsiness monitor stopped")
        return True

    # ── internal loop ────────────────────────────────────────────────────
    def _run(self) -> None:
        detector = dlib.get_frontal_face_detector()
        predictor = dlib.shape_predictor(MODEL_PATH)

        cap = cv2.VideoCapture(self._camera_index)
        if not cap.isOpened():
            logger.error("Cannot open camera %s", self._camera_index)
            return

        closed_start_time = None
        last_alert_time = 0.0

        try:
            while not self._stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.05)
                    continue

                # Flip for selfie view
                frame = cv2.flip(frame, 1)
                h, w = frame.shape[:2]
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                faces = detector(gray, 0)

                drowsy_now = False

                if len(faces) == 0:
                    cv2.putText(
                        frame,
                        "Searching for Driver Face...",
                        (30, 45),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.75,
                        (0, 180, 255),
                        2,
                    )
                else:
                    for face in faces:
                        shape = predictor(gray, face)
                        landmarks = np.array(
                            [(shape.part(i).x, shape.part(i).y) for i in range(68)]
                        )

                        left_eye = landmarks[LEFT_EYE_IDX]
                        right_eye = landmarks[RIGHT_EYE_IDX]

                        left_ear = eye_aspect_ratio(left_eye)
                        right_ear = eye_aspect_ratio(right_eye)
                        avg_ear = float((left_ear + right_ear) / 2.0)
                        self._latest_ear = round(avg_ear, 3)

                        # Draw eye contours
                        left_hull = cv2.convexHull(left_eye)
                        right_hull = cv2.convexHull(right_eye)

                        is_eye_closed = avg_ear < EAR_THRESHOLD
                        eye_color = (0, 0, 255) if is_eye_closed else (0, 255, 0)

                        cv2.drawContours(frame, [left_hull], -1, eye_color, 2)
                        cv2.drawContours(frame, [right_hull], -1, eye_color, 2)

                        # Draw landmark dots
                        for x, y in left_eye:
                            cv2.circle(frame, (x, y), 2, (255, 255, 255), -1)
                        for x, y in right_eye:
                            cv2.circle(frame, (x, y), 2, (255, 255, 255), -1)

                        if is_eye_closed:
                            if closed_start_time is None:
                                closed_start_time = time.time()
                            closed_duration = time.time() - closed_start_time

                            if closed_duration >= 3.0:
                                # Trigger alert if not alerted yet or if re-alert interval passed
                                if (time.time() - last_alert_time) >= 4.0:
                                    drowsy_now = True
                                    self._is_drowsy = True
                                    last_alert_time = time.time()
                                    logger.warning(
                                        "Drowsiness detected! Eyes closed for %.2fs (EAR=%.3f)",
                                        closed_duration,
                                        avg_ear,
                                    )
                                    _notify_esp32(self._esp32_ip)
                                else:
                                    drowsy_now = True
                                    self._is_drowsy = True
                        else:
                            closed_start_time = None
                            self._is_drowsy = False

                        # Overlay HUD on frame
                        status_text = f"EAR: {avg_ear:.2f} (Threshold: {EAR_THRESHOLD})"
                        cv2.putText(
                            frame,
                            status_text,
                            (30, 45),
                            cv2.FONT_HERSHEY_SIMPLEX,
                            0.75,
                            eye_color,
                            2,
                        )

                        if drowsy_now:
                            # Highlighted alert box
                            cv2.rectangle(frame, (20, 70), (w - 20, 130), (0, 0, 255), -1)
                            cv2.putText(
                                frame,
                                "DROWSINESS DETECTED! ALERTING CAB",
                                (35, 110),
                                cv2.FONT_HERSHEY_SIMPLEX,
                                0.85,
                                (255, 255, 255),
                                2,
                            )

                # Encode frame to JPEG
                success, buffer = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75]
                )
                if success:
                    with self._frame_lock:
                        self._latest_frame = buffer.tobytes()

                # Small sleep to target ~30 fps
                time.sleep(0.033)

        finally:
            cap.release()
            logger.info("Camera released")
