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
  const locationLabel = balda.codigo_ubicacion || `M?E${balda.estante}C${balda.posicion}`;
  const itemSku = balda.sku || balda.sku_base || locationLabel;

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

  if (viewMode === 'items') {
    return (
      <article className={`sku-cell item-card ${hasArticle ? 'assigned' : 'unassigned'}`}>
        <div className="item-card-head">
          <strong>{hasArticle ? itemSku : locationLabel}</strong>
          <span className={`item-status-dot ${hasArticle ? 'assigned' : 'unassigned'}`} aria-label={hasArticle ? 'Con material' : 'Libre'} />
        </div>
        <div className="item-card-body">
          <small>{balda.descripcion || 'Sin articulo configurado'}</small>
          <em>Cap. {balda.capacidad || 0}</em>
        </div>
      </article>
    );
  }

  return (
    <article className={`sku-cell ${hasArticle ? 'assigned' : 'unassigned'} ${viewMode}`}>
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
              <strong>{suffix}</strong>
              <small>{stateLabel(currentState)}</small>
              <em>{cubeta.capacidad || 0}</em>
            </button>
          );
        })}
      </div>
    </article>
  );
}
