import { syncService } from '../lib/syncService';

export function BaldaCard({ balda, estado, operatorRole = 'operario' }) {
  const currentState = estado || 'lleno';
  const isFull = currentState === 'lleno';
  const isEmpty = currentState === 'vacio';
  const isOrdered = currentState === 'pedido';
  const hasArticle = Boolean(balda.sku);
  const isRepositor = operatorRole === 'repositor';
  const suffixLabel = balda.sufijo || String(balda.posicion).padStart(2, '0');
  const locationLabel = `E${balda.estante} ${balda.etiqueta_balda ?? `C${balda.posicion}`}`;

  const setState = async (nextState) => {
    await syncService.updateShelfState(balda.id, nextState);
  };

  const handleClick = async () => {
    if (!hasArticle) return;
    if (isOrdered && !isRepositor) return;
    if (isOrdered && isRepositor) {
      await setState('lleno');
      return;
    }
    await setState(isEmpty ? 'lleno' : 'vacio');
  };

  return (
    <button
      className={`balda-card ${currentState} ${hasArticle ? 'assigned' : 'unassigned'}`}
      type="button"
      onClick={handleClick}
      disabled={!hasArticle || (isOrdered && !isRepositor)}
      title={isOrdered && !isRepositor ? 'Pedido bloqueado hasta reposicion' : undefined}
    >
      <div className="balda-heading">
        <strong>{balda.sku || 'Libre'}</strong>
        <small>{locationLabel}</small>
      </div>
      <p>{balda.descripcion || 'Sin articulo configurado'}</p>
      <div className="balda-meta">
        <span>{isFull ? 'Lleno' : isOrdered ? 'Pedido' : 'Vacio'}</span>
        <span>Cap. {balda.capacidad || 0}</span>
      </div>
      <span className="balda-suffix">{suffixLabel}</span>
    </button>
  );
}
