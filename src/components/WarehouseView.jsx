import { useEffect, useMemo, useState } from 'react';
import { BaldaCard } from './BaldaCard';

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] = groups[key] ?? [];
    groups[key].push(item);
    return groups;
  }, {});
}

function stateClassForShelf(shelf, estadosById, pickLightStates = {}) {
  if (shelf.is_free_space) return 'free-space';
  const cubetas = shelf.cubetas?.length ? shelf.cubetas : [shelf];
  if (!cubetas.some((cubeta) => cubeta.sku)) return 'unassigned';
  if (pickLightStates[shelf.id] === 'blinking') return 'pick-blinking';
  if (pickLightStates[shelf.id] === 'solid') return 'pick-solid';
  return 'assigned';
}

function stateClassForCubeta(cubeta, estadosById, pickLightStates = {}, shelfId = '') {
  if (cubeta.is_free_space) return 'free-space';
  if (!cubeta.sku) return 'unassigned';
  const stateRow = estadosById.get(cubeta.id);
  if (stateRow?.pending_sync) return 'pendiente';
  if (typeof stateRow === 'string') return stateRow || 'lleno';
  return stateRow?.estado || 'lleno';
}

function gridTemplateForShelves(shelves) {
  if (!shelves.length) return '1fr';
  return shelves
    .map((shelf) => `${Math.max(0.1, Number(shelf.ancho_cm) || 1)}fr`)
    .join(' ');
}

function ModulePanel({ moduleName, shelves, estadosById, operatorRole, viewMode, pickLightStates = {}, compact = false }) {
  const rows = groupBy(shelves, (row) => row.estante);

  if (compact) {
    return (
      <div className="overview-module-grid">
        {Array.from({ length: 8 }, (_, index) => {
          const rowNumber = String(index + 1);
          const rowShelves = rows[rowNumber] ?? rows[index + 1] ?? [];
          const sortedShelves = [...rowShelves].sort((a, b) => Number(a.posicion) - Number(b.posicion));

          return (
            <div className="overview-row" key={`${moduleName}-mini-${rowNumber}`}>
              <div
                className="overview-row-cells"
                style={{
                  gridTemplateColumns: gridTemplateForShelves(sortedShelves)
                }}
              >
                {sortedShelves.map((shelf) => {
                  const cubetas = shelf.cubetas?.length ? shelf.cubetas : [shelf];
                  return (
                    <span
                      className={`overview-cell ${stateClassForShelf(shelf, estadosById, pickLightStates)}`}
                      key={shelf.id}
                    >
                      <span
                        className="overview-cubeta-grid"
                        style={{ gridTemplateColumns: `repeat(${Math.max(1, cubetas.length || 1)}, minmax(0, 1fr))` }}
                      >
                        {(cubetas.length ? cubetas : [shelf]).map((cubeta, cubetaIndex) => (
                          <span
                            className={`overview-cubeta ${stateClassForCubeta(cubeta, estadosById, pickLightStates, shelf.id)}`}
                            key={cubeta.id || `${shelf.id}-${cubetaIndex}`}
                          />
                        ))}
                      </span>
                    </span>
                  );
                })}
                {sortedShelves.length === 0 ? <span className="overview-cell empty-structural" aria-hidden="true" /> : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="module-panel">
      <h2>{moduleName}</h2>
      <div className="module-panel-body">
        {Array.from({ length: 8 }, (_, index) => {
          const rowNumber = String(index + 1);
          const rowShelves = rows[rowNumber] ?? rows[index + 1] ?? [];
          const sortedShelves = [...rowShelves].sort((a, b) => Number(a.posicion) - Number(b.posicion));

          return (
            <div className="shelf-row" key={`${moduleName}-${rowNumber}`}>
              <span className="row-label">{rowNumber}</span>
              <div className="shelf-cells">
                {sortedShelves.length > 0 ? (
                  <>
                    <div
                      className="shelf-card-row"
                      style={{
                        gridTemplateColumns: gridTemplateForShelves(sortedShelves)
                      }}
                    >
                      {sortedShelves.map((balda) => (
                        <div className="shelf-slot" key={balda.id}>
                          <BaldaCard
                            balda={balda}
                            estadosById={estadosById}
                            operatorRole={operatorRole}
                            viewMode={viewMode}
                            pickLightStates={pickLightStates}
                          />
                        </div>
                      ))}
                    </div>
                    <div
                      className="shelf-column-bar"
                      style={{
                        gridTemplateColumns: gridTemplateForShelves(sortedShelves)
                      }}
                    >
                      {sortedShelves.map((balda) => (
                        <span className="column-label" key={`${balda.id}-label`}>
                          {balda.etiqueta_balda ?? `C${balda.posicion}`}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <span className="empty-row" aria-hidden="true" />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function WarehouseView({ config, estados, operatorRole = 'operario', viewMode = 'estado', pickLightStates = {} }) {
  const estadosById = useMemo(() => new Map(estados.map((estado) => [estado.id_balda, estado])), [estados]);
  const moduleEntries = useMemo(() => (
    Object.entries(groupBy(config, (row) => row.modulo || 'Modulo 1'))
      .sort(([, shelvesA], [, shelvesB]) => {
        const orderA = Number(shelvesA[0]?.modulo_orden ?? String(shelvesA[0]?.modulo || '').match(/\d+/)?.[0] ?? 0);
        const orderB = Number(shelvesB[0]?.modulo_orden ?? String(shelvesB[0]?.modulo || '').match(/\d+/)?.[0] ?? 0);
        return orderA - orderB;
      })
  ), [config]);
  const [activeModuleName, setActiveModuleName] = useState('');
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const normalizedRole = String(operatorRole || 'operario').toLowerCase();
  const pageSize = isLeftPanelOpen ? 9 : 18;
  const totalPages = Math.max(1, Math.ceil(moduleEntries.length / pageSize));

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages - 1));
  }, [totalPages]);

  const visibleModuleEntries = useMemo(() => (
    moduleEntries.slice(currentPage * pageSize, currentPage * pageSize + pageSize)
  ), [currentPage, moduleEntries, pageSize]);

  const pageSlots = useMemo(() => (
    Array.from({ length: pageSize }, (_, index) => visibleModuleEntries[index] ?? null)
  ), [pageSize, visibleModuleEntries]);

  useEffect(() => {
    if (!moduleEntries.length) return;
    if (!activeModuleName || !moduleEntries.some(([name]) => name === activeModuleName)) {
      setActiveModuleName(moduleEntries[0][0]);
    }
  }, [activeModuleName, moduleEntries]);

  const activeModule = moduleEntries.find(([name]) => name === activeModuleName) ?? moduleEntries[0];

  if (config.length === 0) {
    return (
      <section className="empty-state">
        <h2>No hay configuracion local</h2>
        <p>Cuando la tablet tenga conexion, la app descargara la configuracion desde Supabase.</p>
      </section>
    );
  }

  return (
    <section className="warehouse-screen split-layout">
      <button
        className={`panel-collapse-toggle panel-collapse-toggle--minimal ${isLeftPanelOpen ? 'is-open' : 'is-closed'}`}
        type="button"
        onClick={() => setIsLeftPanelOpen((value) => !value)}
        aria-label={isLeftPanelOpen ? 'Ocultar estanteria principal' : 'Mostrar estanteria principal'}
        title={isLeftPanelOpen ? 'Ocultar estanteria principal' : 'Mostrar estanteria principal'}
        style={{
          left: isLeftPanelOpen ? 'calc(50% - 12px)' : '0px'
        }}
      >
        <span>{isLeftPanelOpen ? '<' : '>'}</span>
      </button>

      <div className={`active-module-area ${isLeftPanelOpen ? 'open' : 'collapsed'}`}>
        <div className="active-module-stage">
          {activeModule ? (
            <ModulePanel
              moduleName={activeModule[0]}
              shelves={activeModule[1]}
              estadosById={estadosById}
              operatorRole={normalizedRole}
              viewMode={viewMode}
              pickLightStates={pickLightStates}
            />
          ) : null}
        </div>
      </div>

      <aside className={`modules-overview ${isLeftPanelOpen ? 'with-sidebar' : 'expanded'}`} aria-label="Vista general de modulos">
        <div className={`modules-overview-grid ${isLeftPanelOpen ? 'grid-open' : 'grid-collapsed'}`}>
          {pageSlots.map((entry, index) => {
            if (!entry) {
              return (
                <div className="overview-module overview-module-placeholder" key={`module-slot-${currentPage}-${index}`} aria-hidden="true" />
              );
            }

            const [moduleName, shelves] = entry;
            return (
              <button
                className={`overview-module ${moduleName === activeModuleName ? 'active' : ''}`}
                key={moduleName}
                type="button"
                onClick={() => {
                  setIsLeftPanelOpen(true);
                  setActiveModuleName(moduleName);
                }}
              >
                <strong>
                  <span>{moduleName}</span>
                </strong>
                <ModulePanel
                  moduleName={moduleName}
                  shelves={shelves}
                  estadosById={estadosById}
                  operatorRole={normalizedRole}
                  viewMode={viewMode}
                  pickLightStates={pickLightStates}
                  compact
                />
              </button>
            );
          })}
        </div>

        <div className="modules-pagination" aria-label="Paginacion de modulos">
          <button
            className="modules-pagination-button"
            type="button"
            onClick={() => setCurrentPage((page) => Math.max(0, page - 1))}
            disabled={currentPage === 0}
          >
            &lt; Anterior
          </button>
          <div className="modules-pagination-dots" aria-hidden="true">
            {Array.from({ length: totalPages }, (_, index) => (
              <span
                className={index === currentPage ? 'active' : ''}
                key={`page-dot-${index}`}
              />
            ))}
          </div>
          <button
            className="modules-pagination-button"
            type="button"
            onClick={() => setCurrentPage((page) => Math.min(totalPages - 1, page + 1))}
            disabled={currentPage >= totalPages - 1}
          >
            Siguiente &gt;
          </button>
        </div>
      </aside>
    </section>
  );
}
