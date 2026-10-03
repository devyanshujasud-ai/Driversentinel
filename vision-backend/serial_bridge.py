"""
DriverSentinel — serial_bridge.py
USB Serial Communication Bridge between Computer (Python/Web) and ESP32 Hardware

Enables 100% offline, zero-latency communication over USB COM port:
- Computer -> ESP32: Sends "DROWSY\n" on fatigue detection (triggers buzzer, LED, OLED).
- Computer -> ESP32: Sends "UNLOCK\n" on successful face verification.
- ESP32 -> Computer: Receives "RFID:<HEX>:<NAME>\n" and forwards to Firebase /pending.
- ESP32 -> Computer: Receives "EVENT:<TYPE>\n" and forwards to Firebase /events.
"""

import logging
import os
import threading
import time
import requests
import serial
import serial.tools.list_ports

logger = logging.getLogger("serial_bridge")

FIREBASE_DB_URL = "https://driver-72b57-default-rtdb.asia-southeast1.firebasedatabase.app"


class SerialBridge:
    def __init__(self, port: str = "COM11", baudrate: int = 115200):
        self.port = port
        self.baudrate = baudrate
        self.ser: serial.Serial | None = None
        self._running = False
        self._thread: threading.Thread | None = None
        self._write_lock = threading.Lock()
        self.latest_pending = None

    def find_esp32_port(self) -> str | None:
        """Scan available COM ports to find an ESP32 or USB-Serial device."""
        ports = list(serial.tools.list_ports.comports())
        if not ports:
            return None

        # Check if requested port exists
        for p in ports:
            if p.device.upper() == self.port.upper():
                return p.device

        # Search for typical ESP32 chips (CH9102, CH340, CP210x, FTDI)
        for p in ports:
            desc = (p.description or "").lower()
            if any(k in desc for k in ["ch9102", "cp210", "ch340", "usb-serial", "uart", "esp32"]):
                return p.device

        # Fallback to first available port
        return ports[0].device

    def start(self):
        """Start the background serial reader thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()

    def stop(self):
        """Stop serial communication."""
        self._running = False
        with self._write_lock:
            if self.ser and self.ser.is_open:
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None

    def _worker(self):
        while self._running:
            # Connect if not connected
            if self.ser is None or not self.ser.is_open:
                target_port = self.find_esp32_port() or self.port
                try:
                    self.ser = serial.Serial(target_port, self.baudrate, timeout=1)
                    logger.info("USB Serial connected to ESP32 on %s @ %d baud", target_port, self.baudrate)
                    print(f"\n[USB SERIAL] Connected to ESP32 on {target_port} (Baud {self.baudrate})\n")
                except Exception as err:
                    logger.debug("Waiting for ESP32 on %s: %s", target_port, err)
                    time.sleep(2)
                    continue

            # Read incoming lines from ESP32
            try:
                line = self.ser.readline().decode("utf-8", errors="replace").strip()
                if line:
                    logger.info("[ESP32 USB] %s", line)
                    self._handle_esp32_message(line)
            except Exception as err:
                logger.warning("USB Serial read error: %s", err)
                with self._write_lock:
                    if self.ser:
                        try:
                            self.ser.close()
                        except Exception:
                            pass
                        self.ser = None
                time.sleep(1)

    def _handle_esp32_message(self, line: str):
        """Process messages received from ESP32 via USB Serial."""
        print(f"[ESP32 -> PC] {line}", flush=True)

        driver_name = None
        rfid_hex = None

        # RFID Scan: RFID:<HEX>:<NAME>
        if line.startswith("RFID:"):
            parts = line.split(":")
            if len(parts) >= 3:
                rfid_hex = parts[1]
                driver_name = parts[2]
        elif "[RFID]" in line and "Driver 1" in line:
            driver_name = "DRIVER 1"
            rfid_hex = "B33D0204"
        elif "[RFID]" in line and "Driver 2" in line:
            driver_name = "DRIVER 2"
            rfid_hex = "CD3EC801"

        if driver_name and rfid_hex:
            print(f"[USB SERIAL] Authorized RFID tapped: {driver_name} ({rfid_hex}) -> Triggering Web Face Verification", flush=True)
            self.latest_pending = {
                "driver": driver_name,
                "rfid": rfid_hex,
                "time": int(time.time() * 1000),
            }
            self._sync_firebase_pending(driver_name, rfid_hex)

        # Hardware Events: EVENT:<TYPE>
        elif line.startswith("EVENT:"):
            event_type = line[6:]
            print(f"[USB SERIAL] Hardware event: {event_type} -> Syncing to Cloud", flush=True)
            self._sync_firebase_event(event_type, "Driver")

        # Driving / Rest status
        elif line.startswith("STATUS:"):
            status_text = line[7:]
            logger.info("ESP32 Status update: %s", status_text)

    def _sync_firebase_pending(self, driver_name: str, rfid_hex: str):
        """Push pending authorization request to Firebase to trigger browser webcam modal."""
        def _post():
            try:
                url = f"{FIREBASE_DB_URL}/pending.json"
                payload = {
                    "driver": driver_name,
                    "rfid": rfid_hex,
                    "time": int(time.time() * 1000),
                }
                requests.put(url, json=payload, timeout=2)
                logger.info("Firebase /pending updated for driver: %s", driver_name)
            except Exception as e:
                logger.debug("Firebase pending sync skipped: %s", e)

        threading.Thread(target=_post, daemon=True).start()

    def _sync_firebase_event(self, event_type: str, driver_name: str):
        def _post():
            try:
                url = f"{FIREBASE_DB_URL}/events.json"
                payload = {
                    "driver": driver_name,
                    "type": event_type,
                    "time": int(time.time() * 1000),
                }
                requests.post(url, json=payload, timeout=2)
            except Exception as e:
                logger.debug("Firebase event sync skipped: %s", e)

        threading.Thread(target=_post, daemon=True).start()

    def get_pending(self):
        """Return the most recent unhandled RFID tap."""
        return self.latest_pending

    def clear_pending(self):
        """Clear local pending RFID tap."""
        self.latest_pending = None

    def send_drowsy_alert(self, reason: str = "DROWSINESS DETECTED") -> bool:
        """Send immediate fatigue alert to ESP32 over USB Serial."""
        return self.send(f"DROWSY:{reason}\n")

    def send_unlock(self) -> bool:
        """Send ignition unlock command to ESP32 over USB Serial."""
        return self.send("UNLOCK\n")

    def send(self, message: str) -> bool:
        """Write raw command to USB Serial."""
        with self._write_lock:
            if self.ser and self.ser.is_open:
                try:
                    self.ser.write(message.encode("utf-8"))
                    self.ser.flush()
                    print(f"[PC -> ESP32 USB] Sent: {message.strip()}", flush=True)
                    return True
                except Exception as err:
                    logger.warning("Failed to write to USB Serial: %s", err)
                    return False
        return False


# Global singleton instance
serial_bridge = SerialBridge(port="COM11", baudrate=115200)
