/*
 * =====================================================
 * VIKASIT NAGPUR — ESP32 SMART CITY FIRMWARE
 * WiFi + HTTP Integration with Backend Server
 * =====================================================
 *
 * This firmware connects ALL onboard sensors (RFID RC522,
 * MPU6050, IR, Ultrasonic, LDR) to the Vikasit Nagpur
 * backend via WiFi HTTP POST every 3 seconds.
 *
 * Sensor data flows:
 *   ESP32 → WiFi → POST /api/hardware/sync → Backend DB → Frontend Dashboard
 *
 * RFID UID Mapping (Hardware → Software):
 *   B3:3D:02:04 → RFID-NGP-7701 (Ramesh Patil, Roads/PWD)
 *   CD:3E:C8:01 → RFID-NGP-8802 (Sunil Deshmukh, Electrical)
 */

#include <Wire.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <WiFi.h>
#include <HTTPClient.h>

// =====================================================
// WIFI CONFIGURATION
// =====================================================

const char* WIFI_SSID     = "0110";
const char* WIFI_PASSWORD  = "devyanshu";

// =====================================================
// SERVER CONFIGURATION
// =====================================================
// IMPORTANT: Change this to YOUR computer's IP on the
// "0110" WiFi network. Run 'ipconfig' to find it.
// Example: "192.168.1.100"

const char* SERVER_IP   = "172.24.3.19";  // Current machine IP (update if your 0110 network assigns a different IP)
const int   SERVER_PORT = 8000;

// Full endpoint URL (constructed at runtime)
String serverUrl;

// =====================================================
// DEVICE IDENTITY
// =====================================================

const char* DEVICE_ID = "ESP32-NAGPUR-001";

// =====================================================
// PIN DEFINITIONS
// =====================================================

// LDR
#define LDR_MODULE_PIN 32     // Day/Night LDR module
#define LDR_FEEDBACK_PIN 33   // Bare LDR - LED feedback

// Streetlight
#define STREETLIGHT_PIN 26

// Status LED
#define STATUS_LED_PIN 4

// Buzzer
#define BUZZER_PIN 13

// IR sensor
#define IR_PIN 35

// Ultrasonic
#define TRIG_PIN 25
#define ECHO_PIN 34

// RFID RC522
#define RFID_SS_PIN 5
#define RFID_RST_PIN 27
#define RFID_SCK_PIN 18
#define RFID_MOSI_PIN 23
#define RFID_MISO_PIN 19

// I2C
#define SDA_PIN 21
#define SCL_PIN 22

// =====================================================
// OLED
// =====================================================

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
  &Wire,
  -1
);

// =====================================================
// MPU6050
// =====================================================

Adafruit_MPU6050 mpu;

// =====================================================
// RFID
// =====================================================

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);

// =====================================================
// RFID CARD UID
// =====================================================

byte worker1UID[] = {0xB3, 0x3D, 0x02, 0x04};
byte worker2UID[] = {0xCD, 0x3E, 0xC8, 0x01};

// =====================================================
// WORKER DATA
// =====================================================

bool worker1Inside = false;
bool worker2Inside = false;

unsigned long worker1StartTime = 0;
unsigned long worker2StartTime = 0;

// =====================================================
// STREETLIGHT
// =====================================================

bool streetLightState = false;
bool streetLightFault = false;

// Adjust this value according to your bare LDR circuit
int LDR_FAULT_THRESHOLD = 500;

// Current streetlight sensor state for server sync
bool currentIsNight = false;
int currentLdrFeedback = 0;

// =====================================================
// DUSTBIN
// =====================================================

const float BIN_FULL_DISTANCE = 5.0;

// Current dustbin state for server sync
float currentDustbinDistance = -1;
bool currentDustbinFull = false;

// =====================================================
// POTHOLE DETECTION DATA
// =====================================================

unsigned int totalPotholeCount  = 0;
unsigned int majorPotholeCount  = 0;
unsigned int normalPotholeCount = 0;

float baselineAccel = 9.81;
const float POTHOLE_DELTA_THRESHOLD = 8.0;
const unsigned long POTHOLE_COOLDOWN = 1500;
unsigned long potholeCooldownUntil = 0;

// Last detection type for server sync ("NONE", "MAJOR", "NORMAL")
String lastPotholeDetection = "NONE";
float lastAcceleration = 0.0;
float lastDeviation = 0.0;

// =====================================================
// RFID EVENT QUEUE (for server sync)
// =====================================================

bool rfidEventPending = false;
String rfidEventUID = "";
String rfidEventWorkerName = "";
String rfidEventAction = "";
String rfidEventDuration = "";

// =====================================================
// WIFI STATUS
// =====================================================

bool wifiConnected = false;
int serverSyncCount = 0;
int serverSyncFails = 0;

// =====================================================
// TIMERS
// =====================================================

unsigned long lastLDRCheck = 0;
unsigned long lastDustbinCheck = 0;
unsigned long lastPotholeCheck = 0;
unsigned long lastServerSync = 0;
unsigned long lastWiFiCheck = 0;

const unsigned long LDR_INTERVAL = 500;
const unsigned long DUSTBIN_INTERVAL = 1000;
const unsigned long POTHOLE_INTERVAL = 50;
const unsigned long SERVER_SYNC_INTERVAL = 3000;   // Sync every 3 seconds
const unsigned long WIFI_CHECK_INTERVAL = 10000;    // Check WiFi every 10 seconds

// =====================================================
// FUNCTION DECLARATIONS
// =====================================================

void showMessage(String line1, String line2 = "", String line3 = "");
void beep(int times, int duration = 120);
void checkStreetLight();
void checkDustbin();
void checkPothole();
void checkRFID();
void calibrateMPU();
void connectWiFi();
void syncToServer();

bool compareUID(byte *uid, byte *knownUID, byte length);
String getWorkingTime(unsigned long milliseconds);
float readDistanceInches();
String uidToString(byte *uid, byte size);

// =====================================================
// SETUP
// =====================================================

void setup() {

  Serial.begin(115200);

  // -------------------------------
  // GPIO
  // -------------------------------

  pinMode(LDR_MODULE_PIN, INPUT);
  pinMode(LDR_FEEDBACK_PIN, INPUT);

  pinMode(STREETLIGHT_PIN, OUTPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);

  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(IR_PIN, INPUT);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  digitalWrite(STREETLIGHT_PIN, LOW);
  digitalWrite(STATUS_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  // -------------------------------
  // I2C
  // -------------------------------

  Wire.begin(SDA_PIN, SCL_PIN);

  // -------------------------------
  // OLED
  // -------------------------------

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {

    Serial.println("OLED not found!");

    while (true) {
      delay(1000);
    }
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  showMessage(
    "VIKASIT NAGPUR",
    "SMART CITY v2.0",
    "Starting..."
  );

  delay(2000);

  // -------------------------------
  // WiFi
  // -------------------------------

  connectWiFi();

  // Build server URL
  serverUrl = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/hardware/sync";
  Serial.println("Server URL: " + serverUrl);

  // -------------------------------
  // MPU6050
  // -------------------------------

  if (!mpu.begin()) {

    Serial.println("MPU6050 not found!");

    showMessage(
      "MPU6050 ERROR",
      "Check wiring"
    );

    delay(2000);

  } else {

    Serial.println("MPU6050 OK");

    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_94_HZ);

    calibrateMPU();
  }

  // -------------------------------
  // RFID
  // -------------------------------

  SPI.begin(
    RFID_SCK_PIN,
    RFID_MISO_PIN,
    RFID_MOSI_PIN,
    RFID_SS_PIN
  );

  rfid.PCD_Init();

  Serial.println("RFID Ready");

  showMessage(
    "VIKASIT NAGPUR",
    "ALL SENSORS READY",
    wifiConnected ? "WiFi: CONNECTED" : "WiFi: OFFLINE"
  );

  beep(1);

  delay(2000);
}

// =====================================================
// WIFI CONNECTION
// =====================================================

void connectWiFi() {

  Serial.print("Connecting to WiFi: ");
  Serial.println(WIFI_SSID);

  showMessage(
    "CONNECTING WiFi",
    String(WIFI_SSID),
    "Please wait..."
  );

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;

  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    wifiConnected = true;

    Serial.println("WiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());

    showMessage(
      "WiFi CONNECTED",
      WiFi.localIP().toString(),
      "Server: " + String(SERVER_IP)
    );

    // Flash status LED to indicate connected
    for (int i = 0; i < 3; i++) {
      digitalWrite(STATUS_LED_PIN, HIGH);
      delay(150);
      digitalWrite(STATUS_LED_PIN, LOW);
      delay(150);
    }

  } else {

    wifiConnected = false;

    Serial.println("WiFi FAILED - running in offline mode");

    showMessage(
      "WiFi FAILED",
      "Running OFFLINE",
      "Sensors active"
    );
  }

  delay(1500);
}

// =====================================================
// LOOP
// =====================================================

void loop() {

  unsigned long currentMillis = millis();

  // -------------------------------
  // Streetlight
  // -------------------------------

  if (currentMillis - lastLDRCheck >= LDR_INTERVAL) {

    lastLDRCheck = currentMillis;

    checkStreetLight();
  }

  // -------------------------------
  // Dustbin
  // -------------------------------

  if (currentMillis - lastDustbinCheck >= DUSTBIN_INTERVAL) {

    lastDustbinCheck = currentMillis;

    checkDustbin();
  }

  // -------------------------------
  // Pothole
  // -------------------------------

  if (currentMillis - lastPotholeCheck >= POTHOLE_INTERVAL) {

    lastPotholeCheck = currentMillis;

    checkPothole();
  }

  // -------------------------------
  // RFID
  // -------------------------------

  checkRFID();

  // -------------------------------
  // Server Sync (every 3 seconds)
  // -------------------------------

  if (currentMillis - lastServerSync >= SERVER_SYNC_INTERVAL) {

    lastServerSync = currentMillis;

    syncToServer();
  }

  // -------------------------------
  // WiFi Reconnect Check
  // -------------------------------

  if (currentMillis - lastWiFiCheck >= WIFI_CHECK_INTERVAL) {

    lastWiFiCheck = currentMillis;

    if (WiFi.status() != WL_CONNECTED) {
      wifiConnected = false;
      Serial.println("WiFi disconnected - attempting reconnect...");
      WiFi.reconnect();

      delay(2000);

      if (WiFi.status() == WL_CONNECTED) {
        wifiConnected = true;
        Serial.println("WiFi reconnected!");
      }
    } else {
      wifiConnected = true;
    }
  }

  delay(10);
}

// =====================================================
// SERVER SYNC — POST JSON to Backend
// =====================================================

void syncToServer() {

  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {

    Serial.println("[Sync] Skipped - WiFi offline");
    return;
  }

  HTTPClient http;

  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);  // 5 second timeout

  // Build JSON payload
  String json = "{";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\",";

  // Streetlight
  json += "\"streetlight\":{";
  json += "\"is_night\":" + String(currentIsNight ? "true" : "false") + ",";
  json += "\"light_on\":" + String(streetLightState ? "true" : "false") + ",";
  json += "\"fault_detected\":" + String(streetLightFault ? "true" : "false") + ",";
  json += "\"ldr_feedback\":" + String(currentLdrFeedback);
  json += "},";

  // Dustbin
  json += "\"dustbin\":{";
  json += "\"distance_inches\":" + String(currentDustbinDistance, 2) + ",";
  json += "\"is_full\":" + String(currentDustbinFull ? "true" : "false");
  json += "},";

  // Pothole
  json += "\"pothole\":{";
  json += "\"total_count\":" + String(totalPotholeCount) + ",";
  json += "\"major_count\":" + String(majorPotholeCount) + ",";
  json += "\"normal_count\":" + String(normalPotholeCount) + ",";
  json += "\"last_detection\":\"" + lastPotholeDetection + "\",";
  json += "\"acceleration\":" + String(lastAcceleration, 2) + ",";
  json += "\"deviation\":" + String(lastDeviation, 2);
  json += "},";

  // RFID
  json += "\"rfid\":{";
  json += "\"card_detected\":" + String(rfidEventPending ? "true" : "false");
  if (rfidEventPending) {
    json += ",\"uid\":\"" + rfidEventUID + "\"";
    json += ",\"worker_name\":\"" + rfidEventWorkerName + "\"";
    json += ",\"action\":\"" + rfidEventAction + "\"";
    if (rfidEventDuration.length() > 0) {
      json += ",\"work_duration\":\"" + rfidEventDuration + "\"";
    }
  }
  json += "},";

  // Uptime
  json += "\"uptime_seconds\":" + String(millis() / 1000);
  json += "}";

  Serial.println("[Sync] POST -> " + serverUrl);
  Serial.println("[Sync] Payload: " + json);

  int httpCode = http.POST(json);

  if (httpCode > 0) {

    String response = http.getString();

    Serial.print("[Sync] Response: ");
    Serial.print(httpCode);
    Serial.print(" - ");
    Serial.println(response);

    serverSyncCount++;

    // Clear RFID event after successful sync
    if (rfidEventPending) {
      rfidEventPending = false;
      rfidEventUID = "";
      rfidEventWorkerName = "";
      rfidEventAction = "";
      rfidEventDuration = "";
    }

    // Clear pothole last_detection after sync
    lastPotholeDetection = "NONE";

    // Brief green LED flash for successful sync
    digitalWrite(STATUS_LED_PIN, HIGH);
    delay(50);
    digitalWrite(STATUS_LED_PIN, LOW);

  } else {

    Serial.print("[Sync] FAILED: ");
    Serial.println(http.errorToString(httpCode));

    serverSyncFails++;
  }

  http.end();
}

// =====================================================
// UID TO STRING (format: "B3:3D:02:04")
// =====================================================

String uidToString(byte *uid, byte size) {

  String result = "";

  for (byte i = 0; i < size; i++) {

    if (uid[i] < 0x10) {
      result += "0";
    }

    result += String(uid[i], HEX);

    if (i < size - 1) {
      result += ":";
    }
  }

  result.toUpperCase();

  return result;
}

// =====================================================
// STREETLIGHT FUNCTION
// =====================================================

void checkStreetLight() {

  int dayNightValue = digitalRead(LDR_MODULE_PIN);

  /*
     IMPORTANT - LOGIC CONFIRMED FOR THIS MODULE:

     This module's onboard indicator LED lights up during
     the DAY and turns off at NIGHT, which means its DO pin
     is the opposite of the common default. So here:

     HIGH = DAY
     LOW  = NIGHT
  */

  bool isNight = (dayNightValue == HIGH);

  currentIsNight = isNight;

  if (isNight) {

    // Turn streetlight ON
    digitalWrite(STREETLIGHT_PIN, HIGH);
    streetLightState = true;

    // Read bare LDR
    int feedbackValue = analogRead(LDR_FEEDBACK_PIN);
    currentLdrFeedback = feedbackValue;

    Serial.print("Night | Streetlight ON | LDR Feedback: ");
    Serial.println(feedbackValue);

    if (feedbackValue < LDR_FAULT_THRESHOLD) {

      if (!streetLightFault) {

        streetLightFault = true;

        digitalWrite(STATUS_LED_PIN, HIGH);

        showMessage(
          "STREETLIGHT",
          "FAULT DETECTED",
          "LED NOT WORKING"
        );

        beep(2, 180);

        delay(1000);
      }

    } else {

      streetLightFault = false;

      digitalWrite(STATUS_LED_PIN, LOW);
    }

  } else {

    // Daytime
    digitalWrite(STREETLIGHT_PIN, LOW);

    streetLightState = false;
    streetLightFault = false;
    currentLdrFeedback = analogRead(LDR_FEEDBACK_PIN);

    digitalWrite(STATUS_LED_PIN, LOW);

    Serial.println("Day | Streetlight OFF");
  }
}

// =====================================================
// DUSTBIN FUNCTION
// =====================================================

void checkDustbin() {

  float distance = readDistanceInches();

  currentDustbinDistance = distance;

  Serial.print("Dustbin Distance: ");
  Serial.print(distance);
  Serial.println(" inches");

  if (distance > 0 && distance <= BIN_FULL_DISTANCE) {

    currentDustbinFull = true;

    Serial.println("DUSTBIN FULL");

    showMessage(
      "DUSTBIN STATUS",
      "BIN IS FULL!",
      "Please Empty"
    );

    beep(3, 150);

    delay(500);

  } else {

    currentDustbinFull = false;
  }
}

// =====================================================
// ULTRASONIC DISTANCE
// =====================================================

float readDistanceInches() {

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG_PIN, LOW);

  long duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) {
    return -1;
  }

  float distance = duration * 0.0135039 / 2.0;

  return distance;
}

// =====================================================
// MPU6050 CALIBRATION
// =====================================================

void calibrateMPU() {

  Serial.println("Calibrating MPU6050 baseline...");

  showMessage(
    "MPU6050",
    "CALIBRATING...",
    "Keep vehicle still"
  );

  const int samples = 50;
  float sum = 0;

  for (int i = 0; i < samples; i++) {

    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);

    float mag = sqrt(
      a.acceleration.x * a.acceleration.x +
      a.acceleration.y * a.acceleration.y +
      a.acceleration.z * a.acceleration.z
    );

    sum += mag;

    delay(20);
  }

  baselineAccel = sum / samples;

  Serial.print("Baseline gravity magnitude: ");
  Serial.println(baselineAccel);
}

// =====================================================
// POTHOLE DETECTION
// =====================================================

void checkPothole() {

  unsigned long now = millis();

  if (now < potholeCooldownUntil) {
    return;
  }

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  float acceleration = sqrt(
    a.acceleration.x * a.acceleration.x +
    a.acceleration.y * a.acceleration.y +
    a.acceleration.z * a.acceleration.z
  );

  float deviation = fabs(acceleration - baselineAccel);

  bool mpuPothole = (deviation > POTHOLE_DELTA_THRESHOLD);

  int irValue = digitalRead(IR_PIN);
  bool irPothole = (irValue == LOW);

  // Update for server sync
  lastAcceleration = acceleration;
  lastDeviation = deviation;

  if (mpuPothole) {

    majorPotholeCount++;
    totalPotholeCount++;
    potholeCooldownUntil = now + POTHOLE_COOLDOWN;
    lastPotholeDetection = "MAJOR";

    Serial.println("================================");
    Serial.println("MAJOR POTHOLE DETECTED (MPU6050)");
    Serial.println("================================");

    showMessage(
      "MAJOR POTHOLE!",
      "Total:" + String(totalPotholeCount) + " Major:" + String(majorPotholeCount),
      "Detected: MPU6050"
    );

    beep(2, 250);

  } else if (irPothole) {

    normalPotholeCount++;
    totalPotholeCount++;
    potholeCooldownUntil = now + POTHOLE_COOLDOWN;
    lastPotholeDetection = "NORMAL";

    Serial.println("--------------------------------");
    Serial.println("Pothole detected (IR)");
    Serial.println("--------------------------------");

    showMessage(
      "POTHOLE DETECTED",
      "Total:" + String(totalPotholeCount) + " Normal:" + String(normalPotholeCount),
      "Detected: IR Sensor"
    );

    beep(1, 250);
  }
}

// =====================================================
// RFID FUNCTION
// =====================================================

void checkRFID() {

  if (!rfid.PICC_IsNewCardPresent()) {
    return;
  }

  if (!rfid.PICC_ReadCardSerial()) {
    return;
  }

  Serial.println();
  Serial.println("RFID CARD DETECTED");

  // Print UID
  String uidStr = uidToString(rfid.uid.uidByte, rfid.uid.size);

  Serial.print("UID: ");
  Serial.println(uidStr);

  // ---------------------------------------------------
  // Worker 1
  // ---------------------------------------------------

  if (
    rfid.uid.size == 4 &&
    compareUID(
      rfid.uid.uidByte,
      worker1UID,
      4
    )
  ) {

    beep(1);

    if (!worker1Inside) {

      worker1Inside = true;
      worker1StartTime = millis();

      Serial.println("WORKER 1 - IN");

      showMessage(
        "WORKER 1",
        "ACCESS GRANTED",
        "IN TIME RECORDED"
      );

      // Queue RFID event for server sync
      rfidEventPending = true;
      rfidEventUID = uidStr;
      rfidEventWorkerName = "WORKER 1";
      rfidEventAction = "IN";
      rfidEventDuration = "";

    } else {

      worker1Inside = false;

      unsigned long workTime =
        millis() - worker1StartTime;

      String duration =
        getWorkingTime(workTime);

      Serial.println("WORKER 1 - OUT");

      showMessage(
        "WORKER 1",
        "OUT RECORDED",
        duration
      );

      // Queue RFID event for server sync
      rfidEventPending = true;
      rfidEventUID = uidStr;
      rfidEventWorkerName = "WORKER 1";
      rfidEventAction = "OUT";
      rfidEventDuration = duration;
    }

    delay(2000);
  }

  // ---------------------------------------------------
  // Worker 2
  // ---------------------------------------------------

  else if (
    rfid.uid.size == 4 &&
    compareUID(
      rfid.uid.uidByte,
      worker2UID,
      4
    )
  ) {

    beep(1);

    if (!worker2Inside) {

      worker2Inside = true;
      worker2StartTime = millis();

      Serial.println("WORKER 2 - IN");

      showMessage(
        "WORKER 2",
        "ACCESS GRANTED",
        "IN TIME RECORDED"
      );

      rfidEventPending = true;
      rfidEventUID = uidStr;
      rfidEventWorkerName = "WORKER 2";
      rfidEventAction = "IN";
      rfidEventDuration = "";

    } else {

      worker2Inside = false;

      unsigned long workTime =
        millis() - worker2StartTime;

      String duration =
        getWorkingTime(workTime);

      Serial.println("WORKER 2 - OUT");

      showMessage(
        "WORKER 2",
        "OUT RECORDED",
        duration
      );

      rfidEventPending = true;
      rfidEventUID = uidStr;
      rfidEventWorkerName = "WORKER 2";
      rfidEventAction = "OUT";
      rfidEventDuration = duration;
    }

    delay(2000);
  }

  // ---------------------------------------------------
  // INVALID CARD
  // ---------------------------------------------------

  else {

    Serial.println("INVALID WORKER");

    showMessage(
      "ACCESS DENIED",
      "INVALID WORKER",
      "RFID NOT AUTHORIZED"
    );

    rfidEventPending = true;
    rfidEventUID = uidStr;
    rfidEventWorkerName = "UNKNOWN";
    rfidEventAction = "DENIED";
    rfidEventDuration = "";

    beep(2, 300);

    delay(2000);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
}

// =====================================================
// UID COMPARISON
// =====================================================

bool compareUID(
  byte *uid,
  byte *knownUID,
  byte length
) {

  for (byte i = 0; i < length; i++) {

    if (uid[i] != knownUID[i]) {
      return false;
    }
  }

  return true;
}

// =====================================================
// WORKING TIME
// =====================================================

String getWorkingTime(unsigned long milliseconds) {

  unsigned long totalSeconds =
    milliseconds / 1000;

  unsigned long hours =
    totalSeconds / 3600;

  unsigned long minutes =
    (totalSeconds % 3600) / 60;

  unsigned long seconds =
    totalSeconds % 60;

  String result = "";

  if (hours < 10) {
    result += "0";
  }

  result += String(hours);
  result += ":";

  if (minutes < 10) {
    result += "0";
  }

  result += String(minutes);
  result += ":";

  if (seconds < 10) {
    result += "0";
  }

  result += String(seconds);

  return result;
}

// =====================================================
// BUZZER
// =====================================================

void beep(
  int times,
  int duration
) {

  for (int i = 0; i < times; i++) {

    digitalWrite(BUZZER_PIN, HIGH);

    delay(duration);

    digitalWrite(BUZZER_PIN, LOW);

    delay(100);
  }
}

// =====================================================
// OLED MESSAGE
// =====================================================

void showMessage(
  String line1,
  String line2,
  String line3
) {

  display.clearDisplay();

  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 5);
  display.println(line1);

  display.setCursor(0, 25);
  display.println(line2);

  display.setCursor(0, 45);
  display.println(line3);

  display.display();
}
