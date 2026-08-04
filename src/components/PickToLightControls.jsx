import { Check, Mic, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

const BLINK_DURATION_MS = 5000;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .trim();
}

function compactText(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, '');
}

function textTokens(value) {
  return normalizeText(value).match(/[a-z0-9]+/g) || [];
}

function flattenInventory(config) {
  return config
    .map((balda) => {
      const cubetas = balda.cubetas?.length ? balda.cubetas : [balda];
      return {
        id: balda.id,
        sku: balda.sku || balda.sku_base || '',
        skuBase: balda.sku_base || balda.sku || '',
        descripcion: balda.descripcion || '',
        codigoArticulo: balda.codigo_articulo || '',
        codigoCliente: balda.codigo_cliente || '',
        ubicacion: balda.codigo_ubicacion || '',
        cubetas: cubetas.map((cubeta) => ({
          sku: cubeta.sku || '',
          skuBase: cubeta.sku_base || '',
          descripcion: cubeta.descripcion || '',
          codigoArticulo: cubeta.codigo_articulo || '',
          codigoCliente: cubeta.codigo_cliente || '',
          ubicacion: cubeta.codigo_ubicacion || '',
          sufijo: cubeta.sufijo || ''
        }))
      };
    })
    .filter((item) => item.sku || item.cubetas.some((cubeta) => cubeta.sku));
}

function findInventoryItem(text, inventory) {
  const query = normalizeText(text);
  if (!query) return null;

  return searchInventoryItems(text, inventory, 1)[0] ?? null;
}

function searchInventoryItems(text, inventory, limit = 8) {
  const query = normalizeText(text);
  if (!query) return [];
  const queryCompact = compactText(query);
  const queryTokens = textTokens(query);

  return inventory.filter((item) => {
    const candidates = [
      item.sku,
      item.skuBase,
      item.descripcion,
      item.codigoArticulo,
      item.codigoCliente,
      item.ubicacion,
      ...item.cubetas.flatMap((cubeta) => [
        cubeta.sku,
        cubeta.skuBase,
        cubeta.descripcion,
        cubeta.codigoArticulo,
        cubeta.codigoCliente,
        cubeta.ubicacion
      ])
    ].map(normalizeText).filter(Boolean);

    return candidates.some((value) => {
      const valueTokens = textTokens(value);
      const valueCompact = compactText(value);
      if (!valueCompact) return false;

      if (/^\d+$/.test(queryCompact) && queryCompact.length > 1) {
        return valueTokens.includes(queryCompact) || valueCompact.includes(queryCompact);
      }

      if (queryTokens.length > 1) {
        return queryTokens.every((token) => valueTokens.includes(token)) || valueCompact.includes(queryCompact);
      }

      const token = queryTokens[0] || queryCompact;
      if (!token) return false;
      return valueTokens.some((valueToken) => valueToken.startsWith(token)) || valueCompact.startsWith(queryCompact);
    });
  }).slice(0, limit);
}

function formatItemMeta(item) {
  if (!item) return 'Sin coincidencia';
  const sku = item.sku || item.skuBase || '';
  const ubicacion = item.ubicacion || '';
  if (sku && ubicacion && normalizeText(sku) !== normalizeText(ubicacion)) return `${sku} - ${ubicacion}`;
  return sku || ubicacion || 'Articulo encontrado';
}

export function PickToLightControls({ config, onLightStatesChange }) {
  const [query, setQuery] = useState('');
  const [pickList, setPickList] = useState([]);
  const [lightStates, setLightStates] = useState({});
  const [isRecording, setIsRecording] = useState(false);
  const [message, setMessage] = useState('');
  const recognitionRef = useRef(null);
  const timersRef = useRef([]);
  const inventory = useMemo(() => flattenInventory(config), [config]);

  const matches = useMemo(() => (
    pickList.map((entry) => ({
      ...entry,
      item: entry.itemId
        ? inventory.find((item) => item.id === entry.itemId) ?? findInventoryItem(entry.text, inventory)
        : findInventoryItem(entry.text, inventory)
    }))
  ), [inventory, pickList]);
  const suggestions = useMemo(() => searchInventoryItems(query, inventory, 8), [inventory, query]);

  useEffect(() => {
    onLightStatesChange(lightStates);
  }, [lightStates, onLightStatesChange]);

  useEffect(() => () => {
    timersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    recognitionRef.current?.stop();
    onLightStatesChange({});
  }, [onLightStatesChange]);

  const addPickEntry = (rawText, item = null) => {
    const text = String(rawText || item?.descripcion || item?.sku || item?.skuBase || item?.ubicacion || '').trim();
    if (!text) return;

    setPickList((current) => [
      ...current,
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        text,
        itemId: item?.id || null
      }
    ]);
    setQuery('');
    setMessage('');
  };

  const removePickEntry = (id) => {
    setPickList((current) => current.filter((entry) => entry.id !== id));
  };

  const executeSearch = () => {
    const selectedSuggestion = suggestions[0] || null;
    const nextList = query.trim()
      ? [
        ...pickList,
        {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          text: query.trim(),
          itemId: selectedSuggestion?.id || null
        }
      ]
      : pickList;

    setPickList(nextList);
    setQuery('');

    const foundItems = nextList
      .map((entry) => (
        entry.itemId
          ? inventory.find((item) => item.id === entry.itemId) ?? findInventoryItem(entry.text, inventory)
          : findInventoryItem(entry.text, inventory)
      ))
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
    setMessage(`${foundItems.length} balda${foundItems.length === 1 ? '' : 's'} iluminada${foundItems.length === 1 ? '' : 's'}.`);

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
  };

  const startRecognition = () => {
    if (isRecording) return;

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setMessage('Este navegador no soporta reconocimiento de voz nativo.');
      return;
    }

    const recognition = new Recognition();
    recognition.lang = 'es-ES';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = Array.from(event.results || [])
        .map((result) => result?.[0]?.transcript || '')
        .join(' ')
        .trim();
      if (transcript) setQuery(transcript);
    };

    recognition.onerror = () => {
      setMessage('No se pudo transcribir la voz.');
    };

    recognition.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsRecording(true);
    setMessage('');
  };

  const handleMicClick = () => {
    if (isRecording) {
      recognitionRef.current?.stop();
      return;
    }
    startRecognition();
  };

  const hasPopover = suggestions.length > 0 || pickList.length > 0 || message;

  return (
    <div className="pick-header-tools">
      <div className="pick-header-search">
        <input
          className="pick-header-input"
          type="search"
          inputMode="text"
          autoComplete="off"
          enterKeyHint="done"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addPickEntry(query, suggestions[0] || null);
          }}
          placeholder="SKU, codigo o descripcion"
          aria-label="Buscar material en estanteria"
        />
        <button
          className={`pick-header-mic ${isRecording ? 'recording' : ''}`}
          type="button"
          onClick={handleMicClick}
          title={isRecording ? 'Detener voz' : 'Escuchar voz'}
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
          {suggestions.length ? (
            <div className="pick-suggestion-list">
              {suggestions.map((item) => (
                <button
                  className="pick-suggestion-item"
                  key={item.id}
                  type="button"
                  onClick={() => addPickEntry(query || item.descripcion || item.sku, item)}
                >
                  <strong>{item.descripcion || item.sku || item.skuBase}</strong>
                  <span>{formatItemMeta(item)}</span>
                </button>
              ))}
            </div>
          ) : null}
          {pickList.length ? (
            <div className="pick-list-items">
              {matches.map((entry) => (
                <div className={`pick-list-item ${entry.item ? 'matched' : 'missing'}`} key={entry.id}>
                  <div>
                    <strong>{entry.item?.descripcion || entry.item?.sku || entry.text}</strong>
                    <span>{formatItemMeta(entry.item)}</span>
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
