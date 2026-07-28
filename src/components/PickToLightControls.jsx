import { Check, Mic, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { transcribeAudioWithWhisper } from '../lib/voiceTranscriptionService';

const BLINK_DURATION_MS = 5000;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function splitVoiceText(text) {
  return String(text || '')
    .split(/,|;|\by\b|\n/gi)
    .map((part) => part.trim())
    .filter(Boolean);
}

function flattenInventory(config) {
  return config.flatMap((balda) => {
    const cubetas = balda.cubetas?.length ? balda.cubetas : [balda];
    return cubetas
      .filter((cubeta) => cubeta.sku)
      .map((cubeta) => ({
        id: cubeta.id,
        sku: cubeta.sku,
        skuBase: cubeta.sku_base || balda.sku_base || balda.sku,
        descripcion: cubeta.descripcion || balda.descripcion || '',
        codigoArticulo: cubeta.codigo_articulo || balda.codigo_articulo || '',
        codigoCliente: cubeta.codigo_cliente || balda.codigo_cliente || '',
        ubicacion: cubeta.codigo_ubicacion || balda.codigo_ubicacion || '',
        label: `${cubeta.descripcion || balda.descripcion || cubeta.sku} - ${cubeta.codigo_ubicacion || balda.codigo_ubicacion || ''}`
      }));
  });
}

function findInventoryItem(text, inventory) {
  const query = normalizeText(text);
  if (!query) return null;

  return inventory.find((item) => {
    const candidates = [
      item.sku,
      item.skuBase,
      item.descripcion,
      item.codigoArticulo,
      item.codigoCliente,
      item.ubicacion
    ].map(normalizeText).filter(Boolean);

    return candidates.some((value) => value === query || value.includes(query) || query.includes(value));
  }) ?? null;
}

export function PickToLightControls({ config, onLightStatesChange }) {
  const [query, setQuery] = useState('');
  const [pickList, setPickList] = useState([]);
  const [lightStates, setLightStates] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [message, setMessage] = useState('');
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const timersRef = useRef([]);
  const inputRef = useRef(null);
  const inventory = useMemo(() => flattenInventory(config), [config]);

  const matches = useMemo(() => (
    pickList.map((entry) => ({
      ...entry,
      item: findInventoryItem(entry.text, inventory)
    }))
  ), [inventory, pickList]);

  useEffect(() => {
    onLightStatesChange(lightStates);
  }, [lightStates, onLightStatesChange]);

  useEffect(() => () => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    onLightStatesChange({});
  }, [onLightStatesChange]);

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
    setMessage('');
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
      .map((entry) => findInventoryItem(entry.text, inventory))
      .filter(Boolean);

    if (!foundItems.length) {
      setLightStates({});
      setMessage('Sin coincidencias en las estanterias reales.');
      return;
    }

    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    timersRef.current = [];

    const blinkingState = {};
    foundItems.forEach((item) => {
      blinkingState[item.id] = 'blinking';
    });
    setLightStates(blinkingState);
    setMessage(`${foundItems.length} ubicacion${foundItems.length === 1 ? '' : 'es'} iluminada${foundItems.length === 1 ? '' : 's'}.`);

    const timerId = window.setTimeout(() => {
      setLightStates((current) => {
        const next = { ...current };
        foundItems.forEach((item) => {
          next[item.id] = 'solid';
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
    setMessage('');
    inputRef.current?.focus();
  };

  const startRecording = async () => {
    if (isRecording) return;
    setMessage('');

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
            setMessage('Audio grabado. Configura Whisper para transcribir automaticamente.');
            return;
          }
          splitVoiceText(text).forEach(addPickEntry);
        } catch (error) {
          setMessage(error?.message || 'No se pudo interpretar el audio.');
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch {
      setMessage('No se pudo acceder al microfono.');
    }
  };

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  const handleMicClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const hasPopover = pickList.length > 0 || message;

  return (
    <div className="pick-header-tools">
      <div className="pick-header-search">
        <input
          ref={inputRef}
          className="pick-header-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          enterKeyHint="done"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addPickEntry(query);
          }}
          placeholder="SKU, codigo o descripcion"
          aria-label="Buscar material en estanteria"
        />
        <button
          className={`pick-header-mic ${isRecording ? 'recording' : ''}`}
          type="button"
          onClick={handleMicClick}
          title={isRecording ? 'Detener grabacion' : 'Grabar voz'}
        >
          <Mic size={20} />
        </button>
        <button className="pick-header-search-button" type="button" onClick={executeSearch}>
          <Search size={18} />
          Buscar
        </button>
        <button className="pick-header-ready" type="button" onClick={resetCycle}>
          <Check size={18} />
          Listo
        </button>
      </div>

      {hasPopover ? (
        <div className="pick-header-popover">
          {pickList.length ? (
            <div className="pick-list-items">
              {matches.map((entry) => (
                <div className={`pick-list-item ${entry.item ? 'matched' : 'missing'}`} key={entry.id}>
                  <div>
                    <strong>{entry.item?.descripcion || entry.item?.sku || entry.text}</strong>
                    <span>{entry.item ? `${entry.item.sku} - ${entry.item.ubicacion}` : 'Sin coincidencia'}</span>
                  </div>
                  <button type="button" onClick={() => removePickEntry(entry.id)} aria-label="Quitar articulo">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {message ? <p className="pick-notice">{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
