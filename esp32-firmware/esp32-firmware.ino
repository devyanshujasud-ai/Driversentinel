/*
 * =============================================================================
 * DRIVERSENTINEL — ESP32 CAB CONTROLLER FIRMWARE
 * Multi-Factor Driver Safety, RFID Access, Fatigue HUD & Cloud Sync
 * =============================================================================
 *
 * Hardware Configuration:
 *   - OLED Display (SSD1306 128x64 I2C): SDA=21, SCL=25
 *   - RFID Reader (MFRC522 SPI): SS=5, RST=22, SCK=18, MISO=19, MOSI=23
 *   - Output Pins: BUZZER_PIN=15, IGNITION_PIN=26, RED_LED=27
 *   - Input Pins: SOS_PIN=13 (Touch/Button)
 *
 * Software & Cloud Integration:
 *   - Local WebServer (Port 80):
 *       POST /drowsy → Triggered by Python Vision AI upon micro-sleep/fatigue
 *       POST /unlock → Triggered by React Frontend upon face verification
 *       GET  /status → Live hardware telemetry
 *   - Auto-Discovery: Registers ESP32 IP with Flask backend upon WiFi connect
 *   - Firebase Realtime Database: Syncs RFID /pending and /events live
 * =============================================================================
 */

#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>

#include "config.h"

// =====================================================
// OLED DISPLAY
// =====================================================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define OLED_SDA 21
#define OLED_SCL 25

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

// =====================================================
// RFID MFRC522
// =====================================================
#define RFID_SS 5
#define RFID_RST 22

MFRC522 rfid(RFID_SS, RFID_RST);

// =====================================================
// HARDWARE PINS
// =====================================================
#define BUZZER_PIN 15
#define IGNITION_PIN 26
#define RED_LED 27
#define SOS_PIN 13

// =====================================================
// AUTHORIZED DRIVER UIDs
// =====================================================
byte DRIVER1_UID[] = {0xB3, 0x3D, 0x02, 0x04};
byte DRIVER2_UID[] = {0xCD, 0x3E, 0xC8, 0x01};

// =====================================================
// TIMINGS
// =====================================================
#define DRIVE_LIMIT 60000UL          // 60 seconds drive limit
#define REST_LOCK_TIME 15000UL       // 15 seconds mandatory rest lock
#define REMINDER_INTERVAL 15000UL    // 15 seconds periodic rest chime
#define PRE_LIMIT_WARNING 10000UL    // 10 seconds pre-limit warning
#define SOS_HOLD_TIME 3000UL         // 3 seconds hold to trigger SOS
#define RFID_COOLDOWN 1500UL         // 1.5 seconds RFID scan debounce
#define WARNING_DISPLAY_TIME 3000UL  // 3 seconds warning display duration
#define DROWSY_DISPLAY_TIME 4000UL   // 4 seconds drowsiness alert display duration

// =====================================================
// DRIVER DATA STRUCTURE
// =====================================================
struct DriverData {
  const char* name;
  const char* rfidHex;
  unsigned long remainingTime;
  bool driving;
  bool limitReached;
  unsigned long lastStartTime;
  unsigned long lastReminderTime;
};

DriverData driver1 = {
  "DRIVER 1",
  "B33D0204",
  DRIVE_LIMIT,
  false,
  false,
  0,
  0
};

DriverData driver2 = {
  "DRIVER 2",
  "CD3EC801",
  DRIVE_LIMIT,
  false,
  false,
  0,
  0
};

DriverData* currentDriver = nullptr;
DriverData* pendingDriver = nullptr;
bool waitingForFaceVerify = false;
unsigned long faceVerifyStartTime = 0;
#define FACE_VERIFY_TIMEOUT 60000UL

// =====================================================
// SYSTEM STATES
// =====================================================
bool restLock = false;
unsigned long restStartTime = 0;

bool sosActive = false;
bool sosTouching = false;
bool previousSOSState = false;
unsigned long sosStartTime = 0;

unsigned long lastDisplayUpdate = 0;
unsigned long lastRFIDTime = 0;
unsigned long lastReminderTime = 0;
unsigned long lastSOSBeep = 0;

// Warning state
bool warningActive = false;
unsigned long warningStartTime = 0;
unsigned long lastWarningBeep = 0;

// Vision AI Drowsiness alert state
bool drowsyAlertActive = false;
unsigned long drowsyAlertStartTime = 0;
String drowsyAlertReason = "DROWSINESS DETECTED";

// =====================================================
// WEBSERVER & NETWORKING
// =====================================================
WebServer server(80);
bool wifiConnected = false;

// =====================================================
// FUNCTION DECLARATIONS
// =====================================================
void showReadyScreen();
void showDrivingScreen();
void showWarningScreen();
void showLimitScreen();
void showRestScreen();
void showSOSScreen();
void showDrowsyScreen();
void showWiFiScreen(const char* status, const char* detail);

void checkRFID();
void handleDriverRFID(DriverData* driver);

void updateDrivingTime();
void handleRestLock();
void handleSOS();

void startDriving(DriverData* driver);
void stopDriving();
void startRestLock();

void activateSOS();
void cancelSOS();

bool compareUID(byte* uid, byte* knownUID);
void beep(int times, int duration);

// Network & Cloud Helpers
void connectWiFi();
void registerWithBackend();
void syncRFIDToFirebase(const char* driverName, const char* rfidHex);
void syncEventToFirebase(const char* eventType, const char* driverName);
void syncVehicleStateToFirebase();

// HTTP Server Handlers
void handleDrowsy();
void handleUnlock();
void handleStatus();
void handleNotFound();

// =====================================================
// SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(200);

  Serial.println();
  Serial.println("==========================================");
  Serial.println(" DRIVERSENTINEL — ESP32 CAB CONTROLLER    ");
  Serial.println("==========================================");

  // Initialize Pins
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(IGNITION_PIN, OUTPUT);
  pinMode(RED_LED, OUTPUT);
  pinMode(SOS_PIN, INPUT);

  digitalWrite(BUZZER_PIN, LOW);
  digitalWrite(IGNITION_PIN, LOW);
  digitalWrite(RED_LED, LOW);

  // Initialize OLED
  Wire.begin(OLED_SDA, OLED_SCL);
  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("[ERROR] SSD1306 OLED initialization failed!");
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.display();
    showWiFiScreen("INITIALIZING...", "DRIVER SENTINEL");
  }

  // Initialize RFID
  SPI.begin(18, 19, 23, 5);
  rfid.PCD_Init();
  Serial.println("[OK] RFID RC522 initialized on SPI (SS=5, RST=22)");

  // Connect to WiFi
  connectWiFi();

  // Setup WebServer endpoints
  server.on("/drowsy", HTTP_POST, handleDrowsy);
  server.on("/drowsy", HTTP_GET, handleDrowsy);
  server.on("/unlock", HTTP_POST, handleUnlock);
  server.on("/unlock", HTTP_GET, handleUnlock);
  server.on("/verify", HTTP_POST, handleUnlock);
  server.on("/verify", HTTP_GET, handleUnlock);
  server.on("/status", HTTP_GET, handleStatus);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("[OK] Local HTTP WebServer listening on Port 80");

  // Beep to indicate hardware readiness
  beep(2, 80);
  showReadyScreen();

  Serial.println("==========================================");
  Serial.println(" HARDWARE + SOFTWARE READY FOR OPERATION ");
  Serial.println("==========================================");
}

// =====================================================
// MAIN LOOP
// =====================================================
void loop() {
  // ── Handle incoming USB Serial commands from Computer ───────────
  if (Serial.available() > 0) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.indexOf("DROWSY") >= 0 || cmd.indexOf("ALERT") >= 0) {
      if (currentDriver == nullptr || !currentDriver->driving) {
        Serial.println("[USB-ALERT IGNORED] Drowsiness signal received but vehicle ignition is OFF / no driver active.");
        Serial.println("ACK:DROWSY_IGNORED");
      } else {
        Serial.println("[USB-ALERT] DROWSINESS DETECTED BY COMPUTER VISION AI!");
        drowsyAlertActive = true;
        drowsyAlertStartTime = millis();
        drowsyAlertReason = "MICRO-SLEEP ALERT";
        digitalWrite(RED_LED, HIGH);
        beep(4, 200);
        showDrowsyScreen();
        Serial.println("ACK:DROWSY");
      }
    } else if (cmd.indexOf("UNLOCK") >= 0) {
      Serial.println("[USB-UNLOCK] BIOMETRIC FACE VERIFIED! UNLOCKING IGNITION.");
      handleUnlock();
      Serial.println("ACK:UNLOCKED");
    }
  }

  // Timeout for pending face verification
  if (waitingForFaceVerify && (millis() - faceVerifyStartTime >= FACE_VERIFY_TIMEOUT)) {
    waitingForFaceVerify = false;
    pendingDriver = nullptr;
    Serial.println("[TIMEOUT] Face verification window expired. Please tap RFID again.");
    showReadyScreen();
  }

  // Handle incoming HTTP requests if on WiFi
  server.handleClient();

  // SOS has highest priority
  handleSOS();
  if (sosActive) {
    showSOSScreen();
    delay(20);
    return;
  }

  // Drowsiness alert has second priority
  if (drowsyAlertActive) {
    if (millis() - drowsyAlertStartTime < DROWSY_DISPLAY_TIME) {
      if (millis() - lastDisplayUpdate >= 200) {
        showDrowsyScreen();
        lastDisplayUpdate = millis();
      }
    } else {
      drowsyAlertActive = false;
      digitalWrite(RED_LED, LOW);
    }
    delay(10);
    return;
  }

  // Mandatory rest lock
  if (restLock) {
    handleRestLock();
    delay(20);
    return;
  }

  // RFID reader polling
  checkRFID();

  // Active driving logic
  if (currentDriver != nullptr && currentDriver->driving) {
    updateDrivingTime();

    // Warning screen has display priority
    if (warningActive) {
      if (millis() - warningStartTime < WARNING_DISPLAY_TIME) {
        if (millis() - lastDisplayUpdate >= 200) {
          showWarningScreen();
          lastDisplayUpdate = millis();
        }
      } else {
        warningActive = false;
        showDrivingScreen();
        lastDisplayUpdate = millis();
      }
    } else {
      // Normal driving display
      if (millis() - lastDisplayUpdate >= 200) {
        showDrivingScreen();
        lastDisplayUpdate = millis();
      }
    }
  }

  delay(10);
}

// =====================================================
// WIFI CONNECTION & BACKEND DISCOVERY
// =====================================================
void connectWiFi() {
  Serial.printf("[WIFI] Connecting to SSID: %s ...\n", WIFI_SSID);
  showWiFiScreen("CONNECTING WIFI", WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    String ipStr = WiFi.localIP().toString();
    Serial.printf("[WIFI] Connected! Assigned IP: %s\n", ipStr.c_str());
    showWiFiScreen("WIFI CONNECTED", ipStr.c_str());
    delay(800);

    // Register with backend automatically so Flask knows our IP
    registerWithBackend();
  } else {
    wifiConnected = false;
    Serial.println("[SYSTEM] WiFi offline. Running directly in USB Serial COM Mode.");
    showWiFiScreen("USB COM ACTIVE", "READY (115200)");
    delay(800);
  }
}

void registerWithBackend() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(BACKEND_URL) + "/esp32/register?ip=" + WiFi.localIP().toString();
  Serial.printf("[HTTP] Registering with backend: %s\n", url.c_str());
  http.begin(url);
  int httpCode = http.GET();
  if (httpCode > 0) {
    Serial.printf("[HTTP] Backend registration OK (HTTP %d)\n", httpCode);
  } else {
    Serial.printf("[HTTP] Backend registration failed: %s\n", http.errorToString(httpCode).c_str());
  }
  http.end();
}

// =====================================================
// HTTP WEBSERVER HANDLERS (CALLED BY SOFTWARE)
// =====================================================

// Vision Backend calls POST /drowsy when eye closure / micro-sleep / yawn is detected
void handleDrowsy() {
  if (currentDriver == nullptr || !currentDriver->driving) {
    Serial.println("[DROWSY IGNORED] Drowsiness signal received but vehicle ignition is OFF / no driver active.");
    server.send(200, "application/json", "{\"status\":\"ignored\",\"reason\":\"not_driving\"}");
    return;
  }

  Serial.println("==========================================");
  Serial.println("[ALERT] DROWSINESS SIGNAL FROM VISION AI!");
  Serial.println("==========================================");

  drowsyAlertActive = true;
  drowsyAlertStartTime = millis();

  if (server.hasArg("reason")) {
    drowsyAlertReason = server.arg("reason");
  } else {
    drowsyAlertReason = "MICRO-SLEEP DETECTED";
  }

  // Sound loud cab alert
  digitalWrite(RED_LED, HIGH);
  beep(4, 200);

  server.send(200, "application/json", "{\"status\":\"alert_acknowledged\",\"alert\":\"drowsy\"}");
}

// Web App calls POST /unlock or /verify when face biometric verification passes
void handleUnlock() {
  Serial.println("[UNLOCK] Biometric Face Verification Passed. Unlocking Ignition.");
  waitingForFaceVerify = false;
  if (pendingDriver != nullptr) {
    startDriving(pendingDriver);
    pendingDriver = nullptr;
  } else if (currentDriver != nullptr && !currentDriver->driving) {
    startDriving(currentDriver);
  } else {
    startDriving(&driver1);
  }
  server.send(200, "application/json", "{\"status\":\"unlocked\",\"ignition\":true}");
}

void handleStatus() {
  String json = "{";
  json += "\"wifi_ip\":\"" + WiFi.localIP().toString() + "\",";
  json += "\"driving\":" + String((currentDriver && currentDriver->driving) ? "true" : "false") + ",";
  json += "\"driver\":\"" + String(currentDriver ? currentDriver->name : "NONE") + "\",";
  json += "\"remaining_time\":" + String(currentDriver ? currentDriver->remainingTime : 0) + ",";
  json += "\"rest_lock\":" + String(restLock ? "true" : "false") + ",";
  json += "\"sos\":" + String(sosActive ? "true" : "false");
  json += "}";
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "DriverSentinel ESP32 Endpoint Not Found");
}

// =====================================================
// FIREBASE REALTIME DATABASE SYNC
// =====================================================
void syncRFIDToFirebase(const char* driverName, const char* rfidHex) {
  if (WiFi.status() != WL_CONNECTED) return;

  // 1. Direct Firebase RTDB via secure client
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + "/pending.json";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"driver\":\"" + String(driverName) + "\",";
  payload += "\"rfid\":\"" + String(rfidHex) + "\",";
  payload += "\"time\":" + String(millis());
  payload += "}";

  int httpCode = http.PUT(payload);
  Serial.printf("[FIREBASE] /pending sync -> HTTP %d\n", httpCode);
  http.end();

  // 2. Local Vision Backend LAN direct call (fast & reliable)
  HTTPClient bHttp;
  String bUrl = String(BACKEND_URL) + "/esp32/rfid?driver=" + String(driverName) + "&rfid=" + String(rfidHex);
  bHttp.begin(bUrl);
  int bCode = bHttp.GET();
  Serial.printf("[BACKEND] /esp32/rfid direct -> HTTP %d\n", bCode);
  bHttp.end();
}

void syncEventToFirebase(const char* eventType, const char* driverName) {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + "/events.json";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"driver\":\"" + String(driverName) + "\",";
  payload += "\"type\":\"" + String(eventType) + "\",";
  payload += "\"time\":" + String(millis());
  payload += "}";

  int httpCode = http.POST(payload);
  Serial.printf("[FIREBASE] /events log -> HTTP %d\n", httpCode);
  http.end();
}

void syncVehicleStateToFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  String url = String(FIREBASE_DB_URL) + "/vehicle.json";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");

  String payload = "{";
  payload += "\"driver\":\"" + String(currentDriver ? currentDriver->name : "NONE") + "\",";
  payload += "\"ignition\":" + String((currentDriver && currentDriver->driving) ? "true" : "false") + ",";
  payload += "\"speed\":" + String((currentDriver && currentDriver->driving) ? "45" : "0") + ",";
  payload += "\"rest_lock\":" + String(restLock ? "true" : "false") + ",";
  payload += "\"sos\":" + String(sosActive ? "true" : "false");
  payload += "}";

  http.PATCH(payload);
  http.end();
}

// =====================================================
// OLED DISPLAY SCREENS
// =====================================================
void showWiFiScreen(const char* status, const char* detail) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(20, 4);
  display.println("DRIVE SENTINEL");
  display.drawLine(0, 15, 127, 15, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(10, 26);
  display.println(status);

  display.setTextSize(1);
  display.setCursor(6, 44);
  display.println(detail);

  display.display();
}

void showReadyScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Header
  display.setTextSize(1);
  display.setCursor(22, 2);
  display.println("DRIVE SENTINEL");
  display.drawLine(0, 13, 127, 13, SSD1306_WHITE);

  // Main
  display.setTextSize(2);
  display.setCursor(18, 22);
  display.println("SYSTEM");
  display.setCursor(27, 42);
  display.println("READY");

  // Bottom
  display.setTextSize(1);
  display.setCursor(15, 56);
  display.println("SCAN DRIVER RFID");

  display.display();
}

void showDrivingScreen() {
  if (currentDriver == nullptr) return;

  unsigned long remaining = currentDriver->remainingTime;
  if (currentDriver->driving) {
    unsigned long elapsed = millis() - currentDriver->lastStartTime;
    if (elapsed < currentDriver->remainingTime) {
      remaining = currentDriver->remainingTime - elapsed;
    } else {
      remaining = 0;
    }
  }

  unsigned long seconds = (remaining + 999) / 1000;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  // Driver header
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(currentDriver->name);

  display.setCursor(88, 0);
  display.print("DRIVE");
  display.drawLine(0, 10, 127, 10, SSD1306_WHITE);

  // Active time label
  display.setTextSize(1);
  display.setCursor(30, 15);
  display.println("ACTIVE TIME");

  // Countdown
  display.setTextSize(2);
  if (seconds >= 10) {
    display.setCursor(45, 27);
  } else {
    display.setCursor(51, 27);
  }
  display.print(seconds);
  display.print("s");

  // Bottom status
  display.setTextSize(1);
  display.setCursor(3, 49);
  display.print("IGNITION: ON");
  display.setCursor(15, 59);
  display.print("SCAN RFID TO STOP");

  display.display();
}

void showWarningScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(43, 1);
  display.println("WARNING");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(17, 18);
  display.println("TAKE REST");

  unsigned long remaining = 0;
  if (currentDriver != nullptr) {
    unsigned long elapsed = millis() - currentDriver->lastStartTime;
    if (elapsed < currentDriver->remainingTime) {
      remaining = currentDriver->remainingTime - elapsed;
    }
  }

  unsigned long seconds = (remaining + 999) / 1000;
  display.setTextSize(1);
  display.setCursor(24, 38);
  display.print("LIMIT IN: ");
  display.print(seconds);
  display.print(" SEC");

  display.setCursor(11, 53);
  display.println("PLEASE STOP SAFELY");

  display.display();
}

void showLimitScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(25, 1);
  display.println("LIMIT REACHED");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(28, 17);
  display.println("30 KM/H");

  display.setTextSize(1);
  display.setCursor(39, 38);
  display.println("TAKE REST");

  display.setCursor(15, 53);
  display.println("SCAN RFID TO STOP");

  display.display();
}

void showRestScreen() {
  unsigned long elapsed = millis() - restStartTime;
  unsigned long remaining = 0;
  if (elapsed < REST_LOCK_TIME) {
    remaining = REST_LOCK_TIME - elapsed;
  }

  unsigned long seconds = (remaining + 999) / 1000;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(22, 1);
  display.println("MANDATORY REST");
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setCursor(35, 16);
  display.println("REST TIME");

  display.setTextSize(3);
  if (seconds >= 10) {
    display.setCursor(43, 27);
  } else {
    display.setCursor(52, 27);
  }
  display.print(seconds);

  display.setTextSize(1);
  display.setCursor(24, 55);
  display.println("VEHICLE LOCKED");

  display.display();
}

void showSOSScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(3);
  display.setCursor(38, 0);
  display.println("SOS");

  display.setTextSize(1);
  display.setCursor(35, 28);
  display.println("EMERGENCY");

  display.setTextSize(2);
  display.setCursor(28, 38);
  display.println("30 KM/H");

  display.setTextSize(1);
  display.setCursor(15, 57);
  display.println("TOUCH TO CANCEL");

  display.display();
}

void showDrowsyScreen() {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(2);
  display.setCursor(15, 2);
  display.println("WAKE UP!");

  display.drawLine(0, 20, 127, 20, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(10, 28);
  display.println("DROWSINESS ALERT");

  display.setCursor(6, 44);
  display.println(drowsyAlertReason);

  display.setCursor(12, 56);
  display.println("PULL OVER SAFELY");

  display.display();
}

// =====================================================
// DRIVING CONTROL
// =====================================================
void startDriving(DriverData* driver) {
  if (restLock) return;

  currentDriver = driver;
  currentDriver->driving = true;
  currentDriver->limitReached = false;
  currentDriver->lastStartTime = millis();
  currentDriver->lastReminderTime = millis();
  warningActive = false;

  digitalWrite(IGNITION_PIN, HIGH);
  digitalWrite(RED_LED, LOW);

  beep(2, 100);

  Serial.printf("[DRIVE] Started: %s\n", currentDriver->name);
  syncVehicleStateToFirebase();
  showDrivingScreen();
}

void stopDriving() {
  if (currentDriver == nullptr) return;

  unsigned long elapsed = millis() - currentDriver->lastStartTime;
  if (elapsed < currentDriver->remainingTime) {
    currentDriver->remainingTime -= elapsed;
  } else {
    currentDriver->remainingTime = 0;
  }

  currentDriver->driving = false;
  warningActive = false;

  digitalWrite(IGNITION_PIN, LOW);
  beep(1, 250);

  Serial.println("[DRIVE] Stopped by driver");
  syncVehicleStateToFirebase();
  showReadyScreen();
}

void startRestLock() {
  restLock = true;
  restStartTime = millis();
  warningActive = false;

  digitalWrite(IGNITION_PIN, LOW);
  digitalWrite(RED_LED, HIGH);

  beep(2, 150);

  Serial.println("==========================================");
  Serial.println(" MANDATORY REST LOCK STARTED (15 SECONDS) ");
  Serial.println("==========================================");

  syncVehicleStateToFirebase();
  syncEventToFirebase("Mandatory Rest", currentDriver ? currentDriver->name : "DRIVER");
  showRestScreen();
}

void handleRestLock() {
  unsigned long elapsed = millis() - restStartTime;

  if (millis() - lastDisplayUpdate >= 200) {
    showRestScreen();
    lastDisplayUpdate = millis();
  }

  if (elapsed >= REST_LOCK_TIME) {
    restLock = false;

    if (currentDriver != nullptr) {
      currentDriver->remainingTime = DRIVE_LIMIT;
      currentDriver->driving = false;
      currentDriver->limitReached = false;
      currentDriver->lastStartTime = 0;
      currentDriver->lastReminderTime = 0;
    }

    digitalWrite(IGNITION_PIN, LOW);
    digitalWrite(RED_LED, LOW);

    beep(3, 100);
    Serial.println("[REST] Rest period complete. Driver can scan to resume.");
    syncVehicleStateToFirebase();
    showReadyScreen();
  }
}

void updateDrivingTime() {
  if (currentDriver == nullptr || !currentDriver->driving) return;

  unsigned long elapsed = millis() - currentDriver->lastStartTime;
  unsigned long remaining = 0;

  if (elapsed < currentDriver->remainingTime) {
    remaining = currentDriver->remainingTime - elapsed;
  } else {
    remaining = 0;
  }

  // 10 Second Pre-Limit Warning
  if (remaining <= PRE_LIMIT_WARNING && remaining > 0 && !warningActive) {
    warningActive = true;
    warningStartTime = millis();
    lastWarningBeep = millis();

    Serial.println("[WARNING] 10s Pre-Limit Warning — Take Rest");
    beep(2, 120);
    showWarningScreen();
  }

  // Periodic Reminder (Every 15s)
  if (millis() - currentDriver->lastReminderTime >= REMINDER_INTERVAL) {
    currentDriver->lastReminderTime = millis();
    beep(1, 150);
    Serial.println("[REMINDER] Periodic driving break reminder");
  }

  // Driving Limit Reached (60s)
  if (remaining == 0) {
    currentDriver->remainingTime = 0;
    currentDriver->driving = false;
    currentDriver->limitReached = true;
    warningActive = false;

    // Throttle to 30 KM/H safety mode
    digitalWrite(IGNITION_PIN, HIGH);
    digitalWrite(RED_LED, HIGH);

    beep(3, 150);

    Serial.println("==========================================");
    Serial.println(" DRIVING LIMIT REACHED (60s)              ");
    Serial.println(" SPEED THROTTLED TO 30 KM/H               ");
    Serial.println(" SCAN RFID TO INITIATE MANDATORY REST     ");
    Serial.println("==========================================");

    syncVehicleStateToFirebase();
    syncEventToFirebase("Limit Reached", currentDriver->name);
    showLimitScreen();
  }
}

// =====================================================
// RFID PROCESSING
// =====================================================
void checkRFID() {
  if (millis() - lastRFIDTime < RFID_COOLDOWN) return;
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  lastRFIDTime = millis();

  bool driver1Found = compareUID(rfid.uid.uidByte, DRIVER1_UID);
  bool driver2Found = compareUID(rfid.uid.uidByte, DRIVER2_UID);

  if (driver1Found) {
    Serial.println("RFID:B33D0204:DRIVER 1");
    Serial.println("[RFID] Authorized Driver 1 Detected (B3:3D:02:04)");
    // Notify Firebase to trigger the web face-verification modal automatically
    syncRFIDToFirebase(driver1.name, driver1.rfidHex);
    handleDriverRFID(&driver1);
  } else if (driver2Found) {
    Serial.println("RFID:CD3EC801:DRIVER 2");
    Serial.println("[RFID] Authorized Driver 2 Detected (CD:3E:C8:01)");
    syncRFIDToFirebase(driver2.name, driver2.rfidHex);
    handleDriverRFID(&driver2);
  } else {
    Serial.println("[RFID] Unauthorized Card. Access Denied.");

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(2);
    display.setCursor(18, 16);
    display.println("INVALID");
    display.setCursor(24, 38);
    display.println("DRIVER");
    display.setTextSize(1);
    display.setCursor(20, 56);
    display.println("ACCESS DENIED");
    display.display();

    digitalWrite(RED_LED, HIGH);
    beep(3, 100);
    delay(1200);
    digitalWrite(RED_LED, LOW);

    syncEventToFirebase("Unauthorized RFID", "UNKNOWN");
    showReadyScreen();
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

void handleDriverRFID(DriverData* driver) {
  if (restLock) {
    Serial.println("[REST] Scan ignored: Mandatory rest lock is currently active.");
    beep(2, 150);
    return;
  }

  // If currently driving driver scans again → STOP
  if (currentDriver == driver && driver->driving) {
    stopDriving();
    return;
  }

  // If driver stopped after reaching driving limit → START REST LOCK
  if (driver->limitReached) {
    Serial.println("[REST] Driver scanned after limit reached. Locking vehicle for rest.");
    startRestLock();
    return;
  }

  // Normal Start Driving: require Face Biometric Verification first
  pendingDriver = driver;
  waitingForFaceVerify = true;
  faceVerifyStartTime = millis();

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(20, 2);
  display.println("DRIVE SENTINEL");
  display.drawLine(0, 13, 127, 13, SSD1306_WHITE);
  display.setCursor(6, 18);
  display.print("RFID: ");
  display.println(driver->name);
  display.setTextSize(1);
  display.setCursor(6, 34);
  display.println(">> VERIFY FACE <<");
  display.setCursor(6, 48);
  display.println("ON WEB DASHBOARD");
  display.display();

  beep(2, 80);
}

// =====================================================
// SOS EMERGENCY LOGIC
// =====================================================
void handleSOS() {
  bool currentSOSState = (digitalRead(SOS_PIN) == HIGH);

  if (currentSOSState && !previousSOSState) {
    sosTouching = true;
    sosStartTime = millis();
    if (sosActive) {
      cancelSOS();
    }
    Serial.println("[SOS] Button pressed");
  }

  if (currentSOSState && sosTouching && !sosActive) {
    if (millis() - sosStartTime >= SOS_HOLD_TIME) {
      activateSOS();
      sosTouching = false;
    }
  }

  if (!currentSOSState && previousSOSState) {
    sosTouching = false;
  }

  previousSOSState = currentSOSState;

  if (sosActive && millis() - lastSOSBeep >= 2000) {
    lastSOSBeep = millis();
    beep(1, 200);
  }
}

void activateSOS() {
  sosActive = true;
  sosTouching = false;

  digitalWrite(RED_LED, HIGH);
  digitalWrite(IGNITION_PIN, HIGH); // Maintain emergency maneuver speed

  lastSOSBeep = millis();
  beep(4, 100);

  Serial.println("==========================================");
  Serial.println(" SOS ACTIVE — EMERGENCY VEHICLE PROTOCOL  ");
  Serial.println(" SPEED THROTTLED TO 30 KM/H               ");
  Serial.println("==========================================");

  syncVehicleStateToFirebase();
  syncEventToFirebase("SOS Emergency", currentDriver ? currentDriver->name : "DRIVER");
  showSOSScreen();
}

void cancelSOS() {
  sosActive = false;
  sosTouching = false;
  digitalWrite(RED_LED, LOW);

  if (restLock) {
    digitalWrite(IGNITION_PIN, LOW);
    digitalWrite(RED_LED, HIGH);
    showRestScreen();
  } else if (currentDriver != nullptr && currentDriver->limitReached) {
    digitalWrite(IGNITION_PIN, HIGH);
    digitalWrite(RED_LED, HIGH);
    showLimitScreen();
  } else if (currentDriver != nullptr && currentDriver->driving) {
    digitalWrite(IGNITION_PIN, HIGH);
    digitalWrite(RED_LED, LOW);
    showDrivingScreen();
  } else {
    digitalWrite(IGNITION_PIN, LOW);
    showReadyScreen();
  }

  beep(2, 100);
  Serial.println("[SOS] SOS emergency mode cancelled");
  syncVehicleStateToFirebase();
}

// =====================================================
// UTILITIES
// =====================================================
bool compareUID(byte* uid, byte* knownUID) {
  for (byte i = 0; i < 4; i++) {
    if (uid[i] != knownUID[i]) return false;
  }
  return true;
}

void beep(int times, int duration) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(duration);
    digitalWrite(BUZZER_PIN, LOW);
    delay(80);
  }
}
