/*
 * ─────────────────────────────────────────────────────────────────────────────
 * DriveSafe ESP32 Firmware (Integrated)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Original features (PRESERVED):
 *   • MFRC522 RFID driver authentication
 *   • TinyGPSPlus GPS tracking
 *   • SSD1306 OLED display
 *   • Driving-session timer with pre-alert
 *   • Break-bonus logic (long break → bonus time)
 *   • SOS button (hold 3s to activate, press to cancel)
 *   • Buzzer + RED/GREEN LED indicators
 *
 * NEW integrations added:
 *   • WiFi connectivity
 *   • WebServer on port 80: POST /verify, POST /drowsy
 *   • HTTP client calls to Python backend /monitor/start and /monitor/stop
 *   • Firebase RTDB push calls in startDriver(), exitDriver(), startSOS()
 *     updating status, status/location, and events paths
 *
 * Required libraries (install via Arduino Library Manager):
 *   - MFRC522           (by GithubCommunity)
 *   - TinyGPSPlus       (by Mikal Hart)
 *   - Adafruit SSD1306  (by Adafruit)
 *   - Adafruit GFX      (by Adafruit)
 *   - Firebase ESP Client (by mobizt)  ← version 4.x
 *
 * Board: ESP32 Dev Module
 * ─────────────────────────────────────────────────────────────────────────────
 */

#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>

// ── NEW: WiFi, WebServer, HTTP Client, Firebase ─────────────────────────────
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <Firebase_ESP_Client.h>
#include <addons/TokenHelper.h>
#include <addons/RTDBHelper.h>

#include "config.h"


// =====================================================
// PIN DEFINITIONS (unchanged)
// =====================================================

#define OLED_SDA 21
#define OLED_SCL 25

#define RFID_SS   5
#define RFID_RST  22
#define RFID_SCK  18
#define RFID_MOSI 23
#define RFID_MISO 19

#define GPS_RX 32
#define GPS_TX 33

#define BUZZER_PIN 15
#define RED_LED    27
#define GREEN_LED  26

#define SOS_BUTTON 13


// =====================================================
// TIME SETTINGS - TESTING (unchanged)
// =====================================================

const unsigned long BASE_DRIVE_LIMIT = 60000UL;
const unsigned long PRE_ALERT_TIME = 10000UL;
const unsigned long PRE_ALERT_DISPLAY_TIME = 3000UL;
const unsigned long LONG_BREAK_TIME = 20000UL;
const unsigned long BREAK_BONUS = 10000UL;
const unsigned long SOS_HOLD_TIME = 3000UL;
const unsigned long SOS_BEEP_INTERVAL = 2000UL;


// =====================================================
// OBJECTS (unchanged + new)
// =====================================================

Adafruit_SSD1306 display(128, 64, &Wire, -1);
MFRC522 rfid(RFID_SS, RFID_RST);
TinyGPSPlus gps;
HardwareSerial GPSserial(2);

// ── NEW: Web server & Firebase ──────────────────────
WebServer server(80);

FirebaseData   fbdo;
FirebaseAuth   fbAuth;
FirebaseConfig fbConfig;
bool firebaseReady = false;


// =====================================================
// DRIVER DATA (unchanged)
// =====================================================

struct Driver {
  String uid;
  String name;
  unsigned long savedTime;
  unsigned long bonusTime;
  unsigned long lastExitTime;
  bool hasExited;
};


// =====================================================
// DRIVER DATABASE (unchanged)
// =====================================================

Driver drivers[] = {
  { "B3 3D 02 04", "Parth",    0, 0, 0, false },
  { "CD 3E C8 01", "Swanandi", 0, 0, 0, false }
};

const int DRIVER_COUNT = 2;


// =====================================================
// SESSION (unchanged)
// =====================================================

Driver* activeDriver = nullptr;
bool sessionRunning = false;
bool limitReached = false;
bool preAlertActive = false;
bool preAlertShownThisSession = false;
bool emergencyMode = false;
unsigned long sessionStart = 0;
unsigned long preAlertStart = 0;

// ── RFID-to-Face pending verification state ─────────
bool pendingVerification = false;
String pendingRfidUid = "";
Driver* pendingDriver = nullptr;
unsigned long pendingStartTime = 0;
const unsigned long PENDING_TIMEOUT = 60000UL; // 60 seconds


// =====================================================
// SOS (unchanged)
// =====================================================

bool sosButtonPressed = false;
bool sosHoldTriggered = false;
unsigned long sosPressStart = 0;
unsigned long lastSosBeep = 0;


// =====================================================
// NEW: Track real epoch time for Firebase timestamps
// =====================================================
unsigned long epochAtBoot = 0;
unsigned long millisAtEpochSync = 0;

unsigned long currentEpochMs() {
  if (epochAtBoot == 0) return millis();  // fallback if NTP not synced
  return (unsigned long)((epochAtBoot * 1000ULL) + (millis() - millisAtEpochSync));
}


// =====================================================
// FORWARD DECLARATIONS
// =====================================================

// Original
Driver* findDriver(String uid);
String getUID();
void rfidSuccessBeep();
void rfidErrorBeep();
unsigned long getDriverLimit(Driver* driver);
unsigned long getUsedTime();
unsigned long getRemainingTime();
void displayMessage(String line1, String line2, String line3 = "");
void checkBreakBonus(Driver* driver);
void startDriver(Driver* driver);
void exitDriver();
void startPreAlert();
void handlePreAlert();
void triggerLimit();
void updateLimitDisplay();
void updateNormalDisplay();
void startSOS();
void updateSOSDisplay();
void stopSOS();
void checkSOSButton();
void handleSOSBuzzer();
void checkRFID();
void readGPS();
void printGPSData();

// NEW
void handleVerifyRoute();
void handleDrowsyRoute();
void callBackendMonitor(const char* action);
void firebasePushEvent(const char* eventType, const char* driver);
void firebaseSetStatus(const char* state, const char* driver);
void firebaseSetLocation(float lat, float lng);
void cancelPendingVerification(const char* reason);
void updatePendingDisplay();


// =====================================================
// FIND DRIVER (unchanged)
// =====================================================

Driver* findDriver(String uid) {
  for (int i = 0; i < DRIVER_COUNT; i++) {
    if (drivers[i].uid == uid) {
      return &drivers[i];
    }
  }
  return nullptr;
}


// =====================================================
// GET UID (unchanged)
// =====================================================

String getUID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
    if (i < rfid.uid.size - 1) uid += " ";
  }
  uid.toUpperCase();
  return uid;
}


// =====================================================
// BEEPS (unchanged)
// =====================================================

void rfidSuccessBeep() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(200);
  digitalWrite(BUZZER_PIN, LOW);
}

void rfidErrorBeep() {
  for (int i = 0; i < 2; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(150);
    digitalWrite(BUZZER_PIN, LOW);
    delay(150);
  }
}


// =====================================================
// DRIVER LIMIT (unchanged)
// =====================================================

unsigned long getDriverLimit(Driver* driver) {
  return BASE_DRIVE_LIMIT + driver->bonusTime;
}


// =====================================================
// USED TIME (unchanged)
// =====================================================

unsigned long getUsedTime() {
  if (activeDriver == nullptr) return 0;
  if (!sessionRunning) return activeDriver->savedTime;
  return activeDriver->savedTime + (millis() - sessionStart);
}


// =====================================================
// REMAINING TIME (unchanged)
// =====================================================

unsigned long getRemainingTime() {
  if (activeDriver == nullptr) return 0;
  unsigned long limit = getDriverLimit(activeDriver);
  unsigned long used = getUsedTime();
  if (used >= limit) return 0;
  return limit - used;
}


// =====================================================
// OLED MESSAGE (unchanged)
// =====================================================

void displayMessage(String line1, String line2, String line3) {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println(line1);
  display.setCursor(0, 20);
  display.println(line2);
  if (line3 != "") {
    display.setCursor(0, 40);
    display.println(line3);
  }
  display.display();
}


// =====================================================
// CHECK BREAK (unchanged)
// =====================================================

void checkBreakBonus(Driver* driver) {
  if (!driver->hasExited) return;

  unsigned long breakTime = millis() - driver->lastExitTime;

  Serial.print("Break duration: ");
  Serial.print(breakTime / 1000);
  Serial.println(" sec");

  if (breakTime > LONG_BREAK_TIME) {
    driver->bonusTime += BREAK_BONUS;
    Serial.println("LONG BREAK");
    Serial.println("+10 SEC BONUS");
    displayMessage("LONG BREAK", "+10 SEC ADDED", driver->name);
    delay(1200);
  } else {
    Serial.println("SHORT BREAK");
    Serial.println("NO BONUS");
    displayMessage("SHORT BREAK", "NO EXTRA TIME", driver->name);
    delay(1000);
  }

  driver->hasExited = false;
}


// =====================================================
// START DRIVER (UPDATED — added Firebase + backend)
// =====================================================

void startDriver(Driver* driver) {
  activeDriver = driver;
  sessionStart = millis();
  sessionRunning = true;
  limitReached = false;
  preAlertActive = false;
  preAlertShownThisSession = false;
  emergencyMode = false;

  // Ignition ON
  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  displayMessage("DRIVER STARTED", driver->name, "Ignition: ON");

  Serial.println();
  Serial.println("============================");
  Serial.print("DRIVER: ");
  Serial.println(driver->name);
  Serial.print("LIMIT: ");
  Serial.print(getDriverLimit(driver) / 1000);
  Serial.println(" SEC");
  Serial.println("============================");

  delay(1200);

  // ── NEW: Firebase pushes ──────────────────────────
  firebaseSetStatus("normal", driver->name.c_str());

  // Use GPS location if available, otherwise default
  if (gps.location.isValid()) {
    firebaseSetLocation(gps.location.lat(), gps.location.lng());
  } else {
    firebaseSetLocation(19.0760, 72.8777);
  }

  firebasePushEvent("Face Verified", driver->name.c_str());

  // ── NEW: Tell backend to start drowsiness monitoring
  callBackendMonitor("start");
}


// =====================================================
// EXIT DRIVER (UPDATED — added Firebase + backend)
// =====================================================

void exitDriver() {
  if (activeDriver == nullptr) return;

  unsigned long currentSession = millis() - sessionStart;
  activeDriver->savedTime += currentSession;

  unsigned long limit = getDriverLimit(activeDriver);
  if (activeDriver->savedTime > limit) {
    activeDriver->savedTime = limit;
  }

  activeDriver->lastExitTime = millis();
  activeDriver->hasExited = true;

  sessionRunning = false;
  limitReached = false;
  preAlertActive = false;
  preAlertShownThisSession = false;

  // Ignition OFF
  digitalWrite(GREEN_LED, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  displayMessage("DRIVER EXIT", activeDriver->name, "TIME SAVED");

  Serial.println();
  Serial.println("DRIVER EXITED");
  Serial.print("USED: ");
  Serial.print(activeDriver->savedTime / 1000);
  Serial.println(" SEC");
  Serial.print("BONUS: ");
  Serial.print(activeDriver->bonusTime / 1000);
  Serial.println(" SEC");

  // ── NEW: Firebase pushes ──────────────────────────
  firebasePushEvent("Session Ended", activeDriver->name.c_str());
  firebaseSetStatus("normal", "");

  // ── NEW: Tell backend to stop drowsiness monitoring
  callBackendMonitor("stop");

  delay(1500);
}


// =====================================================
// PRE-ALERT SCREEN (unchanged)
// =====================================================

void startPreAlert() {
  if (preAlertActive) return;
  if (preAlertShownThisSession) return;

  preAlertActive = true;
  preAlertShownThisSession = true;
  preAlertStart = millis();

  Serial.println();
  Serial.println("========== PRE ALERT ==========");
  Serial.println("Drink Water");
  Serial.println("Take Rest");
  Serial.println("Limit Near");
  Serial.println("==============================");

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("DRIVER ALERT!");
  display.setCursor(0, 16);
  display.println("Drink Water");
  display.setCursor(0, 30);
  display.println("Take Rest");
  display.setCursor(0, 44);
  display.println("Limit Near...");
  display.display();

  // One warning beep
  digitalWrite(BUZZER_PIN, HIGH);
  delay(300);
  digitalWrite(BUZZER_PIN, LOW);

  // ── NEW: Firebase push for pre-alert ──────────────
  if (activeDriver != nullptr) {
    firebasePushEvent("Pre-Alert", activeDriver->name.c_str());
    firebaseSetStatus("pre-alert", activeDriver->name.c_str());
  }
}


// =====================================================
// CHECK PRE-ALERT SCREEN TIME (unchanged)
// =====================================================

void handlePreAlert() {
  if (!preAlertActive) return;

  if (millis() - preAlertStart >= PRE_ALERT_DISPLAY_TIME) {
    preAlertActive = false;
    Serial.println("Pre-alert finished.");
    Serial.println("Returning to timing screen.");
    updateNormalDisplay();
  }
}


// =====================================================
// LIMIT REACHED (unchanged)
// =====================================================

void triggerLimit() {
  if (activeDriver == nullptr) return;
  if (limitReached) return;

  limitReached = true;

  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, HIGH);

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("LIMIT REACHED!");
  display.setCursor(0, 14);
  display.println("TAKE REST");
  display.setCursor(0, 28);
  display.println("Ignition: ON");
  display.setCursor(0, 42);
  display.println("Speed: 20 km/h");
  display.setCursor(0, 56);
  display.println("RFID = EXIT");
  display.display();

  Serial.println();
  Serial.println("==============================");
  Serial.println("LIMIT REACHED");
  Serial.println("IGNITION = ON");
  Serial.println("SPEED = 20 KM/H");
  Serial.println("RFID EXIT REQUIRED");
  Serial.println("==============================");

  digitalWrite(BUZZER_PIN, HIGH);
  delay(500);
  digitalWrite(BUZZER_PIN, LOW);
}


// =====================================================
// LIMIT DISPLAY (unchanged)
// =====================================================

void updateLimitDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("LIMIT REACHED!");
  display.setCursor(0, 14);
  display.println("REST REQUIRED");
  display.setCursor(0, 28);
  display.println("Ignition: ON");
  display.setCursor(0, 42);
  display.println("Speed: 20 km/h");
  display.setCursor(0, 56);
  display.println("RFID = EXIT");
  display.display();
}


// =====================================================
// NORMAL TIMING SCREEN (unchanged)
// =====================================================

void updateNormalDisplay() {
  if (activeDriver == nullptr) return;

  unsigned long remaining = getRemainingTime();
  unsigned long seconds = remaining / 1000;

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.print("Driver: ");
  display.println(activeDriver->name);

  display.setCursor(0, 13);
  display.println("Status: NORMAL");

  display.setCursor(0, 26);
  display.print("Time: ");
  display.print(seconds);
  display.println(" sec");

  display.setCursor(0, 39);
  display.println("Ignition: ON");

  display.setCursor(0, 52);
  display.println("RFID = EXIT");

  display.display();
}


// =====================================================
// SOS START (UPDATED — added Firebase push)
// =====================================================

void startSOS() {
  if (emergencyMode) return;

  emergencyMode = true;

  Serial.println();
  Serial.println("==============================");
  Serial.println("SOS ACTIVATED");
  Serial.println("==============================");

  digitalWrite(GREEN_LED, HIGH);
  digitalWrite(RED_LED, HIGH);

  digitalWrite(BUZZER_PIN, HIGH);
  delay(300);
  digitalWrite(BUZZER_PIN, LOW);

  lastSosBeep = millis();

  updateSOSDisplay();

  // ── NEW: Firebase pushes ──────────────────────────
  if (activeDriver != nullptr) {
    firebasePushEvent("SOS Exceeded", activeDriver->name.c_str());
    firebaseSetStatus("exceeded", activeDriver->name.c_str());
  } else {
    firebasePushEvent("SOS Exceeded", "Unknown");
    firebaseSetStatus("exceeded", "Unknown");
  }
}


// =====================================================
// SOS DISPLAY (unchanged)
// =====================================================

void updateSOSDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.println("!!! EMERGENCY !!!");
  display.setCursor(0, 15);
  display.println("SOS MODE ACTIVE");
  display.setCursor(0, 30);
  display.println("Speed: 20 km/h");
  display.setCursor(0, 45);
  display.println("Press SOS = OFF");

  display.display();
}


// =====================================================
// SOS STOP (unchanged)
// =====================================================

void stopSOS() {
  emergencyMode = false;

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RED_LED, LOW);

  if (sessionRunning) {
    digitalWrite(GREEN_LED, HIGH);
    if (limitReached) {
      updateLimitDisplay();
    } else {
      updateNormalDisplay();
    }
  } else {
    digitalWrite(GREEN_LED, LOW);
    displayMessage("SOS OFF", "SYSTEM NORMAL");
  }

  Serial.println("SOS CANCELLED");
}


// =====================================================
// SOS BUTTON (unchanged)
// =====================================================

void checkSOSButton() {
  bool pressed = digitalRead(SOS_BUTTON) == LOW;

  // Button just pressed
  if (pressed && !sosButtonPressed) {
    sosPressStart = millis();
    sosHoldTriggered = false;
    sosButtonPressed = true;

    if (emergencyMode) {
      stopSOS();
      sosHoldTriggered = true;
    }
  }

  // Button held
  if (pressed && sosButtonPressed && !emergencyMode) {
    unsigned long holdTime = millis() - sosPressStart;
    if (holdTime >= SOS_HOLD_TIME && !sosHoldTriggered) {
      sosHoldTriggered = true;
      startSOS();
    }
  }

  // Button released
  if (!pressed && sosButtonPressed) {
    sosButtonPressed = false;
    sosHoldTriggered = false;
  }
}


// =====================================================
// SOS BEEP (unchanged)
// =====================================================

void handleSOSBuzzer() {
  if (!emergencyMode) return;

  unsigned long now = millis();
  if (now - lastSosBeep >= SOS_BEEP_INTERVAL) {
    lastSosBeep = now;
    digitalWrite(BUZZER_PIN, HIGH);
    delay(300);
    digitalWrite(BUZZER_PIN, LOW);
    updateSOSDisplay();
  }
}


// =====================================================
// RFID (unchanged)
// =====================================================

// =====================================================
// PENDING VERIFICATION HELPERS
// =====================================================

void cancelPendingVerification(const char* reason) {
  pendingVerification = false;
  pendingRfidUid = "";
  pendingDriver = nullptr;
  pendingStartTime = 0;

  Serial.print("[Pending] Cancelled: ");
  Serial.println(reason);

  displayMessage("VERIFICATION", String(reason), "Tap RFID to retry");
  delay(1500);
  displayMessage("SYSTEM READY", "Tap RFID Card", "Waiting...");
}

void updatePendingDisplay() {
  if (!pendingVerification || pendingDriver == nullptr) return;

  unsigned long elapsed = millis() - pendingStartTime;
  unsigned long remaining = 0;
  if (elapsed < PENDING_TIMEOUT) {
    remaining = (PENDING_TIMEOUT - elapsed) / 1000;
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.print("RFID: ");
  display.println(pendingDriver->name);

  display.setCursor(0, 14);
  display.println(">> VERIFY FACE <<");

  display.setCursor(0, 28);
  display.println("On Website Now!");

  display.setCursor(0, 42);
  display.print("Timeout: ");
  display.print(remaining);
  display.println("s");

  display.setCursor(0, 56);
  display.println("RFID = Cancel");

  display.display();
}


void checkRFID() {
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = getUID();
  Serial.print("RFID: ");
  Serial.println(uid);

  Driver* selectedDriver = findDriver(uid);

  // Unknown card
  if (selectedDriver == nullptr) {
    Serial.println("UNKNOWN RFID");
    rfidErrorBeep();
    displayMessage("UNKNOWN CARD", "ACCESS DENIED");
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(1000);
    return;
  }

  // Valid card
  rfidSuccessBeep();
  Serial.print("VALID: ");
  Serial.println(selectedDriver->name);

  // ── If currently pending verification, same card = cancel ──
  if (pendingVerification && pendingDriver == selectedDriver) {
    cancelPendingVerification("Cancelled by user");
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  // ── If currently pending, different card = switch pending driver ──
  if (pendingVerification && pendingDriver != selectedDriver) {
    Serial.println("[Pending] Switching to different driver");
    // Cancel old pending and set new one below
    pendingVerification = false;
    pendingDriver = nullptr;
    pendingRfidUid = "";
  }

  // Same driver = exit
  if (sessionRunning && activeDriver == selectedDriver) {
    exitDriver();
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    return;
  }

  // Different driver while session active
  if (sessionRunning && activeDriver != selectedDriver) {
    unsigned long currentSession = millis() - sessionStart;
    activeDriver->savedTime += currentSession;

    unsigned long currentLimit = getDriverLimit(activeDriver);
    if (activeDriver->savedTime > currentLimit) {
      activeDriver->savedTime = currentLimit;
    }

    activeDriver->lastExitTime = millis();
    activeDriver->hasExited = true;
    sessionRunning = false;

    digitalWrite(GREEN_LED, LOW);
    digitalWrite(RED_LED, LOW);
    digitalWrite(BUZZER_PIN, LOW);
  }

  // Check break bonus
  if (selectedDriver->hasExited) {
    checkBreakBonus(selectedDriver);
  }

  // Check if limit already reached
  if (selectedDriver->savedTime >= getDriverLimit(selectedDriver)) {
    activeDriver = selectedDriver;
    limitReached = true;
    sessionRunning = false;

    digitalWrite(GREEN_LED, LOW);
    digitalWrite(RED_LED, HIGH);

    displayMessage("REST REQUIRED", selectedDriver->name, "LIMIT COMPLETED");

    digitalWrite(BUZZER_PIN, HIGH);
    delay(500);
    digitalWrite(BUZZER_PIN, LOW);

    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(1500);
    return;
  }

  // ── ENTER PENDING VERIFICATION STATE ──────────────────
  // Do NOT call startDriver() directly!
  pendingVerification = true;
  pendingRfidUid = uid;
  pendingDriver = selectedDriver;
  pendingStartTime = millis();

  Serial.println("[Pending] Waiting for face verification...");
  Serial.print("[Pending] Driver: ");
  Serial.println(selectedDriver->name);
  Serial.print("[Pending] RFID UID: ");
  Serial.println(uid);

  // Blink LED to show pending state
  digitalWrite(RED_LED, HIGH);
  digitalWrite(GREEN_LED, HIGH);

  updatePendingDisplay();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}


// =====================================================
// GPS (unchanged)
// =====================================================

void readGPS() {
  while (GPSserial.available()) {
    char c = GPSserial.read();
    gps.encode(c);
  }
}

void printGPSData() {
  if (gps.location.isValid()) {
    Serial.print("Latitude: ");
    Serial.println(gps.location.lat(), 6);
    Serial.print("Longitude: ");
    Serial.println(gps.location.lng(), 6);
  } else {
    Serial.println("GPS: Waiting for fix...");
  }

  if (gps.speed.isValid()) {
    Serial.print("GPS Speed: ");
    Serial.print(gps.speed.kmph());
    Serial.println(" km/h");
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// NEW: WEB SERVER HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

void handleVerifyRoute() {
  // Called by the Python backend after face verification.
  // Enforces: face-verified name + RFID UID must BOTH match the pending state.
  String body = server.arg("plain");
  Serial.println("[WebServer] POST /verify received");
  Serial.println(body);

  // ── Extract driver name from JSON body ──
  String name = "";
  int nameIdx = body.indexOf("\"name\"");
  if (nameIdx >= 0) {
    int colonIdx = body.indexOf(":", nameIdx);
    int quoteStart = body.indexOf("\"", colonIdx + 1);
    int quoteEnd = body.indexOf("\"", quoteStart + 1);
    if (quoteStart >= 0 && quoteEnd > quoteStart) {
      name = body.substring(quoteStart + 1, quoteEnd);
    }
  }

  // ── Extract RFID UID from JSON body ──
  String rfidUid = "";
  int rfidIdx = body.indexOf("\"rfid\"");
  if (rfidIdx >= 0) {
    int colonIdx = body.indexOf(":", rfidIdx);
    int quoteStart = body.indexOf("\"", colonIdx + 1);
    int quoteEnd = body.indexOf("\"", quoteStart + 1);
    if (quoteStart >= 0 && quoteEnd > quoteStart) {
      rfidUid = body.substring(quoteStart + 1, quoteEnd);
    }
  }

  Serial.print("[Verify] Name: ");
  Serial.println(name);
  Serial.print("[Verify] RFID: ");
  Serial.println(rfidUid);

  // ── Guard: Must be in pending verification state ──
  if (!pendingVerification) {
    Serial.println("[Verify] REJECTED: No RFID tap pending");
    server.send(403, "application/json",
      "{\"ok\":false,\"error\":\"No RFID tap pending. Tap your card first.\"}");
    return;
  }

  // ── Guard: Session already running ──
  if (sessionRunning) {
    Serial.println("[Verify] REJECTED: Session already active");
    server.send(200, "application/json",
      "{\"ok\":false,\"error\":\"Session already active\"}");
    return;
  }

  // ── STRICT MATCH: RFID UID must match the pending tap ──
  if (!pendingRfidUid.equalsIgnoreCase(rfidUid)) {
    Serial.println("[Verify] REJECTED: RFID UID mismatch!");
    Serial.print("  Pending: ");
    Serial.println(pendingRfidUid);
    Serial.print("  Received: ");
    Serial.println(rfidUid);

    displayMessage("RFID MISMATCH", "Wrong card for", name);
    rfidErrorBeep();
    delay(1500);
    updatePendingDisplay();

    server.send(403, "application/json",
      "{\"ok\":false,\"error\":\"RFID UID does not match the pending card tap\"}");
    return;
  }

  // ── STRICT MATCH: Driver name must match the pending driver ──
  if (pendingDriver == nullptr || !pendingDriver->name.equalsIgnoreCase(name)) {
    Serial.println("[Verify] REJECTED: Driver name mismatch!");
    Serial.print("  Pending driver: ");
    Serial.println(pendingDriver ? pendingDriver->name : "null");
    Serial.print("  Verified face: ");
    Serial.println(name);

    displayMessage("FACE MISMATCH", "Not card owner", name);
    rfidErrorBeep();
    delay(1500);
    updatePendingDisplay();

    server.send(403, "application/json",
      "{\"ok\":false,\"error\":\"Face does not match RFID card owner\"}");
    return;
  }

  // ── ALL CHECKS PASSED — Start the driving session ──
  Serial.println("[Verify] SUCCESS: Face matches RFID card owner!");

  // Clear pending state
  pendingVerification = false;
  pendingRfidUid = "";
  pendingStartTime = 0;
  Driver* verifiedDriver = pendingDriver;
  pendingDriver = nullptr;

  // Check break bonus before starting
  if (verifiedDriver->hasExited) {
    checkBreakBonus(verifiedDriver);
  }

  // Start the session!
  startDriver(verifiedDriver);

  server.send(200, "application/json",
    "{\"ok\":true,\"driver\":\"" + verifiedDriver->name + "\",\"message\":\"Session started after face verification\"}");
}

void handleDrowsyRoute() {
  // Called by the Python backend when drowsiness is detected
  Serial.println("[WebServer] POST /drowsy — DROWSINESS ALERT!");

  if (activeDriver != nullptr) {
    firebasePushEvent("Drowsiness", activeDriver->name.c_str());
    firebaseSetStatus("pre-alert", activeDriver->name.c_str());
  }

  // Flash warning on OLED
  for (int i = 0; i < 3; i++) {
    display.clearDisplay();
    display.setTextSize(2);
    display.setCursor(10, 20);
    display.println("DROWSY!");
    display.display();
    delay(300);
    display.clearDisplay();
    display.display();
    delay(200);
  }

  // Buzzer alert
  for (int i = 0; i < 3; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(200);
    digitalWrite(BUZZER_PIN, LOW);
    delay(100);
  }

  // Return to normal display
  if (sessionRunning) {
    if (limitReached) updateLimitDisplay();
    else updateNormalDisplay();
  }

  server.send(200, "application/json", "{\"ok\":true}");
}


// ═════════════════════════════════════════════════════════════════════════════
// NEW: BACKEND COMMUNICATION
// ═════════════════════════════════════════════════════════════════════════════

void callBackendMonitor(const char* action) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Backend] WiFi not connected, skipping");
    return;
  }

  HTTPClient http;
  String url = String(BACKEND_URL) + "/monitor/" + String(action);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST("{}");
  Serial.printf("[Backend] /monitor/%s -> HTTP %d\n", action, code);
  http.end();
}


// ═════════════════════════════════════════════════════════════════════════════
// NEW: FIREBASE HELPERS
// ═════════════════════════════════════════════════════════════════════════════

void firebaseSetStatus(const char* state, const char* driver) {
  if (!firebaseReady) return;

  FirebaseJson json;
  json.set("state",   state);
  json.set("driver",  driver);

  // Use real epoch time for sessionStart
  json.set("sessionStart", (double)currentEpochMs());
  json.set("battery",      82);             // placeholder
  json.set("signal",       "LTE - Strong"); // placeholder

  if (!Firebase.RTDB.setJSON(&fbdo, "/status", &json)) {
    Serial.printf("[Firebase] setStatus ERROR: %s\n", fbdo.errorReason().c_str());
  } else {
    Serial.printf("[Firebase] status -> %s / %s\n", state, driver);
  }
}

void firebaseSetLocation(float lat, float lng) {
  if (!firebaseReady) return;

  FirebaseJson json;
  json.set("lat",     (double)lat);
  json.set("lng",     (double)lng);
  json.set("updated", (double)currentEpochMs());

  if (!Firebase.RTDB.setJSON(&fbdo, "/status/location", &json)) {
    Serial.printf("[Firebase] setLocation ERROR: %s\n", fbdo.errorReason().c_str());
  }
}

void firebasePushEvent(const char* eventType, const char* driver) {
  if (!firebaseReady) return;

  FirebaseJson json;
  json.set("time",   (double)currentEpochMs());
  json.set("type",   eventType);
  json.set("driver", driver);

  if (!Firebase.RTDB.pushJSON(&fbdo, "/events", &json)) {
    Serial.printf("[Firebase] pushEvent ERROR: %s\n", fbdo.errorReason().c_str());
  } else {
    Serial.printf("[Firebase] event: %s by %s\n", eventType, driver);
  }
}


// ═════════════════════════════════════════════════════════════════════════════
// NEW: GPS → Firebase location update (periodic)
// ═════════════════════════════════════════════════════════════════════════════

unsigned long lastLocationPush = 0;
const unsigned long LOCATION_PUSH_INTERVAL = 10000; // every 10 sec

void pushGPSLocation() {
  if (!sessionRunning || activeDriver == nullptr) return;
  if (millis() - lastLocationPush < LOCATION_PUSH_INTERVAL) return;
  if (!gps.location.isValid()) return;

  lastLocationPush = millis();
  firebaseSetLocation(gps.location.lat(), gps.location.lng());
}


// =====================================================
// SETUP (UPDATED — added WiFi, WebServer, Firebase)
// =====================================================

void setup() {
  Serial.begin(115200);

  // ── Outputs ───────────────────────────────────────
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(RED_LED, LOW);
  digitalWrite(GREEN_LED, LOW);

  // ── SOS Button ────────────────────────────────────
  pinMode(SOS_BUTTON, INPUT_PULLUP);

  // ── OLED ──────────────────────────────────────────
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED ERROR!");
    while (1);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("DRIVER SAFETY SYSTEM");
  display.setCursor(0, 20);
  display.println("Starting...");
  display.display();
  delay(1500);

  // ── RFID ──────────────────────────────────────────
  SPI.begin(RFID_SCK, RFID_MISO, RFID_MOSI, RFID_SS);
  rfid.PCD_Init();
  delay(100);

  // ── GPS ───────────────────────────────────────────
  GPSserial.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);

  // ── NEW: WiFi ─────────────────────────────────────
  displayMessage("WiFi", "Connecting...", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("[WiFi] Connecting to %s ", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    displayMessage("WiFi Connected", WiFi.localIP().toString(), "");
    delay(1000);
  } else {
    Serial.println("\n[WiFi] FAILED — running offline");
    displayMessage("WiFi FAILED", "Running offline", "");
    delay(1000);
  }

  // ── NEW: NTP time sync ────────────────────────────
  configTime(19800, 0, "pool.ntp.org", "time.nist.gov"); // IST = UTC+5:30
  Serial.println("[NTP] Syncing time...");
  delay(2000);
  time_t now;
  time(&now);
  if (now > 100000) {
    epochAtBoot = now;
    millisAtEpochSync = millis();
    Serial.printf("[NTP] Epoch: %lu\n", epochAtBoot);
  }

  // ── NEW: Firebase init ────────────────────────────
  fbConfig.api_key      = FIREBASE_API_KEY;
  fbConfig.database_url = FIREBASE_DB_URL;

  // Use legacy database secret for auth (no user login needed)
  fbConfig.signer.tokens.legacy_token = FIREBASE_DB_SECRET;

  Firebase.begin(&fbConfig, &fbAuth);
  Firebase.reconnectNetwork(true);
  firebaseReady = true;
  Serial.println("[Firebase] Initialized");

  // ── NEW: WebServer routes ─────────────────────────
  server.on("/verify", HTTP_POST, handleVerifyRoute);
  server.on("/drowsy", HTTP_POST, handleDrowsyRoute);
  server.begin();
  Serial.println("[WebServer] Started on port 80");

  // ── Ready ─────────────────────────────────────────
  displayMessage("SYSTEM READY", "Tap RFID Card", "Waiting...");

  Serial.println();
  Serial.println("==============================");
  Serial.println("DRIVER SAFETY SYSTEM READY");
  Serial.println("==============================");
  Serial.println("Parth: B3 3D 02 04");
  Serial.println("Swanandi: CD 3E C8 01");
  Serial.print("Drive limit: ");
  Serial.print(BASE_DRIVE_LIMIT / 1000);
  Serial.println(" sec");
  Serial.print("Pre-alert: ");
  Serial.print(PRE_ALERT_TIME / 1000);
  Serial.println(" sec before limit");
  Serial.print("Long break: >");
  Serial.print(LONG_BREAK_TIME / 1000);
  Serial.println(" sec");
  Serial.print("Break bonus: +");
  Serial.print(BREAK_BONUS / 1000);
  Serial.println(" sec");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("ESP32 IP: ");
    Serial.println(WiFi.localIP().toString());
    Serial.print("Backend: ");
    Serial.println(BACKEND_URL);
  }
  Serial.println("==============================");
}


// =====================================================
// MAIN LOOP (UPDATED — added server.handleClient + GPS push)
// =====================================================

void loop() {
  // ── NEW: Handle incoming HTTP requests ────────────
  server.handleClient();

  // GPS
  readGPS();

  // RFID
  checkRFID();

  // SOS
  checkSOSButton();

  // ── PENDING VERIFICATION TIMEOUT ──────────────────
  if (pendingVerification) {
    // Check for timeout
    if (millis() - pendingStartTime >= PENDING_TIMEOUT) {
      cancelPendingVerification("TIMEOUT");
      digitalWrite(RED_LED, LOW);
      digitalWrite(GREEN_LED, LOW);
    } else {
      // Update the countdown display every 500ms
      static unsigned long lastPendingDisplay = 0;
      if (millis() - lastPendingDisplay >= 500) {
        lastPendingDisplay = millis();
        updatePendingDisplay();
      }
    }
    delay(10);
    return;  // Don't process session logic while pending
  }

  // ── SOS MODE ──────────────────────────────────────
  if (emergencyMode) {
    handleSOSBuzzer();
    delay(10);
    return;
  }

  // ── PRE-ALERT ─────────────────────────────────────
  if (preAlertActive) {
    handlePreAlert();
    delay(10);
    return;
  }

  // ── DRIVER SESSION ────────────────────────────────
  if (sessionRunning) {
    unsigned long used = getUsedTime();
    unsigned long limit = getDriverLimit(activeDriver);
    unsigned long remaining = 0;

    if (used < limit) {
      remaining = limit - used;
    }

    // Pre-alert check
    if (remaining <= PRE_ALERT_TIME && remaining > 0 && !preAlertShownThisSession) {
      startPreAlert();
    }

    // Limit check
    if (used >= limit) {
      triggerLimit();
    }

    // Normal display update
    if (!preAlertActive && !limitReached) {
      static unsigned long lastDisplay = 0;
      if (millis() - lastDisplay >= 500) {
        lastDisplay = millis();
        updateNormalDisplay();
      }
    }

    // Limit warning
    if (limitReached) {
      static unsigned long lastLimitDisplay = 0;
      if (millis() - lastLimitDisplay >= 1000) {
        lastLimitDisplay = millis();
        updateLimitDisplay();
      }

      static unsigned long lastLimitBeep = 0;
      if (millis() - lastLimitBeep >= 2000) {
        lastLimitBeep = millis();
        digitalWrite(BUZZER_PIN, HIGH);
        delay(300);
        digitalWrite(BUZZER_PIN, LOW);
      }
    }
  }

  // ── NEW: Push GPS location periodically ───────────
  pushGPSLocation();

  // ── GPS serial output ─────────────────────────────
  static unsigned long lastGPSPrint = 0;
  if (millis() - lastGPSPrint >= 5000) {
    lastGPSPrint = millis();
    printGPSData();
  }

  delay(10);
}
