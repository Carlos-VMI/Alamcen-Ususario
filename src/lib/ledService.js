import { db } from './db';

const STATE_COLORS = {
  lleno: '#15803d',
  vacio: '#b42318',
  pedido: '#fd6a01',
  unassigned: '#94a3b8',
  pick: '#fff200'
};

function hexToRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  const value = normalized.length === 3
    ? normalized.split('').map((char) => char + char).join('')
    : normalized.padEnd(6, '0').slice(0, 6);
  const parsed = Number.parseInt(value, 16);

  return {
    r: (parsed >> 16) & 255,
    g: (parsed >> 8) & 255,
    b: parsed & 255
  };
}

function colorForState(state) {
  return STATE_COLORS[state] || STATE_COLORS.unassigned;
}

function normalizeIp(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
}

async function postSegments(esp32Ip, channel, segments) {
  const ip = normalizeIp(esp32Ip);
  if (!ip || !segments.length || !navigator.onLine) return { skipped: true };

  const response = await fetch(`http://${ip}/api/leds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      channel: Number(channel || 1),
      segments
    })
  });

  if (!response.ok) {
    throw new Error(`ESP32 ${ip} respondio ${response.status}`);
  }

  return response.json().catch(() => ({ ok: true }));
}

export const ledService = {
  STATE_COLORS,

  colorForState,

  async saveMapping(mapping) {
    const now = new Date().toISOString();
    const row = {
      ...mapping,
      id: mapping.id || mapping.id_balda,
      id_balda: mapping.id_balda || mapping.id,
      esp32Ip: normalizeIp(mapping.esp32Ip),
      channel: Number(mapping.channel || mapping.canal || 1),
      startLed: Number(mapping.startLed || 0),
      ledCount: Number(mapping.ledCount || 0),
      updated_at: now
    };

    if (!row.id || !row.id_balda) {
      throw new Error('Falta el identificador de balda para el mapeo LED');
    }

    await db.led_mappings.put(row);
    return row;
  },

  async deleteMapping(id) {
    await db.led_mappings.delete(id);
  },

  async syncShelvesByIds(idBaldas) {
    const ids = [...new Set((idBaldas || []).filter(Boolean))];
    if (!ids.length) return { synced: 0 };

    const mappings = await this.readMappingsForIds(ids);
    const states = await db.estados_baldas.bulkGet(ids);
    const stateById = new Map(states.filter(Boolean).map((row) => [row.id_balda, row.estado]));

    return this.sendMappings(mappings, stateById);
  },

  async syncAllFromLocal() {
    const mappings = await this.readMappingsFromConfig();
    const states = await db.estados_baldas.toArray();
    const stateById = new Map(states.map((row) => [row.id_balda, row.estado]));
    return this.sendMappings(mappings, stateById);
  },

  async syncPickLightStates(pickLightStates = {}) {
    const entries = Object.entries(pickLightStates);
    if (!entries.length) return this.syncAllFromLocal();

    const activeShelfIds = entries
      .filter(([, state]) => state === 'blinking' || state === 'solid')
      .map(([id]) => id);
    const mappings = await this.readMappingsForShelfIds(activeShelfIds);
    const stateById = new Map(mappings.map((mapping) => [mapping.id_balda, 'pick']));
    return this.sendMappings(mappings, stateById);
  },

  async readMappingsFromConfig() {
    const rows = await db.estanterias_config.toArray();
    const mappings = [];

    for (const row of rows) {
      const cubetas = row.cubetas?.length ? row.cubetas : [row];
      for (const cubeta of cubetas) {
        const led = cubeta.led_mapping || row.led_mapping;
        if (!led?.esp32Ip && !led?.esp32_ip) continue;
        mappings.push({
          id: cubeta.id,
          id_balda: cubeta.id,
          esp32Ip: led.esp32Ip || led.esp32_ip,
          channel: led.channel || led.canal || 1,
          startLed: led.startLed,
          ledCount: led.ledCount,
          statusColor: led.statusColor
        });
      }
    }

    return mappings;
  },

  async readMappingsForIds(ids) {
    const idSet = new Set(ids);
    return (await this.readMappingsFromConfig()).filter((mapping) => idSet.has(mapping.id_balda));
  },

  async readMappingsForShelfIds(ids) {
    const idSet = new Set(ids);
    const rows = await db.estanterias_config.bulkGet(ids);
    return rows.filter(Boolean).map((row) => {
      const led = row.led_mapping;
      if (!led?.esp32Ip && !led?.esp32_ip) return null;
      return {
        id: row.id,
        id_balda: row.id,
        esp32Ip: led.esp32Ip || led.esp32_ip,
        channel: led.channel || led.canal || 1,
        startLed: led.startLed,
        ledCount: led.ledCount,
        statusColor: led.statusColor
      };
    }).filter(Boolean);
  },

  async sendMappings(mappings, stateById) {
    const grouped = new Map();

    for (const mapping of mappings) {
      const ip = normalizeIp(mapping.esp32Ip);
      const channel = Number(mapping.channel || mapping.canal || 1);
      const start = Number(mapping.startLed);
      const count = Number(mapping.ledCount);
      if (!ip || !Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;

      const state = stateById.get(mapping.id_balda) || 'lleno';
      const rgb = hexToRgb(mapping.statusColor || colorForState(state));
      const groupKey = `${ip}::${channel}`;
      const group = grouped.get(groupKey) || { ip, channel, segments: [] };
      group.segments.push({ start, count, ...rgb });
      grouped.set(groupKey, group);
    }

    const results = [];
    for (const group of grouped.values()) {
      results.push(await postSegments(group.ip, group.channel, group.segments));
    }

    return { synced: results.length };
  }
};
