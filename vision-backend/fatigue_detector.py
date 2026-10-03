"""
DriverSentinel — fatigue_detector.py
Multi-factor driver fatigue detection using dlib 68-point facial landmarks.

PS-17 Compliance:
  ✓ Prolonged eye closure   — EAR (Eye Aspect Ratio) + PERCLOS sliding window
  ✓ Yawning detection       — MAR (Mouth Aspect Ratio) with duration tracking
  ✓ Head nodding detection  — 3D head pose estimation via cv2.solvePnP
  ✓ Adaptive thresholds     — Per-driver baseline calibration (no fixed cutoffs)
  ✓ Blink vs. micro-sleep   — Temporal blink filter (100–350ms normal blinks ignored)
  ✓ Imperfect lighting      — CLAHE preprocessing on luminance channel
  ✓ Reliability metric      — Real-time confidence score (0–100%)
  ✓ Composite fatigue index — Weighted multi-factor score (0–100)

Landmark index map (dlib 68-point, 0-based):
  Left eye   : 36–41
  Right eye  : 42–47
  Outer lips : 48–59
  Inner lips : 60–67
  Nose tip   : 30
  Chin       : 8
  Left eye corner  : 36
  Right eye corner : 45
  Left mouth corner  : 48
  Right mouth corner : 54
"""

import os
import threading
import time
import logging
import collections

import cv2
import dlib
import numpy as np
import requests
from scipy.spatial import distance as dist

logger = logging.getLogger(__name__)

# ── model path ───────────────────────────────────────────────────────────────
MODEL_PATH = os.path.join(
    os.path.dirname(__file__), "shape_predictor_68_face_landmarks.dat"
)

# ── landmark indices ─────────────────────────────────────────────────────────
LEFT_EYE_IDX  = list(range(36, 42))
RIGHT_EYE_IDX = list(range(42, 48))
MOUTH_OUTER_IDX = list(range(48, 60))
MOUTH_INNER_IDX = list(range(60, 68))

# 3D model points for head-pose estimation (generic face proportions)
# Corresponds to: nose tip, chin, left eye corner, right eye corner,
#                 left mouth corner, right mouth corner
MODEL_3D_POINTS = np.array([
    (0.0, 0.0, 0.0),             # Nose tip  (landmark 30)
    (0.0, -330.0, -65.0),        # Chin       (landmark 8)
    (-225.0, 170.0, -135.0),     # Left eye left corner  (landmark 36)
    (225.0, 170.0, -135.0),      # Right eye right corner (landmark 45)
    (-150.0, -150.0, -125.0),    # Left mouth corner  (landmark 48)
    (150.0, -150.0, -125.0),     # Right mouth corner (landmark 54)
], dtype=np.float64)

# ── default thresholds (used before calibration completes) ───────────────────
DEFAULT_EAR_THRESHOLD = 0.25
DEFAULT_MAR_THRESHOLD = 0.65
CALIBRATION_DURATION_SEC = 5.0

# Blink classification
NORMAL_BLINK_MAX_SEC = 0.35     # blinks under 350ms are normal
MICROSLEEP_MIN_SEC = 1.0        # closures > 1.0s trigger micro-sleep alert

# PERCLOS window
PERCLOS_WINDOW_SEC = 60.0       # sliding 60-second window
PERCLOS_ALERT_THRESHOLD = 0.15  # 15% eye-closure triggers pre-alert

# Head pose nodding
PITCH_NOD_THRESHOLD_DEG = 15.0   # head drop > 15° from baseline
PITCH_NOD_DURATION_SEC = 1.0     # sustained for > 1s

# Yawn detection
YAWN_DURATION_SEC = 2.0          # mouth open > 2s counts as yawn
YAWN_ALERT_COUNT = 3             # 3 yawns in 5 minutes triggers alert
YAWN_WINDOW_SEC = 300.0

# Composite fatigue weights
WEIGHT_EYE = 0.40
WEIGHT_YAWN = 0.25
WEIGHT_NOD = 0.20
WEIGHT_PERCLOS = 0.15

# Alert cooldown
ALERT_COOLDOWN_SEC = 4.0


# ── helpers ──────────────────────────────────────────────────────────────────
def eye_aspect_ratio(eye: np.ndarray) -> float:
    """Compute the Eye Aspect Ratio (EAR) for a single eye.
    eye: ndarray of shape (6, 2) — the six (x, y) landmark coordinates.
    """
    A = dist.euclidean(eye[1], eye[5])
    B = dist.euclidean(eye[2], eye[4])
    C = dist.euclidean(eye[0], eye[3])
    if C == 0:
        return 0.0
    return (A + B) / (2.0 * C)


def mouth_aspect_ratio(mouth_inner: np.ndarray) -> float:
    """Compute the Mouth Aspect Ratio (MAR) for yawn detection.
    mouth_inner: ndarray of shape (8, 2) — inner lip landmarks 60–67.
    """
    # Vertical distances (3 pairs)
    A = dist.euclidean(mouth_inner[1], mouth_inner[7])  # 61–67
    B = dist.euclidean(mouth_inner[2], mouth_inner[6])  # 62–66
    C = dist.euclidean(mouth_inner[3], mouth_inner[5])  # 63–65
    # Horizontal distance
    D = dist.euclidean(mouth_inner[0], mouth_inner[4])  # 60–64
    if D == 0:
        return 0.0
    return (A + B + C) / (3.0 * D)


def apply_clahe(gray: np.ndarray) -> np.ndarray:
    """Apply CLAHE (Contrast Limited Adaptive Histogram Equalization)
    to normalize lighting for robust face detection in dim/bright conditions.
    """
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return clahe.apply(gray)


def compute_lighting_score(gray: np.ndarray) -> float:
    """Compute a lighting quality score (0–100) based on histogram spread."""
    mean_val = np.mean(gray)
    std_val = np.std(gray)
    # Ideal: mean ~128, std ~50+
    mean_score = max(0, 100 - abs(mean_val - 128) * 1.2)
    std_score = min(100, std_val * 2.0)
    return float(np.clip((mean_score * 0.5 + std_score * 0.5), 0, 100))


def compute_landmark_jitter(current: np.ndarray, previous: np.ndarray | None) -> float:
    """Compute landmark tracking stability (lower jitter = more stable).
    Returns a stability score 0–100 (100 = perfectly stable).
    """
    if previous is None:
        return 100.0
    diffs = np.linalg.norm(current - previous, axis=1)
    avg_jitter = float(np.mean(diffs))
    # Jitter < 2px = excellent; > 10px = poor
    score = max(0, 100 - avg_jitter * 10)
    return float(np.clip(score, 0, 100))


def get_head_pose(landmarks: np.ndarray, frame_shape: tuple) -> tuple[float, float, float]:
    """Estimate head pose (pitch, yaw, roll) in degrees using solvePnP.
    Returns (pitch, yaw, roll) — pitch > 0 means head tilted down.
    """
    h, w = frame_shape[:2]

    # 2D image points corresponding to the 3D model
    image_points = np.array([
        landmarks[30],  # Nose tip
        landmarks[8],   # Chin
        landmarks[36],  # Left eye left corner
        landmarks[45],  # Right eye right corner
        landmarks[48],  # Left mouth corner
        landmarks[54],  # Right mouth corner
    ], dtype=np.float64)

    # Camera internals (approximate using image dimensions)
    focal_length = w
    center = (w / 2, h / 2)
    camera_matrix = np.array([
        [focal_length, 0, center[0]],
        [0, focal_length, center[1]],
        [0, 0, 1],
    ], dtype=np.float64)
    dist_coeffs = np.zeros((4, 1), dtype=np.float64)

    try:
        success, rotation_vector, translation_vector = cv2.solvePnP(
            MODEL_3D_POINTS, image_points, camera_matrix, dist_coeffs,
            flags=cv2.SOLVEPNP_ITERATIVE,
        )

        if not success:
            return (0.0, 0.0, 0.0)

        # Convert rotation vector to rotation matrix, then directly extract Euler angles
        rotation_matrix, _ = cv2.Rodrigues(rotation_vector)
        sy = np.sqrt(rotation_matrix[0, 0] ** 2 + rotation_matrix[1, 0] ** 2)
        singular = sy < 1e-6

        if not singular:
            pitch = np.degrees(np.arctan2(rotation_matrix[2, 1], rotation_matrix[2, 2]))
            yaw   = np.degrees(np.arctan2(-rotation_matrix[2, 0], sy))
            roll  = np.degrees(np.arctan2(rotation_matrix[1, 0], rotation_matrix[0, 0]))
        else:
            pitch = np.degrees(np.arctan2(-rotation_matrix[1, 2], rotation_matrix[1, 1]))
            yaw   = np.degrees(np.arctan2(-rotation_matrix[2, 0], sy))
            roll  = 0.0

        return (float(pitch), float(yaw), float(roll))
    except Exception as exc:
        logger.debug("Head pose estimation failed: %s", exc)
        return (0.0, 0.0, 0.0)


def _notify_esp32(esp32_ip: str, event_type: str = "Drowsiness", driver_name: str = "Driver") -> None:
    """Send a fatigue alert to the ESP32 via USB Serial AND WiFi/Firebase."""
    # 1. Immediate USB Serial alert to COM port (sub-millisecond latency)
    try:
        from serial_bridge import serial_bridge
        serial_bridge.send_drowsy_alert(event_type)
    except Exception as ser_err:
        logger.debug("Serial alert skipped: %s", ser_err)

    # 2. Network / Firebase logging
    def _run():
        try:
            firebase_url = "https://driver-72b57-default-rtdb.asia-southeast1.firebasedatabase.app"
            event_payload = {
                "driver": driver_name,
                "time": int(time.time() * 1000),
                "type": event_type,
            }
            requests.post(f"{firebase_url}/events.json", json=event_payload, timeout=2)
        except Exception as fb_err:
            logger.debug("Firebase event log skipped: %s", fb_err)

        if esp32_ip:
            url = f"http://{esp32_ip}/drowsy"
            try:
                resp = requests.post(url, timeout=2)
                logger.info("ESP32 WiFi fatigue alert -> %s (HTTP %s)", url, resp.status_code)
            except Exception:
                pass

    threading.Thread(target=_run, daemon=True).start()


# ── calibration state ────────────────────────────────────────────────────────
class DriverCalibration:
    """Collects baseline EAR, MAR, and head pitch during a calibration phase."""

    def __init__(self):
        self.ear_samples: list[float] = []
        self.mar_samples: list[float] = []
        self.pitch_samples: list[float] = []
        self.start_time: float = 0.0
        self.is_complete: bool = False

        # Computed baselines
        self.baseline_ear: float = DEFAULT_EAR_THRESHOLD / 0.70  # ~0.357
        self.baseline_mar: float = DEFAULT_MAR_THRESHOLD / 1.80  # ~0.361
        self.baseline_pitch: float = 0.0

        # Adaptive thresholds
        self.ear_threshold: float = DEFAULT_EAR_THRESHOLD
        self.mar_threshold: float = DEFAULT_MAR_THRESHOLD

    def start(self):
        self.start_time = time.time()
        self.ear_samples.clear()
        self.mar_samples.clear()
        self.pitch_samples.clear()
        self.is_complete = False

    def add_sample(self, ear: float, mar: float, pitch: float):
        if self.is_complete:
            return
        self.ear_samples.append(ear)
        self.mar_samples.append(mar)
        self.pitch_samples.append(pitch)

    def check_complete(self) -> bool:
        if self.is_complete:
            return True
        elapsed = time.time() - self.start_time
        if elapsed >= CALIBRATION_DURATION_SEC and len(self.ear_samples) >= 30:
            self._compute_baselines()
            self.is_complete = True
            return True
        return False

    def _compute_baselines(self):
        if len(self.ear_samples) < 10:
            return

        # Use 75th percentile for EAR to measure genuine open eyes (ignores blinks/squints during calibration)
        raw_baseline_ear = float(np.percentile(self.ear_samples, 75))
        # Clamp baseline to realistic open-eye physiological limits [0.26, 0.40]
        self.baseline_ear = max(0.26, min(0.40, raw_baseline_ear))

        self.baseline_mar = float(np.median(self.mar_samples))
        self.baseline_pitch = float(np.median(self.pitch_samples))

        # Set adaptive thresholds relative to baseline:
        # EAR threshold clamped between 0.22 and 0.28 (ensures closed eyes ~0.15-0.20 ALWAYS trigger!)
        self.ear_threshold = max(0.22, min(0.28, self.baseline_ear * 0.78))
        # MAR: 180% of baseline (wide open mouth relative to resting)
        self.mar_threshold = max(0.45, self.baseline_mar * 1.80)

        logger.info(
            "Calibration complete — baseline EAR=%.3f (threshold=%.3f), "
            "baseline MAR=%.3f (threshold=%.3f), baseline pitch=%.1f°",
            self.baseline_ear, self.ear_threshold,
            self.baseline_mar, self.mar_threshold,
            self.baseline_pitch,
        )

    @property
    def progress_pct(self) -> int:
        if self.is_complete:
            return 100
        elapsed = time.time() - self.start_time
        return int(min(100, (elapsed / CALIBRATION_DURATION_SEC) * 100))


# ── main monitor class ───────────────────────────────────────────────────────
class FatigueMonitor:
    """Multi-factor fatigue detection running in a background thread.

    Detects:
    - Eye closure / micro-sleep (EAR + duration)
    - Yawning (MAR + duration)
    - Head nodding (pitch angle change)
    - PERCLOS (% eye closure over 60s window)

    Produces:
    - Composite fatigue score (0–100)
    - Reliability score (0–100%)
    - Individual metric telemetry for the dashboard
    """

    def __init__(self, esp32_ip: str, camera_index: int = 0):
        self._esp32_ip = esp32_ip
        self._camera_index = camera_index
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._frame_lock = threading.Lock()

        # Latest frame for streaming
        self._latest_frame: bytes | None = None
        self._frame_id: int = 0

        # Telemetry (thread-safe reads via properties)
        self._telemetry_lock = threading.Lock()
        self._telemetry = {
            "ear": 0.0,
            "mar": 0.0,
            "head_pitch": 0.0,
            "head_yaw": 0.0,
            "head_roll": 0.0,
            "is_calibrated": False,
            "calibration_progress": 0,
            "fatigue_score": 0,
            "reliability_score": 100,
            "reliability_status": "Initializing",
            "is_yawning": False,
            "is_nodding": False,
            "is_eye_closed": False,
            "is_drowsy": False,
            "alert_state": "Initializing",
            "perclos": 0.0,
            "blink_rate": 0.0,
            "yawn_count": 0,
            "ear_threshold": DEFAULT_EAR_THRESHOLD,
            "mar_threshold": DEFAULT_MAR_THRESHOLD,
            "baseline_ear": 0.0,
            "baseline_mar": 0.0,
        }

    # ── properties ────────────────────────────────────────────────────────
    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    @property
    def latest_ear(self) -> float:
        with self._telemetry_lock:
            return self._telemetry["ear"]

    @property
    def is_drowsy(self) -> bool:
        with self._telemetry_lock:
            return self._telemetry["is_drowsy"]

    def get_latest_frame(self) -> bytes | None:
        with self._frame_lock:
            return self._latest_frame

    def get_latest_frame_with_id(self) -> tuple[bytes | None, int]:
        with self._frame_lock:
            return self._latest_frame, self._frame_id

    def get_telemetry(self) -> dict:
        with self._telemetry_lock:
            return dict(self._telemetry)

    def _update_telemetry(self, **kwargs):
        with self._telemetry_lock:
            self._telemetry.update(kwargs)

    # ── lifecycle ─────────────────────────────────────────────────────────
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
        logger.info("Fatigue monitor started (camera %s)", self._camera_index)
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
        self._update_telemetry(
            is_drowsy=False, is_yawning=False, is_nodding=False,
            is_eye_closed=False, alert_state="Stopped",
            fatigue_score=0, reliability_score=0,
        )
        logger.info("Fatigue monitor stopped")
        return True

    def recalibrate(self) -> bool:
        """Request re-calibration (only if monitor is running)."""
        if not self.running:
            return False
        self._recalibrate_requested = True
        return True

    # ── internal detection loop ───────────────────────────────────────────
    def _run(self) -> None:
        detector = dlib.get_frontal_face_detector()
        predictor = dlib.shape_predictor(MODEL_PATH)

        # Try DirectShow on Windows for instant camera initialization (<100ms vs ~3000ms MSMF)
        cap = cv2.VideoCapture(self._camera_index, cv2.CAP_DSHOW)
        if not cap.isOpened():
            cap = cv2.VideoCapture(self._camera_index)

        if not cap.isOpened():
            logger.error("Cannot open camera %s", self._camera_index)
            return

        cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
        cap.set(cv2.CAP_PROP_FPS, 30)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        # Calibration
        calibration = DriverCalibration()
        calibration.start()
        self._recalibrate_requested = False

        # Eye closure tracking
        eye_closed_start: float | None = None
        last_alert_time: float = 0.0

        # Blink tracking
        blink_start: float | None = None
        blink_count_window: collections.deque = collections.deque()  # timestamps of blinks

        # PERCLOS tracking — deque of (timestamp, is_closed) tuples
        perclos_history: collections.deque = collections.deque()

        # Yawn tracking
        yawn_start: float | None = None
        yawn_timestamps: collections.deque = collections.deque()  # timestamps of completed yawns

        # Head nodding tracking
        nod_start: float | None = None

        # Landmark jitter tracking
        prev_landmarks: np.ndarray | None = None

        # Frame timing and tracking optimization
        frame_count = 0
        detect_scale = 0.5   # Downscale for 4x faster HOG face detection
        detect_interval = 2  # Detect face every 2 frames, predict landmarks every frame
        last_face_rect = None

        try:
            while not self._stop_event.is_set():
                ret, frame = cap.read()
                if not ret:
                    time.sleep(0.05)
                    continue

                frame_count += 1
                now = time.time()

                # Flip for selfie view
                frame = cv2.flip(frame, 1)
                h, w = frame.shape[:2]

                # ── CLAHE preprocessing for imperfect lighting ────────
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                gray_enhanced = apply_clahe(gray)
                lighting_score = compute_lighting_score(gray)

                # Downscale for ultra-fast face detection
                small_gray = cv2.resize(gray_enhanced, (0, 0), fx=detect_scale, fy=detect_scale)

                # Detect or reuse tracked bounding box
                face_to_predict = None
                if frame_count % detect_interval == 0 or last_face_rect is None:
                    faces = detector(small_gray, 0)
                    if len(faces) > 0:
                        face = max(faces, key=lambda f: (f.right() - f.left()) * (f.bottom() - f.top()))
                        last_face_rect = dlib.rectangle(
                            int(face.left() / detect_scale),
                            int(face.top() / detect_scale),
                            int(face.right() / detect_scale),
                            int(face.bottom() / detect_scale),
                        )
                        face_to_predict = last_face_rect
                    else:
                        last_face_rect = None
                else:
                    face_to_predict = last_face_rect

                if face_to_predict is None:
                    # No face detected
                    self._update_telemetry(
                        reliability_status="No Face Detected",
                        reliability_score=0,
                        alert_state="Searching",
                    )
                    cv2.putText(
                        frame, "Searching for Driver Face...",
                        (30, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        (0, 180, 255), 2,
                    )
                    prev_landmarks = None
                else:
                    shape = predictor(gray_enhanced, face_to_predict)
                    landmarks = np.array(
                        [(shape.part(i).x, shape.part(i).y) for i in range(68)]
                    )

                    # Update face bounding box from landmarks with safety margin for next frame
                    min_x = max(0, int(np.min(landmarks[:, 0])) - 15)
                    max_x = min(w, int(np.max(landmarks[:, 0])) + 15)
                    min_y = max(0, int(np.min(landmarks[:, 1])) - 15)
                    max_y = min(h, int(np.max(landmarks[:, 1])) + 15)
                    last_face_rect = dlib.rectangle(min_x, min_y, max_x, max_y)

                    # ── Extract features ──────────────────────────────
                    left_eye = landmarks[LEFT_EYE_IDX]
                    right_eye = landmarks[RIGHT_EYE_IDX]
                    mouth_inner = landmarks[MOUTH_INNER_IDX]
                    mouth_outer = landmarks[MOUTH_OUTER_IDX]

                    left_ear = eye_aspect_ratio(left_eye)
                    right_ear = eye_aspect_ratio(right_eye)
                    avg_ear = float((left_ear + right_ear) / 2.0)

                    mar = mouth_aspect_ratio(mouth_inner)
                    pitch, yaw, roll = get_head_pose(landmarks, frame.shape)

                    # ── Calibration phase ─────────────────────────────
                    if self._recalibrate_requested:
                        calibration = DriverCalibration()
                        calibration.start()
                        self._recalibrate_requested = False
                        eye_closed_start = None
                        yawn_start = None
                        nod_start = None
                        logger.info("Re-calibration started")

                    if not calibration.is_complete:
                        calibration.add_sample(avg_ear, mar, pitch)
                        calibration.check_complete()
                        self._update_telemetry(
                            ear=round(avg_ear, 3),
                            mar=round(mar, 3),
                            head_pitch=round(pitch, 1),
                            is_calibrated=calibration.is_complete,
                            calibration_progress=calibration.progress_pct,
                            alert_state="Calibrating",
                            ear_threshold=round(calibration.ear_threshold, 3),
                            mar_threshold=round(calibration.mar_threshold, 3),
                        )

                        # Draw calibration UI
                        progress = calibration.progress_pct
                        bar_w = int(w * 0.6)
                        bar_x = int((w - bar_w) / 2)
                        bar_y = h - 60
                        cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + 25), (40, 40, 40), -1)
                        fill_w = int(bar_w * progress / 100)
                        cv2.rectangle(frame, (bar_x, bar_y), (bar_x + fill_w, bar_y + 25), (0, 200, 100), -1)
                        cv2.putText(
                            frame, f"Calibrating... {progress}% — Look straight at camera",
                            (bar_x, bar_y - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                            (0, 255, 200), 2,
                        )
                        # Still draw landmarks during calibration
                        self._draw_landmarks(frame, left_eye, right_eye, mouth_outer, (0, 255, 200))

                    else:
                        # ── Active detection phase ────────────────────

                        ear_threshold = calibration.ear_threshold
                        mar_threshold = calibration.mar_threshold
                        baseline_pitch = calibration.baseline_pitch

                        is_eye_closed = avg_ear < ear_threshold
                        is_yawning = mar > mar_threshold
                        pitch_delta = abs(pitch - baseline_pitch)
                        is_nodding = pitch_delta > PITCH_NOD_THRESHOLD_DEG

                        # ── PERCLOS tracking ──────────────────────────
                        perclos_history.append((now, is_eye_closed))
                        # Evict old entries
                        while perclos_history and (now - perclos_history[0][0]) > PERCLOS_WINDOW_SEC:
                            perclos_history.popleft()
                        if len(perclos_history) > 0:
                            closed_count = sum(1 for _, closed in perclos_history if closed)
                            perclos = closed_count / len(perclos_history)
                        else:
                            perclos = 0.0

                        # ── Blink vs. micro-sleep classification ──────
                        drowsy_now = False
                        microsleep_detected = False

                        if is_eye_closed:
                            if eye_closed_start is None:
                                eye_closed_start = now
                            closed_duration = now - eye_closed_start

                            if closed_duration > MICROSLEEP_MIN_SEC:
                                microsleep_detected = True
                                if (now - last_alert_time) >= ALERT_COOLDOWN_SEC:
                                    drowsy_now = True
                                    last_alert_time = now
                                    logger.warning(
                                        "MICRO-SLEEP! Eyes closed %.2fs (EAR=%.3f, threshold=%.3f)",
                                        closed_duration, avg_ear, ear_threshold,
                                    )
                                    _notify_esp32(self._esp32_ip, "Micro-Sleep", "Driver")
                        else:
                            if eye_closed_start is not None:
                                blink_duration = now - eye_closed_start
                                if blink_duration <= NORMAL_BLINK_MAX_SEC:
                                    # Normal blink — record for blink rate
                                    blink_count_window.append(now)
                                # Reset
                                eye_closed_start = None

                        # Clean old blinks from rate window (last 60s)
                        while blink_count_window and (now - blink_count_window[0]) > 60.0:
                            blink_count_window.popleft()
                        blink_rate = len(blink_count_window)  # blinks per minute

                        # ── Yawn tracking ─────────────────────────────
                        yawn_alert = False
                        if is_yawning:
                            if yawn_start is None:
                                yawn_start = now
                            elif (now - yawn_start) >= YAWN_DURATION_SEC:
                                # Confirmed yawn — only count once per yawn event
                                if not yawn_timestamps or (now - yawn_timestamps[-1]) > YAWN_DURATION_SEC:
                                    yawn_timestamps.append(now)
                                    logger.info("Yawn detected (MAR=%.3f, threshold=%.3f)", mar, mar_threshold)
                        else:
                            yawn_start = None

                        # Evict old yawns
                        while yawn_timestamps and (now - yawn_timestamps[0]) > YAWN_WINDOW_SEC:
                            yawn_timestamps.popleft()
                        yawn_count = len(yawn_timestamps)

                        if yawn_count >= YAWN_ALERT_COUNT:
                            yawn_alert = True
                            if (now - last_alert_time) >= ALERT_COOLDOWN_SEC:
                                last_alert_time = now
                                logger.warning("Excessive yawning (%d in 5min)", yawn_count)
                                _notify_esp32(self._esp32_ip, "Excessive Yawning", "Driver")

                        # ── Head nodding tracking ─────────────────────
                        nod_alert = False
                        if is_nodding:
                            if nod_start is None:
                                nod_start = now
                            elif (now - nod_start) >= PITCH_NOD_DURATION_SEC:
                                nod_alert = True
                                if (now - last_alert_time) >= ALERT_COOLDOWN_SEC:
                                    last_alert_time = now
                                    logger.warning(
                                        "Head nodding! pitch=%.1f° (baseline=%.1f°, delta=%.1f°)",
                                        pitch, baseline_pitch, pitch_delta,
                                    )
                                    _notify_esp32(self._esp32_ip, "Head Nodding", "Driver")
                        else:
                            nod_start = None

                        # ── Composite fatigue score (0–100) ───────────
                        # Eye component: based on closure duration
                        if eye_closed_start is not None:
                            closed_dur = now - eye_closed_start
                            eye_score = min(100, (closed_dur / 3.0) * 100)
                        else:
                            eye_score = 0.0

                        # Yawn component: based on count in window
                        yawn_score = min(100, (yawn_count / YAWN_ALERT_COUNT) * 100)

                        # Nod component: based on pitch deviation
                        nod_score = min(100, (pitch_delta / (PITCH_NOD_THRESHOLD_DEG * 2)) * 100)

                        # PERCLOS component
                        perclos_score = min(100, (perclos / PERCLOS_ALERT_THRESHOLD) * 100)

                        fatigue_score = int(np.clip(
                            WEIGHT_EYE * eye_score +
                            WEIGHT_YAWN * yawn_score +
                            WEIGHT_NOD * nod_score +
                            WEIGHT_PERCLOS * perclos_score,
                            0, 100,
                        ))

                        # ── Alert state classification ────────────────
                        if fatigue_score >= 70 or microsleep_detected:
                            alert_state = "CRITICAL"
                        elif fatigue_score >= 40 or perclos > PERCLOS_ALERT_THRESHOLD or yawn_alert:
                            alert_state = "Pre-Alert"
                        elif drowsy_now or nod_alert:
                            alert_state = "Warning"
                        else:
                            alert_state = "Normal"

                        # ── Reliability score ─────────────────────────
                        jitter_score = compute_landmark_jitter(landmarks, prev_landmarks)
                        # Head pose extent penalty (extreme angles reduce reliability)
                        pose_penalty = min(40, (abs(yaw) + abs(roll)) * 0.8)
                        reliability = np.clip(
                            lighting_score * 0.35 +
                            jitter_score * 0.35 +
                            (100 - pose_penalty) * 0.30,
                            0, 100,
                        )
                        reliability = float(reliability)

                        if reliability >= 80:
                            reliability_status = "Optimal"
                        elif reliability >= 60:
                            reliability_status = "Good"
                        elif reliability >= 40:
                            reliability_status = "Fair — Check Lighting"
                        else:
                            reliability_status = "Poor — Adjust Position"

                        prev_landmarks = landmarks.copy()

                        # ── Update telemetry ──────────────────────────
                        self._update_telemetry(
                            ear=round(avg_ear, 3),
                            mar=round(mar, 3),
                            head_pitch=round(pitch, 1),
                            head_yaw=round(yaw, 1),
                            head_roll=round(roll, 1),
                            is_calibrated=True,
                            calibration_progress=100,
                            fatigue_score=fatigue_score,
                            reliability_score=int(reliability),
                            reliability_status=reliability_status,
                            is_yawning=is_yawning and yawn_start is not None and (now - yawn_start) > 0.5,
                            is_nodding=is_nodding,
                            is_eye_closed=is_eye_closed,
                            is_drowsy=microsleep_detected or fatigue_score >= 70,
                            alert_state=alert_state,
                            perclos=round(perclos * 100, 1),
                            blink_rate=blink_rate,
                            yawn_count=yawn_count,
                            ear_threshold=round(ear_threshold, 3),
                            mar_threshold=round(mar_threshold, 3),
                            baseline_ear=round(calibration.baseline_ear, 3),
                            baseline_mar=round(calibration.baseline_mar, 3),
                        )

                        # ── Draw HUD on frame ─────────────────────────
                        self._draw_detection_hud(
                            frame, w, h, avg_ear, ear_threshold, mar, mar_threshold,
                            pitch, baseline_pitch, fatigue_score, alert_state,
                            is_eye_closed, is_yawning, is_nodding,
                            reliability, perclos, blink_rate, yawn_count,
                        )

                        # Draw landmarks
                        eye_color = (0, 0, 255) if is_eye_closed else (0, 255, 0)
                        mouth_color = (0, 0, 255) if (is_yawning and yawn_start and (now - yawn_start) > 0.5) else (0, 255, 0)
                        self._draw_landmarks(frame, left_eye, right_eye, mouth_outer, eye_color, mouth_color)

                        # Draw alert banner
                        if alert_state == "CRITICAL":
                            cv2.rectangle(frame, (20, 70), (w - 20, 130), (0, 0, 200), -1)
                            cv2.putText(
                                frame, "FATIGUE CRITICAL — ALERTING CAB",
                                (35, 110), cv2.FONT_HERSHEY_SIMPLEX, 0.8,
                                (255, 255, 255), 2,
                            )
                        elif alert_state == "Pre-Alert":
                            cv2.rectangle(frame, (20, 70), (w - 20, 120), (0, 140, 255), -1)
                            cv2.putText(
                                frame, "PRE-ALERT: Rising Fatigue Detected",
                                (35, 105), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                                (255, 255, 255), 2,
                            )

                # ── Encode frame to JPEG ──────────────────────────────
                success, buffer = cv2.imencode(
                    ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70]
                )
                if success:
                    with self._frame_lock:
                        self._latest_frame = buffer.tobytes()
                        self._frame_id += 1

                # Brief yield so other threads (telemetry, stream) get CPU time
                time.sleep(0.002)

        finally:
            cap.release()
            logger.info("Camera released")

    # ── drawing helpers ───────────────────────────────────────────────────
    def _draw_landmarks(
        self, frame, left_eye, right_eye, mouth_outer,
        eye_color, mouth_color=None,
    ):
        """Draw eye contours, eye dots, and mouth contour."""
        if mouth_color is None:
            mouth_color = eye_color

        # Eyes
        left_hull = cv2.convexHull(left_eye)
        right_hull = cv2.convexHull(right_eye)
        cv2.drawContours(frame, [left_hull], -1, eye_color, 2)
        cv2.drawContours(frame, [right_hull], -1, eye_color, 2)
        for x, y in left_eye:
            cv2.circle(frame, (int(x), int(y)), 2, (255, 255, 255), -1)
        for x, y in right_eye:
            cv2.circle(frame, (int(x), int(y)), 2, (255, 255, 255), -1)

        # Mouth
        mouth_hull = cv2.convexHull(mouth_outer)
        cv2.drawContours(frame, [mouth_hull], -1, mouth_color, 2)

    def _draw_detection_hud(
        self, frame, w, h,
        ear, ear_thresh, mar, mar_thresh,
        pitch, baseline_pitch, fatigue_score, alert_state,
        is_eye_closed, is_yawning, is_nodding,
        reliability, perclos, blink_rate, yawn_count,
    ):
        """Draw the real-time HUD overlay on the video frame."""
        eye_color = (0, 0, 255) if is_eye_closed else (0, 255, 0)

        # Top-left: EAR + MAR
        cv2.putText(
            frame, f"EAR: {ear:.2f} / {ear_thresh:.2f}",
            (15, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.55, eye_color, 2,
        )
        mar_color = (0, 0, 255) if is_yawning else (200, 200, 200)
        cv2.putText(
            frame, f"MAR: {mar:.2f} / {mar_thresh:.2f}",
            (15, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.55, mar_color, 2,
        )

        # Top-right: Fatigue score gauge
        score_color = (0, 255, 0) if fatigue_score < 40 else (0, 180, 255) if fatigue_score < 70 else (0, 0, 255)
        cv2.putText(
            frame, f"Fatigue: {fatigue_score}%",
            (w - 200, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, score_color, 2,
        )
        cv2.putText(
            frame, f"Reliability: {reliability:.0f}%",
            (w - 200, 55), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (180, 180, 180), 1,
        )

        # Bottom-left: Head pose + PERCLOS
        pitch_color = (0, 0, 255) if is_nodding else (200, 200, 200)
        cv2.putText(
            frame, f"Pitch: {pitch:.1f} (base: {baseline_pitch:.1f})",
            (15, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.45, pitch_color, 1,
        )
        cv2.putText(
            frame, f"PERCLOS: {perclos * 100:.1f}% | Blinks/min: {blink_rate:.0f} | Yawns: {yawn_count}",
            (15, h - 18), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (180, 180, 180), 1,
        )

        # Bottom-right: Alert state
        state_colors = {
            "Normal": (0, 200, 0),
            "Pre-Alert": (0, 180, 255),
            "Warning": (0, 140, 255),
            "CRITICAL": (0, 0, 255),
        }
        state_col = state_colors.get(alert_state, (200, 200, 200))
        cv2.putText(
            frame, alert_state,
            (w - 160, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.7, state_col, 2,
        )
