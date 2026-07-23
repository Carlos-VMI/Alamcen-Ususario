import { BaldaCard } from './BaldaCard';

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] = groups[key] ?? [];
    groups[key].push(item);
    return groups;
  }, {});
}

export function WarehouseView({ config, estados, operatorRole = 'operario', viewMode = 'estado' }) {
  const estadosById = new Map(estados.map((estado) => [estado.id_balda, estado.estado]));
  const modules = groupBy(config, (row) => row.modulo || 'Modulo 1');
  const normalizedRole = String(operatorRole || 'operario').toLowerCase();

  if (config.length === 0) {
    return (
      <section className="empty-state">
        <h2>No hay configuracion local</h2>
        <p>Cuando la tablet tenga conexion, la app descargara la configuracion desde Supabase.</p>
      </section>
    );
  }

  return (
    <section className="warehouse-screen">
      <div className="warehouse-view">
      {Object.entries(modules).map(([moduleName, shelves]) => {
        const rows = groupBy(shelves, (row) => row.estante);
        return (
          <div className="module-panel" key={moduleName}>
            <h2>{moduleName}</h2>
            {Array.from({ length: 8 }, (_, index) => {
              const rowNumber = String(index + 1);
              const rowShelves = rows[rowNumber] ?? rows[index + 1] ?? [];
              const sortedShelves = [...rowShelves].sort((a, b) => Number(a.posicion) - Number(b.posicion));
              return (
              <div className="shelf-row" key={`${moduleName}-${rowNumber}`}>
                <span className="row-label">{rowNumber}</span>
                <div
                  className="shelf-cells"
                  style={{
                    gridTemplateColumns: sortedShelves.length
                      ? `repeat(${sortedShelves.length}, minmax(0, 1fr))`
                      : '1fr'
                  }}
                >
                  {sortedShelves
                    .map((balda) => (
                      <BaldaCard
                        key={balda.id}
                        balda={balda}
                        estadosById={estadosById}
                        operatorRole={normalizedRole}
                        viewMode={viewMode}
                      />
                    ))}
                  {sortedShelves.length === 0 && <span className="empty-row">Sin baldas configuradas</span>}
                </div>
              </div>
            );
            })}
          </div>
        );
      })}
      </div>
    </section>
  );
}
