import { Lightbulb, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ledService } from '../lib/ledService';

const SEQUENCE_DURATION_MS = 20000;

function canManageLeds(userRole) {
  const role = String(userRole || '').toLowerCase();
  return role === 'admin' || role === 'administrador' || role === 'supervisor';
}

function ToggleSwitch({ checked, disabled, label, onChange }) {
  return (
    <button
      className={`led-toggle ${checked ? 'on' : 'off'}`}
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="led-toggle-track">
        <span className="led-toggle-thumb" />
      </span>
      <span>{label}</span>
    </button>
  );
}

export function LedControlPanel({ userRole }) {
  const [open, setOpen] = useState(false);
  const [ledsEnabled, setLedsEnabled] = useState(true);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [brightness, setBrightness] = useState(5);
  const [sequenceRunning, setSequenceRunning] = useState(false);
  const panelRef = useRef(null);
  const canAccess = canManageLeds(userRole);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (!panelRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!sequenceRunning) return undefined;

    const timerId = window.setTimeout(() => {
      setSequenceRunning(false);
    }, SEQUENCE_DURATION_MS);

    return () => window.clearTimeout(timerId);
  }, [sequenceRunning]);

  if (!canAccess) return null;

  const handleLedToggle = async (nextEnabled) => {
    setLedsEnabled(nextEnabled);
    console.log({ accion: 'set_estados', valor: nextEnabled });
    try {
      if (nextEnabled) {
        await ledService.syncAllFromLocal();
      } else {
        await ledService.turnOffAll();
      }
    } catch (error) {
      console.warn('No se pudo cambiar el estado general de LEDs', error);
    }
  };

  const handleSearchToggle = async (nextEnabled) => {
    setSearchEnabled(nextEnabled);
    console.log({ accion: 'set_busqueda', valor: nextEnabled });
    try {
      if (nextEnabled) {
        await ledService.highlightAllSearch();
      } else if (ledsEnabled) {
        await ledService.syncAllFromLocal();
      } else {
        await ledService.turnOffAll();
      }
    } catch (error) {
      console.warn('No se pudo cambiar el modo busqueda de LEDs', error);
    }
  };

  const handlePartyMode = () => {
    const nextRunning = !sequenceRunning;
    console.log({ accion: 'set_fiesta', valor: nextRunning });
    setSequenceRunning(nextRunning);
  };

  const handleBrightnessChange = (event) => {
    const nextBrightness = Number(event.target.value);
    setBrightness(nextBrightness);
    console.log({ accion: 'set_brillo', valor: nextBrightness });
  };

  return (
    <div className="led-control-wrap" ref={panelRef}>
      <button
        className={`led-control-button ${open ? 'active' : ''}`}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <Lightbulb size={17} aria-hidden="true" />
        LEDs
      </button>

      {open ? (
        <section className="led-control-popover" aria-label="Configuracion de LEDs">
          <div className="led-control-head">
            <strong>Seteo LEDs</strong>
            <span>ESP32</span>
          </div>

          <div className="led-control-row">
            <ToggleSwitch
              checked={ledsEnabled}
              label="Estados"
              onChange={handleLedToggle}
            />
          </div>

          <div className="led-control-row">
            <ToggleSwitch
              checked={searchEnabled}
              label="Búsqueda"
              onChange={handleSearchToggle}
            />
          </div>

          <label className="led-range-field">
            <span>Brillo</span>
            <strong>{brightness}/8</strong>
            <input
              type="range"
              min="1"
              max="8"
              step="1"
              value={brightness}
              onChange={handleBrightnessChange}
              aria-label="Brillo de LEDs"
            />
            <div className="led-brightness-bars" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <span
                  className={index < brightness ? 'active' : ''}
                  key={index}
                  style={{ height: `${8 + index * 3}px` }}
                />
              ))}
            </div>
          </label>

          <button
            className={`led-party-button ${sequenceRunning ? 'running' : ''}`}
            type="button"
            aria-pressed={sequenceRunning}
            onClick={handlePartyMode}
          >
            <Sparkles size={17} />
            {sequenceRunning ? 'Secuencia en curso...' : 'Modo Fiesta'}
          </button>
        </section>
      ) : null}
    </div>
  );
}
