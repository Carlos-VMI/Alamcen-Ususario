import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { ledService } from '../lib/ledService';

function flattenShelves(config) {
  return config
    .filter((shelf) => shelf.sku)
    .sort((a, b) => {
      const moduleOrder = Number(a.modulo_orden || 0) - Number(b.modulo_orden || 0);
      if (moduleOrder) return moduleOrder;
      const shelfOrder = Number(a.estante || 0) - Number(b.estante || 0);
      if (shelfOrder) return shelfOrder;
      return Number(a.posicion || 0) - Number(b.posicion || 0);
    });
}

export function LedConfigModal({ almacenId, config, onClose }) {
  const mappings = useLiveQuery(() => db.led_mappings.toArray(), [], []);
  const [drafts, setDrafts] = useState({});
  const [message, setMessage] = useState('');
  const mappingById = useMemo(() => new Map(mappings.map((mapping) => [mapping.id_balda, mapping])), [mappings]);
  const shelves = useMemo(() => flattenShelves(config), [config]);

  const readValue = (shelf, field) => {
    const draft = drafts[shelf.id];
    if (draft && field in draft) return draft[field];
    return mappingById.get(shelf.id)?.[field] ?? '';
  };

  const updateDraft = (shelfId, patch) => {
    setDrafts((current) => ({
      ...current,
      [shelfId]: {
        ...(current[shelfId] || {}),
        ...patch
      }
    }));
  };

  const saveShelf = async (shelf) => {
    setMessage('');
    const row = await ledService.saveMapping({
      id: shelf.id,
      id_balda: shelf.id,
      almacen_id: almacenId,
      modulo: shelf.modulo,
      estante: shelf.estante,
      posicion: shelf.posicion,
      codigo_ubicacion: shelf.codigo_ubicacion,
      esp32Ip: readValue(shelf, 'esp32Ip'),
      startLed: readValue(shelf, 'startLed'),
      ledCount: readValue(shelf, 'ledCount')
    });

    setDrafts((current) => {
      const next = { ...current };
      delete next[shelf.id];
      return next;
    });
    setMessage(`Guardado ${row.codigo_ubicacion || shelf.codigo_ubicacion}`);
  };

  const clearShelf = async (shelf) => {
    await ledService.deleteMapping(shelf.id);
    setDrafts((current) => {
      const next = { ...current };
      delete next[shelf.id];
      return next;
    });
  };

  const testAll = async () => {
    setMessage('');
    try {
      const result = await ledService.syncAllFromLocal();
      setMessage(`Enviado a ${result.synced} controlador(es)`);
    } catch (error) {
      setMessage(error?.message || 'No se pudo enviar a los ESP32');
    }
  };

  return (
    <div className="modal-backdrop led-backdrop" role="presentation">
      <section className="led-config-dialog" role="dialog" aria-modal="true" aria-labelledby="led-config-title">
        <header className="led-config-head">
          <div>
            <h2 id="led-config-title">Configuracion LED fisica</h2>
            <p>Asigna IP del ESP32-S3 y tramo de LEDs por balda/SKU.</p>
          </div>
          <div className="led-config-actions">
            <button className="secondary-button" type="button" onClick={testAll}>
              Probar LEDs
            </button>
            <button className="danger-button" type="button" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </header>

        {message ? <div className="top-notice">{message}</div> : null}

        <div className="led-table-wrap">
          <table className="led-config-table">
            <thead>
              <tr>
                <th>Balda</th>
                <th>Articulo</th>
                <th>ESP32 IP</th>
                <th>Inicio</th>
                <th>LEDs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shelves.map((shelf) => (
                <tr key={shelf.id}>
                  <td>
                    <strong>{shelf.codigo_ubicacion}</strong>
                    <span>{shelf.modulo} - E{shelf.estante} - C{shelf.posicion}</span>
                  </td>
                  <td>{shelf.descripcion || shelf.sku}</td>
                  <td>
                    <input
                      inputMode="decimal"
                      type="text"
                      value={readValue(shelf, 'esp32Ip')}
                      onChange={(event) => updateDraft(shelf.id, { esp32Ip: event.target.value })}
                      placeholder="192.168.1.50"
                    />
                  </td>
                  <td>
                    <input
                      inputMode="numeric"
                      min="0"
                      type="number"
                      value={readValue(shelf, 'startLed')}
                      onChange={(event) => updateDraft(shelf.id, { startLed: event.target.value })}
                      placeholder="0"
                    />
                  </td>
                  <td>
                    <input
                      inputMode="numeric"
                      min="1"
                      type="number"
                      value={readValue(shelf, 'ledCount')}
                      onChange={(event) => updateDraft(shelf.id, { ledCount: event.target.value })}
                      placeholder="12"
                    />
                  </td>
                  <td>
                    <div className="led-row-actions">
                      <button className="setup-button" type="button" onClick={() => saveShelf(shelf)}>
                        Guardar
                      </button>
                      <button className="secondary-button" type="button" onClick={() => clearShelf(shelf)}>
                        Limpiar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
