#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <WiFiManager.h>
#include <FastLED.h>
#include <ArduinoJson.h>

// =========================
// Variables globales modificables
// =========================
const uint16_t MAX_LEDS_PER_CHANNEL = 1000;
const uint8_t DATA_PIN_CH1 = 12;
const uint8_t DATA_PIN_CH2 = 13;
const uint8_t DATA_PIN_CH3 = 14;
const uint8_t DATA_PIN_CH4 = 27;
const uint8_t BRIGHTNESS = 120;
const char* WIFI_AP_NAME = "ESP32-Almacen-Config";

// WS2812B 5V y WS2815 12V comparten protocolo tipo WS2812B con orden GRB.
#define LED_CHIPSET WS2812B
#define LED_COLOR_ORDER GRB

CRGB leds1[MAX_LEDS_PER_CHANNEL];
CRGB leds2[MAX_LEDS_PER_CHANNEL];
CRGB leds3[MAX_LEDS_PER_CHANNEL];
CRGB leds4[MAX_LEDS_PER_CHANNEL];

WebServer server(80);

CRGB* channelBuffer(uint8_t channel) {
  switch (channel) {
    case 2: return leds2;
    case 3: return leds3;
    case 4: return leds4;
    default: return leds1;
  }
}

bool isValidChannel(uint8_t channel) {
  return channel >= 1 && channel <= 4;
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

void clearChannel(uint8_t channel) {
  if (!isValidChannel(channel)) return;
  fill_solid(channelBuffer(channel), MAX_LEDS_PER_CHANNEL, CRGB::Black);
}

void clearAllChannels() {
  clearChannel(1);
  clearChannel(2);
  clearChannel(3);
  clearChannel(4);
  FastLED.show();
}

void handleHealth() {
  String body = "{";
  body += "\"ok\":true,";
  body += "\"ip\":\"" + WiFi.localIP().toString() + "\",";
  body += "\"maxLedsPerChannel\":" + String(MAX_LEDS_PER_CHANNEL) + ",";
  body += "\"channels\":4";
  body += "}";
  sendJson(200, body);
}

void handleClear() {
  uint8_t channel = server.hasArg("channel") ? server.arg("channel").toInt() : 0;

  if (isValidChannel(channel)) {
    clearChannel(channel);
  } else {
    clearAllChannels();
    sendJson(200, "{\"ok\":true,\"cleared\":\"all\"}");
    return;
  }

  FastLED.show();
  sendJson(200, "{\"ok\":true,\"cleared\":\"channel\"}");
}

void handleLeds() {
  if (!server.hasArg("plain")) {
    sendJson(400, "{\"ok\":false,\"error\":\"Missing JSON body\"}");
    return;
  }

  StaticJsonDocument<16384> doc;
  DeserializationError error = deserializeJson(doc, server.arg("plain"));
  if (error) {
    sendJson(400, "{\"ok\":false,\"error\":\"Invalid JSON\"}");
    return;
  }

  uint8_t payloadChannel = doc["channel"] | 1;
  if (!isValidChannel(payloadChannel)) {
    sendJson(400, "{\"ok\":false,\"error\":\"Invalid channel\"}");
    return;
  }

  JsonArray segments = doc["segments"].as<JsonArray>();
  if (segments.isNull()) {
    sendJson(400, "{\"ok\":false,\"error\":\"segments must be an array\"}");
    return;
  }

  uint16_t applied = 0;
  uint16_t rejected = 0;

  for (JsonObject segment : segments) {
    uint8_t channel = segment["channel"] | payloadChannel;
    int start = segment["start"] | -1;
    int count = segment["count"] | 0;
    uint8_t r = segment["r"] | 0;
    uint8_t g = segment["g"] | 0;
    uint8_t b = segment["b"] | 0;

    if (!isValidChannel(channel) || start < 0 || count <= 0 || start >= MAX_LEDS_PER_CHANNEL) {
      rejected++;
      continue;
    }

    if (start + count > MAX_LEDS_PER_CHANNEL) {
      count = MAX_LEDS_PER_CHANNEL - start;
      if (count <= 0) {
        rejected++;
        continue;
      }
    }

    CRGB* leds = channelBuffer(channel);
    for (int i = start; i < start + count; i++) {
      leds[i] = CRGB(r, g, b);
    }
    applied++;
  }

  FastLED.show();

  String body = "{";
  body += "\"ok\":true,";
  body += "\"channel\":" + String(payloadChannel) + ",";
  body += "\"segmentsApplied\":" + String(applied) + ",";
  body += "\"segmentsRejected\":" + String(rejected);
  body += "}";
  sendJson(200, body);
}

void setupWifi() {
  WiFi.mode(WIFI_STA);

  WiFiManager wifiManager;
  wifiManager.setConfigPortalTimeout(180);

  if (!wifiManager.autoConnect(WIFI_AP_NAME)) {
    Serial.println("No se pudo conectar o configurar WiFi. Reiniciando...");
    delay(1000);
    ESP.restart();
  }

  Serial.print("ESP32-S3 listo en http://");
  Serial.println(WiFi.localIP());
}

void setupRoutes() {
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
}

void setup() {
  Serial.begin(115200);
  delay(300);

  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH1, LED_COLOR_ORDER>(leds1, MAX_LEDS_PER_CHANNEL);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH2, LED_COLOR_ORDER>(leds2, MAX_LEDS_PER_CHANNEL);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH3, LED_COLOR_ORDER>(leds3, MAX_LEDS_PER_CHANNEL);
  FastLED.addLeds<LED_CHIPSET, DATA_PIN_CH4, LED_COLOR_ORDER>(leds4, MAX_LEDS_PER_CHANNEL);
  FastLED.setBrightness(BRIGHTNESS);
  clearAllChannels();

  setupWifi();
  setupRoutes();
  server.begin();
}

void loop() {
  server.handleClient();
}
