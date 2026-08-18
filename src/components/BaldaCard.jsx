import { syncService } from '../lib/syncService';

function stateLabel(state) {
  if (state === 'pendiente') return 'Pendiente';
  if (state === 'pedido') return 'Pedido';
  if (state === 'vacio') return 'Vacio';
  return 'Lleno';
}

function getStateRow(estadosById, id) {
  const value = estadosById.get(id);
  if (!value || typeof value === 'string') {
    return { estado: value || 'lleno', pending_sync: false };
  }
  return {
    estado: value.estado || 'lleno',
    pending_sync: Boolean(value.pending_sync)
  };
}

export function BaldaCard({ balda, estadosById, operatorRole = 'operario', viewMode = 'estado', pickLightStates = {} }) {
  if (balda.is_free_space) {
    return <article className={`sku-cell structural-free-space ${viewMode}`} aria-hidden="true" />;
  }

  const cubetas = balda.cubetas?.length ? balda.cubetas : [balda];
  const hasArticle = cubetas.some((cubeta) => Boolean(cubeta.sku));
  const normalizedRole = String(operatorRole || 'operario').toLowerCase();
  const canReplenish = normalizedRole === 'repositor' || normalizedRole === 'administrador' || normalizedRole === 'admin';
  const locationLabel = balda.codigo_ubicacion || `M?E${balda.estante}C${balda.posicion}`;
  const itemSku = balda.sku || balda.sku_base || locationLabel;
  const parentPickLightState = pickLightStates[balda.id] || 'off';

  const handleCubetaClick = async (cubeta) => {
    if (!cubeta.sku) return;

    const { estado: currentState, pending_sync: pendingSync } = getStateRow(estadosById, cubeta.id);
    if (pendingSync) return;
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
          <strong className={hasArticle ? '' : 'empty-location'}>{hasArticle ? itemSku : locationLabel}</strong>
          <span className={`item-status-dot ${hasArticle ? 'assigned' : 'unassigned'}`} aria-label={hasArticle ? 'Con material' : 'Libre'} />
        </div>
        {hasArticle ? (
          <div className="item-card-body">
            <small>{balda.descripcion}</small>
            <em>Cap. {balda.capacidad || 0}</em>
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <article className={`sku-cell ${hasArticle ? 'assigned' : 'unassigned'} ${cubetas.length > 1 ? 'shared-sku' : ''} pick-parent-${parentPickLightState} ${viewMode}`}>
      <div
        className="cubeta-grid"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, cubetas.length)}, minmax(0, 1fr))` }}
      >
        {cubetas.map((cubeta, index) => {
          const { estado: storedState, pending_sync: pendingSync } = getStateRow(estadosById, cubeta.id);
          const currentState = pendingSync ? 'pendiente' : storedState;
          const disabled = !cubeta.sku || pendingSync || (storedState === 'pedido' && !canReplenish);
          const suffix = cubeta.sufijo || String(index + 1).padStart(2, '0');

          return (
            <button
              className={`cubeta-card ${currentState} ${cubeta.sku ? 'assigned' : 'unassigned'}`}
              key={cubeta.id}
              type="button"
              onClick={() => handleCubetaClick(cubeta)}
              disabled={disabled}
              title={pendingSync ? 'Pedido pendiente de conexión' : disabled && storedState === 'pedido' ? 'Pedido bloqueado hasta reposicion' : undefined}
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
