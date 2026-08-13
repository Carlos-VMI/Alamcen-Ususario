# ESP32-S3 LED Controller

Firmware para controlar tiras WS2812B o WS2815 desde la PWA de operario.

## Configuracion rapida

1. Edita `firmware.ino`.
2. Cambia `TOTAL_LEDS`, `DATA_PIN`, `BRIGHTNESS`, `WIFI_SSID` y `WIFI_PASSWORD`.
3. Compila con Arduino IDE o PlatformIO.
4. Carga el firmware en el ESP32-S3.
5. En la PWA, abre `LED` y asigna la IP del ESP32, `startLed` y `ledCount` por balda.

Endpoint principal:

```http
POST http://<ESP32_IP>/api/leds
Content-Type: application/json

{
  "segments": [
    { "start": 0, "count": 12, "r": 0, "g": 255, "b": 0 }
  ]
}
```

Notas electricas:
- WS2812B normalmente usa 5V.
- WS2815 normalmente usa 12V para potencia, pero la senal de datos sigue siendo tipo WS2812/GRB.
- Usa fuente externa suficiente, GND comun entre fuente y ESP32, y resistencia serie de 330-470 ohm en DATA si es posible.
