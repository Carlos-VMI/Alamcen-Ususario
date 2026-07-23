import { syncService } from '../lib/syncService';

function stateLabel(state) {
  if (state === 'pedido') return 'Pedido';
  if (state === 'vacio') return 'Vacio';
  return 'Lleno';
}

export function BaldaCard({ balda, estadosById, operatorRole = 'operario', viewMode = 'estado' }) {
  const cubetas = balda.cubetas?.length ? balda.cubetas : [balda];
  const hasArticle = cubetas.some((cubeta) => Boolean(cubeta.sku));
  const normalizedRole = String(operatorRole || 'operario').toLowerCase();
  const canReplenish = normalizedRole === 'repositor' || normalizedRole === 'administrador' || normalizedRole === 'admin';
  const locationLabel = `E${balda.estante} ${balda.etiqueta_balda ?? `C${balda.posicion}`}`;

  const handleCubetaClick = async (cubeta) => {
    if (!cubeta.sku) return;

    const currentState = estadosById.get(cubeta.id) || 'lleno';
    if (currentState === 'pedido' && !canReplenish) return;
    if (currentState === 'pedido' && canReplenish) {
      await syncService.updateShelfState(cubeta.id, 'lleno');
      return;
    }

    await syncService.updateShelfState(cubeta.id, currentState === 'vacio' ? 'lleno' : 'vacio');
  };

  return (
    <article className={`sku-cell ${hasArticle ? 'assigned' : 'unassigned'} ${viewMode}`}>
      {viewMode === 'items' ? (
        <div className="sku-cell-head">
          <strong>{balda.sku || 'Libre'}</strong>
          <span>{locationLabel}</span>
        </div>
      ) : null}

      <div
        className="cubeta-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, cubetas.length)}, minmax(0, 1fr))` }}
      >
        {cubetas.map((cubeta, index) => {
          const currentState = estadosById.get(cubeta.id) || 'lleno';
          const disabled = !cubeta.sku || (currentState === 'pedido' && !canReplenish);
          const suffix = cubeta.sufijo || String(index + 1).padStart(2, '0');

          return (
            <button
              className={`cubeta-card ${currentState} ${cubeta.sku ? 'assigned' : 'unassigned'}`}
              key={cubeta.id}
              type="button"
              onClick={() => handleCubetaClick(cubeta)}
              disabled={disabled}
              title={disabled && currentState === 'pedido' ? 'Pedido bloqueado hasta reposicion' : undefined}
            >
              {viewMode === 'items' ? (
                <>
                  <span className="cubeta-suffix">{suffix}</span>
                  <small>{cubeta.descripcion || 'Sin articulo'}</small>
                  <em>Cap. {cubeta.capacidad || 0}</em>
                </>
              ) : (
                <>
                  <strong>{suffix}</strong>
                  <small>{stateLabel(currentState)}</small>
                  <em>{cubeta.capacidad || 0}</em>
                </>
              )}
            </button>
          );
        })}
      </div>
    </article>
  );
}
