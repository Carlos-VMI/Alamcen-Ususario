import { BaldaCard } from './BaldaCard';
import { syncService } from '../lib/syncService';

function groupBy(items, getKey) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups[key] = groups[key] ?? [];
    groups[key].push(item);
    return groups;
  }, {});
}

export function WarehouseView({ config, estados, operatorRole = 'operario', warehouseMeta }) {
  const estadosById = new Map(estados.map((estado) => [estado.id_balda, estado.estado]));
  const modules = groupBy(config, (row) => row.modulo || 'Modulo 1');
  const pendingOrderCount = config.filter((balda) => balda.sku && estadosById.get(balda.id) === 'vacio').length;
  const normalizedRole = String(operatorRole || 'operario').toLowerCase();
  const roleLabel = normalizedRole === 'administrador' ? 'Administrador' : normalizedRole === 'repositor' ? 'Repositor' : 'Operario';

  const handlePedido = async () => {
    await syncService.markEmptyShelvesAsOrdered(config, estadosById);
  };

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
      <div className="warehouse-toolbar">
        <div>
          <h2>{warehouseMeta?.nombre || 'Estado estanterias'}</h2>
          <p>
            {warehouseMeta?.ubicacion ? `${warehouseMeta.ubicacion} - ` : ''}
            Rol {roleLabel}
          </p>
        </div>
        <button className="pedido-button" type="button" onClick={handlePedido} disabled={pendingOrderCount === 0}>
          Pedido
          {pendingOrderCount > 0 ? <span>{pendingOrderCount}</span> : null}
        </button>
      </div>

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
                        estado={estadosById.get(balda.id)}
                        operatorRole={normalizedRole}
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
