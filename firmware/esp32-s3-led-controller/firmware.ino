#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <FastLED.h>
#include <ArduinoJson.h>

// =========================
// Variables modificables
// =========================
const uint16_t TOTAL_LEDS = 300;
const uint8_t DATA_PIN = 5;
const uint8_t DATA_PIN_CH1 = 5;
const uint8_t DATA_PIN_CH2 = 6;
const uint8_t DATA_PIN_CH3 = 7;
const uint8_t DATA_PIN_CH4 = 8;
const uint8_t BRIGHTNESS = 120;
const char* WIFI_SSID = "TU_WIFI";
const char* WIFI_PASSWORD = "TU_PASSWORD";

// WS2812B 5V y WS2815 12V usan protocolo tipo WS2812B con orden GRB.
#define LED_CHIPSET WS2812B
#define LED_COLOR_ORDER GRB

CRGB ledsCh1[TOTAL_LEDS];
CRGB ledsCh2[TOTAL_LEDS];
CRGB ledsCh3[TOTAL_LEDS];
CRGB ledsCh4[TOTAL_LEDS];
WebServer server(80);

CRGB* channelLeds(uint8_t channel) {
  if (channel == 2) return ledsCh2;
  if (channel == 3) return ledsCh3;
  if (channel == 4) return ledsCh4;
  return ledsCh1;
}

void showAllChannels() {
  FastLED.show();
}

void clearAllChannels() {
  fill_solid(ledsCh1, TOTAL_LEDS, CRGB::Black);
  fill_solid(ledsCh2, TOTAL_LEDS, CRGB::Black);
  fill_solid(ledsCh3, TOTAL_LEDS, CRGB::Black);
  fill_solid(ledsCh4, TOTAL_LEDS, CRGB::Black);
  showAllChannels();
}

void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Max-Age", "86400");
}

void sendJson(int code, const String& body) {
  addCorsHeaders();
  server.send(code, "application/json", body);
}

void handleOptions() {
  addCorsHeaders();
  server.send(204);
}

void handleHealth() {
  String body = "{";
  body += "\"ok\":true,";
  body += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  body += "\"totalLeds\":" + String(TOTAL_LEDS);
  body += "}";
  sendJson(200, body);
}

void handleClear() {
  clearAllChannels();
  sendJson(200, "{\"ok\":true,\"cleared\":true}");
}

void handleLeds() {
  if (!server.hasArg("plain")) {
    sendJson(400, "{\"ok\":false,\"error\":\"Missing JSON body\"}");
    return;
  }

  StaticJsonDocument<8192> doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  if (error) {
    sendJson(400, "{\"ok\":false,\"error\":\"Invalid JSON\"}");
    return;
  }

  JsonArray segments = doc["segments"].as<JsonArray>();
  if (segments.isNull()) {
    sendJson(400, "{\"ok\":false,\"error\":\"segments must be an array\"}");
    return;
  }

  uint16_t applied = 0;
  for (JsonObject segment : segments) {
    int start = segment["start"] | -1;
    int count = segment["count"] | 0;
    uint8_t channel = segment["channel"] | 1;
    uint8_t r = segment["r"] | 0;
    uint8_t g = segment["g"] | 0;
    uint8_t b = segment["b"] | 0;

    if (start < 0 || count <= 0 || start >= TOTAL_LEDS) continue;
    if (channel < 1 || channel > 4) channel = 1;

    CRGB* leds = channelLeds(channel);
    int end = min(start + count, static_cast<int>(TOTAL_LEDS));
    for (int i = start; i < end; i++) {
      leds[i] = CRGB(r, g, b);
    }
    applied++;
  }

  showAllChannels();
  String body = "{\"ok\":true,\"segmentsApplied\":" + String(applied) + "}";
  sendJson(200, body);
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Conectando WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.print("ESP32-S3 listo en http://");
  Serial.println(WiFi.localIP());
}

void setup() {
  Serial.begin(115200);
  delay(300);

  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH1, LED_COLOR_ORDER>(ledsCh1, TOTAL_LEDS);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH2, LED_COLOR_ORDER>(ledsCh2, TOTAL_LEDS);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH3, LED_COLOR_ORDER>(ledsCh3, TOTAL_LEDS);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH4, LED_COLOR_ORDER>(ledsCh4, TOTAL_LEDS);
  FastLED.setBrightness(BRIGHTNESS);
  clearAllChannels();

  connectWifi();

  server.on("/api/health", HTTP_GET, handleHealth);
  server.on("/api/leds", HTTP_OPTIONS, handleOptions);
  server.on("/api/leds", HTTP_POST, handleLeds);
  server.on("/api/clear", HTTP_OPTIONS, handleOptions);
  server.on("/api/clear", HTTP_POST, handleClear);
  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      handleOptions();
      return;
    }
    sendJson(404, "{\"ok\":false,\"error\":\"Not found\"}");
  });

  server.begin();
}

void loop() {
  server.handleClient();
}
