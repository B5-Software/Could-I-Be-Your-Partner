/*
 * CIBYP-IoT-TRNG - True Random Number Generator for "Could I Be Your Partner"
 * ESP32 Universal Firmware (supports ESP32-S3, ESP32-C3, ESP32-C6)
 * 
 * Features:
 *   - Hardware TRNG using ESP32's built-in RNG peripheral
 *   - WiFi AP mode with configurable SSID/password
 *   - Beautiful WebUI with tarot card spreads
 *   - REST API for drawing cards
 *   - Serial protocol for drawing cards
 *   - OTA firmware update via file upload
 *
 * Default AP: SSID=CIBYP-IoT-TRNG, Password=(empty)
 */

struct DrawResult;

#include <WiFi.h>
#include <WebServer.h>
#include <Update.h>
#include <Preferences.h>
#include <esp_random.h>

// ---- Tarot card data (78 cards) ----
struct TarotCard {
  uint8_t id;
  const char* name;
  const char* nameEn;
  const char* arcana; // "major" or "minor"
  const char* meaningOfUpright;
  const char* meaningOfReversed;
};

#include "tarot_data.h"

// ---- Configuration ----
Preferences prefs;
String apSSID = "CIBYP-IoT-TRNG";
String apPassword = "";

WebServer server(80);

// ---- TRNG Core ----
uint32_t trngRead32() {
  return esp_random(); // Hardware RNG on all ESP32 variants
}

uint8_t trngReadByte() {
  return (uint8_t)(esp_random() & 0xFF);
}

// Unbiased random in range [0, range) using rejection sampling
uint32_t trngUnbiased(uint32_t range) {
  if (range <= 1) return 0;
  uint32_t maxVal = (0xFFFFFFFF / range) * range;
  uint32_t val;
  do {
    val = trngRead32();
  } while (val >= maxVal);
  return val % range;
}

// ---- Draw a single card ----
struct DrawResult {
  uint8_t cardIndex;
  bool isReversed;
};

DrawResult drawSingleCard() {
  DrawResult r;
  r.cardIndex = (uint8_t)trngUnbiased(78);
  r.isReversed = trngReadByte() < 128;
  return r;
}

// Draw multiple unique cards
void drawMultipleCards(DrawResult* results, int count) {
  if (count > 78) count = 78;
  bool used[78] = {false};
  for (int i = 0; i < count; i++) {
    uint8_t idx;
    do {
      idx = (uint8_t)trngUnbiased(78);
    } while (used[idx]);
    used[idx] = true;
    results[i].cardIndex = idx;
    results[i].isReversed = trngReadByte() < 128;
  }
}

// ---- JSON Helpers ----
String cardToJSON(const DrawResult& r) {
  const TarotCard& c = tarotCards[r.cardIndex];
  String json = "{";
  json += "\"cardIndex\":" + String(r.cardIndex) + ",";
  json += "\"name\":\"" + String(c.name) + "\",";
  json += "\"nameEn\":\"" + String(c.nameEn) + "\",";
  json += "\"arcana\":\"" + String(c.arcana) + "\",";
  json += "\"isReversed\":" + String(r.isReversed ? "true" : "false") + ",";
  json += "\"orientation\":\"" + String(r.isReversed ? "reversed" : "upright") + "\",";
  json += "\"meaningOfUpright\":\"" + String(c.meaningOfUpright) + "\",";
  json += "\"meaningOfReversed\":\"" + String(c.meaningOfReversed) + "\"";
  json += "}";
  return json;
}

String drawResultsToJSON(DrawResult* results, int count, const char* spreadName) {
  String json = "{\"spread\":\"" + String(spreadName) + "\",\"cards\":[";
  for (int i = 0; i < count; i++) {
    if (i > 0) json += ",";
    json += cardToJSON(results[i]);
  }
  json += "],\"entropySource\":\"TRNG\",\"device\":\"ESP32\"}";
  return json;
}

// ---- Web UI HTML ----
#include "web_ui.h"

// ---- API Endpoints ----
void handleRoot() {
  server.send(200, "text/html", getWebUIHTML());
}

void handleAPIDraw() {
  DrawResult r = drawSingleCard();
  server.send(200, "application/json", cardToJSON(r));
}

void handleAPISpread() {
  String spreadType = server.hasArg("type") ? server.arg("type") : "single";
  int count = 1;
  const char* spreadName = "single";
  
  if (spreadType == "three") { count = 3; spreadName = "三张牌阵"; }
  else if (spreadType == "celtic") { count = 10; spreadName = "凯尔特十字"; }
  else if (spreadType == "horseshoe") { count = 7; spreadName = "马蹄牌阵"; }
  else if (spreadType == "star") { count = 5; spreadName = "五芒星牌阵"; }
  else if (spreadType == "hexagram") { count = 7; spreadName = "六芒星牌阵"; }
  else if (spreadType == "zodiac") { count = 12; spreadName = "黄道十二宫"; }
  else if (spreadType == "yes_no") { count = 1; spreadName = "是非牌"; }
  else if (spreadType == "relationship") { count = 5; spreadName = "关系牌阵"; }
  else { count = 1; spreadName = "单牌"; }

  DrawResult results[12];
  drawMultipleCards(results, count);
  server.send(200, "application/json", drawResultsToJSON(results, count, spreadName));
}

void handleAPIRandom() {
  // Return raw TRNG bytes as JSON
  uint32_t val = trngRead32();
  String json = "{\"value\":" + String(val) + ",\"hex\":\"0x" + String(val, HEX) + "\",\"entropySource\":\"TRNG\"}";
  server.send(200, "application/json", json);
}

void handleAPIConfig() {
  if (server.method() == HTTP_POST) {
    String newSSID = server.hasArg("ssid") ? server.arg("ssid") : "";
    String newPass = server.hasArg("password") ? server.arg("password") : "";
    if (newSSID.length() > 0) {
      apSSID = newSSID;
      apPassword = newPass;
      prefs.begin("cibyp", false);
      prefs.putString("ssid", apSSID);
      prefs.putString("pass", apPassword);
      prefs.end();
      server.send(200, "application/json", "{\"ok\":true,\"message\":\"AP config saved. Restarting...\"}");
      delay(1000);
      ESP.restart();
    } else {
      server.send(400, "application/json", "{\"ok\":false,\"error\":\"SSID cannot be empty\"}");
    }
  } else {
    String json = "{\"ssid\":\"" + apSSID + "\",\"hasPassword\":" + String(apPassword.length() > 0 ? "true" : "false") + "}";
    server.send(200, "application/json", json);
  }
}

void handleOTAUpload() {
  HTTPUpload& upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    Serial.printf("OTA Update: %s\n", upload.filename.c_str());
    if (!Update.begin(UPDATE_SIZE_UNKNOWN)) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
      Update.printError(Serial);
    }
  } else if (upload.status == UPLOAD_FILE_END) {
    if (Update.end(true)) {
      Serial.printf("OTA Update Success: %u bytes\n", upload.totalSize);
    } else {
      Update.printError(Serial);
    }
  }
}

void handleOTAResult() {
  if (Update.hasError()) {
    server.send(500, "application/json", "{\"ok\":false,\"error\":\"OTA update failed\"}");
  } else {
    server.send(200, "application/json", "{\"ok\":true,\"message\":\"OTA update success. Restarting...\"}");
    delay(1000);
    ESP.restart();
  }
}

void handleAPIInfo() {
  String json = "{";
  json += "\"device\":\"ESP32\",";
  json += "\"firmware\":\"CIBYP-TRNG v1.0.0\",";
  json += "\"freeHeap\":" + String(ESP.getFreeHeap()) + ",";
  json += "\"chipModel\":\"" + String(ESP.getChipModel()) + "\",";
  json += "\"chipRevision\":" + String(ESP.getChipRevision()) + ",";
  json += "\"cpuFreqMHz\":" + String(ESP.getCpuFreqMHz()) + ",";
  json += "\"flashSize\":" + String(ESP.getFlashChipSize()) + ",";
  json += "\"ssid\":\"" + apSSID + "\",";
  json += "\"ip\":\"" + WiFi.softAPIP().toString() + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

// ---- Serial Protocol ----
void handleSerialCommand(String cmd) {
  cmd.trim();
  if (cmd == "DRAW") {
    DrawResult r = drawSingleCard();
    Serial.println(cardToJSON(r));
  } else if (cmd.startsWith("SPREAD:")) {
    String type = cmd.substring(7);
    type.trim();
    int count = 1;
    const char* name = "single";
    if (type == "three") { count = 3; name = "三张牌阵"; }
    else if (type == "celtic") { count = 10; name = "凯尔特十字"; }
    else if (type == "horseshoe") { count = 7; name = "马蹄牌阵"; }
    else if (type == "star") { count = 5; name = "五芒星牌阵"; }
    else if (type == "hexagram") { count = 7; name = "六芒星牌阵"; }
    else if (type == "zodiac") { count = 12; name = "黄道十二宫"; }
    DrawResult results[12];
    drawMultipleCards(results, count);
    Serial.println(drawResultsToJSON(results, count, name));
  } else if (cmd == "RANDOM") {
    uint32_t val = trngRead32();
    Serial.printf("{\"value\":%u,\"hex\":\"0x%08x\",\"entropySource\":\"TRNG\"}\n", val, val);
  } else if (cmd == "INFO") {
    Serial.printf("{\"device\":\"ESP32\",\"chip\":\"%s\",\"heap\":%u}\n", ESP.getChipModel(), ESP.getFreeHeap());
  } else if (cmd == "PING") {
    Serial.println("{\"pong\":true}");
  } else {
    Serial.println("{\"error\":\"Unknown command\"}");
  }
}

// ---- Setup & Loop ----
void setup() {
  Serial.begin(115200);
  Serial.println("\n=== CIBYP-IoT-TRNG v1.0.0 ===");

  // Load config
  prefs.begin("cibyp", true);
  apSSID = prefs.getString("ssid", "CIBYP-IoT-TRNG");
  apPassword = prefs.getString("pass", "");
  prefs.end();

  // Start AP
  WiFi.mode(WIFI_AP);
  if (apPassword.length() > 0) {
    WiFi.softAP(apSSID.c_str(), apPassword.c_str());
  } else {
    WiFi.softAP(apSSID.c_str());
  }
  Serial.print("AP SSID: "); Serial.println(apSSID);
  Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());

  // Setup web server
  server.on("/", handleRoot);
  server.on("/api/draw", handleAPIDraw);
  server.on("/api/spread", handleAPISpread);
  server.on("/api/random", handleAPIRandom);
  server.on("/api/config", handleAPIConfig);
  server.on("/api/info", handleAPIInfo);
  server.on("/api/ota", HTTP_POST, handleOTAResult, handleOTAUpload);

  server.begin();
  Serial.println("Web server started on port 80");
  Serial.println("Serial commands: DRAW, SPREAD:<type>, RANDOM, INFO, PING");
}

String serialBuffer = "";

void loop() {
  server.handleClient();
  
  // Handle serial input
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (serialBuffer.length() > 0) {
        handleSerialCommand(serialBuffer);
        serialBuffer = "";
      }
    } else {
      serialBuffer += c;
    }
  }

  delay(1);
}
