import { Check, Mic, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { transcribeAudioWithWhisper } from '../lib/voiceTranscriptionService';

const BLINK_DURATION_MS = 5000;
const GRID_ROWS = 4;
const GRID_COLUMNS = 6;

const MOCK_INVENTORY = [
  { id: 'art-001', nombre: 'Tornillo M4', codigo: 'TOR-M4', sku: 'M1E1C1', row: 1, column: 1, capacidad: 300 },
  { id: 'art-002', nombre: 'Rele 12V', codigo: 'REL-12V', sku: 'M1E1C3', row: 1, column: 3, capacidad: 40 },
  { id: 'art-003', nombre: 'Cable AWG18', codigo: 'CAB-AWG18', sku: 'M1E2C2', row: 2, column: 2, capacidad: 120 },
  { id: 'art-004', nombre: 'Sensor inductivo M12', codigo: 'SEN-M12', sku: 'M1E3C5', row: 3, column: 5, capacidad: 25 },
  { id: 'art-005', nombre: 'Fusible 5A', codigo: 'FUS-5A', sku: 'M1E4C4', row: 4, column: 4, capacidad: 80 },
  { id: 'art-006', nombre: 'Bornera 2 polos', codigo: 'BOR-2P', sku: 'M1E2C6', row: 2, column: 6, capacidad: 150 }
];

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function findInventoryItem(text) {
  const query = normalizeText(text);
  if (!query) return null;

  return MOCK_INVENTORY.find((item) => {
    const haystack = [
      item.nombre,
      item.codigo,
      item.sku
    ].map(normalizeText);

    return haystack.some((value) => value === query || value.includes(query) || query.includes(value));
  }) ?? null;
}

function splitVoiceText(text) {
  return String(text || '')
    .split(/,|;|\by\b|\n/gi)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function PickToLightView() {
  const [query, setQuery] = useState('');
  const [pickList, setPickList] = useState([]);
  const [lightStates, setLightStates] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [searchNotice, setSearchNotice] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timersRef = useRef([]);
  const inputRef = useRef(null);

  const matches = useMemo(() => (
    pickList.map((entry) => ({
      ...entry,
      item: findInventoryItem(entry.text)
    }))
  ), [pickList]);

  useEffect(() => {
    inputRef.current?.focus();

    return () => {
      timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    };
  }, []);

  const addPickEntry = (rawText) => {
    const text = String(rawText || '').trim();
    if (!text) return;

    setPickList((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text
      }
    ]);
    setQuery('');
    setSearchNotice('');
    window.requestAnimationFrame(() => inputRef.current?.focus());
  };

  const removePickEntry = (id) => {
    setPickList((current) => current.filter((entry) => entry.id !== id));
  };

  const executeSearch = () => {
    const nextList = query.trim()
      ? [...pickList, { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, text: query.trim() }]
      : pickList;

    setPickList(nextList);
    setQuery('');

    const foundItems = nextList
      .map((entry) => findInventoryItem(entry.text))
      .filter(Boolean);

    if (!foundItems.length) {
      setSearchNotice('No se encontraron ubicaciones para la lista actual.');
      return;
    }

    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];

    const blinkingState = {};
    foundItems.forEach((item) => {
      blinkingState[item.sku] = 'blinking';
    });
    setLightStates(blinkingState);
    setSearchNotice(`${foundItems.length} ubicacion${foundItems.length === 1 ? '' : 'es'} activada${foundItems.length === 1 ? '' : 's'}.`);

    const timerId = window.setTimeout(() => {
      setLightStates((current) => {
        const next = { ...current };
        foundItems.forEach((item) => {
          next[item.sku] = 'solid';
        });
        return next;
      });
    }, BLINK_DURATION_MS);
    timersRef.current.push(timerId);
  };

  const resetCycle = () => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];
    setPickList([]);
    setLightStates({});
    setQuery('');
    setSearchNotice('');
    setVoiceError('');
    inputRef.current?.focus();
  };

  const startRecording = async () => {
    if (isRecording) return;
    setVoiceError('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data?.size) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setIsRecording(false);

        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (!audioBlob.size) return;

        try {
          const text = await transcribeAudioWithWhisper(audioBlob);
          if (!text) {
            setVoiceError('Audio grabado. Configura VITE_WHISPER_ENDPOINT o VITE_OPENAI_API_KEY para transcribir.');
            return;
          }

          splitVoiceText(text).forEach(addPickEntry);
        } catch (error) {
          setVoiceError(error?.message || 'No se pudo interpretar el audio.');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setVoiceError('No se pudo acceder al microfono de la tablet.');
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    }
  };

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const gridCells = Array.from({ length: GRID_ROWS * GRID_COLUMNS }, (_, index) => {
    const row = Math.floor(index / GRID_COLUMNS) + 1;
    const column = (index % GRID_COLUMNS) + 1;
    const item = MOCK_INVENTORY.find((candidate) => candidate.row === row && candidate.column === column);
    const lightState = item ? lightStates[item.sku] || 'off' : 'off';

    return { row, column, item, lightState };
  });

  return (
    <section className="pick-screen" aria-label="Pick to Light virtual">
      <div className="pick-command-panel">
        <div className="pick-search-wrap">
          <div className="pick-search-row">
            <input
              ref={inputRef}
              className="pick-search-input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addPickEntry(query);
              }}
              autoFocus
              placeholder="Escanea o escribe codigo / articulo"
              aria-label="Buscar articulo para pick to light"
            />
            <button
              className={`pick-mic-button ${isRecording ? 'recording' : ''}`}
              type="button"
              onClick={handleMicClick}
              title={isRecording ? 'Detener grabacion' : 'Grabar comando de voz'}
            >
              <Mic size={24} />
            </button>
            <button className="pick-search-button" type="button" onClick={executeSearch}>
              <Search size={22} />
              Buscar
            </button>
          </div>

          {(pickList.length > 0 || voiceError || searchNotice) ? (
            <div className="pick-list-panel">
              {pickList.length > 0 ? (
                <div className="pick-list-items">
                  {matches.map((entry) => (
                    <div className={`pick-list-item ${entry.item ? 'matched' : 'missing'}`} key={entry.id}>
                      <div>
                        <strong>{entry.item?.nombre || entry.text}</strong>
                        <span>{entry.item ? `${entry.item.codigo} - ${entry.item.sku}` : 'Sin coincidencia en mock data'}</span>
                      </div>
                      <button type="button" onClick={() => removePickEntry(entry.id)} aria-label="Quitar articulo">
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {searchNotice ? <p className="pick-notice">{searchNotice}</p> : null}
              {voiceError ? <p className="pick-error">{voiceError}</p> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="pick-actions-row">
        <button className="pick-ready-button" type="button" onClick={resetCycle}>
          <Check size={22} />
          Listo
        </button>
        <button className="pick-clear-button" type="button" onClick={resetCycle}>
          <Trash2 size={18} />
          Limpiar
        </button>
      </div>

      <div className="pick-grid-shell">
        <div className="pick-grid-header">
          <h2>Estanteria virtual</h2>
          <p>Amarillo parpadeante durante 5 segundos, luego verde fijo.</p>
        </div>
        <div className="pick-grid" style={{ gridTemplateColumns: `repeat(${GRID_COLUMNS}, minmax(0, 1fr))` }}>
          {gridCells.map(({ row, column, item, lightState }) => (
            <div className={`pick-cell ${lightState} ${item ? 'configured' : 'empty'}`} key={`R${row}C${column}`}>
              <span className="pick-cell-location">F{row} C{column}</span>
              <strong>{item?.sku || 'Libre'}</strong>
              <small>{item?.nombre || 'Sin articulo'}</small>
              {item ? <em>Cap. {item.capacidad}</em> : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
