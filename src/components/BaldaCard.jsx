import { Bell, CheckCircle2, PackageOpen } from 'lucide-react';
import { syncService } from '../lib/syncService';

export function BaldaCard({ balda, estado = 'vacio' }) {
  const isFull = estado === 'lleno';
  const hasArticle = Boolean(balda.sku);
  const locationLabel = `${balda.modulo} E${balda.estante} ${balda.etiqueta_balda ?? `C${balda.posicion}`}`;

  const setState = async (nextState) => {
    await syncService.updateShelfState(balda.id, nextState);
  };

  const handleReposition = async () => {
    await syncService.requestReposition(balda);
  };

  return (
    <article className={`balda-card ${isFull ? 'full' : 'empty'} ${hasArticle ? 'assigned' : 'unassigned'}`}>
      <div className="balda-heading">
        <strong>{balda.sku || 'Libre'}</strong>
        <small>{locationLabel}</small>
      </div>
      <p>{balda.descripcion || 'Sin articulo configurado'}</p>
      <div className="balda-meta">
        <span>{balda.sufijo ? `Sufijo ${balda.sufijo}` : 'Sin sufijo'}</span>
        <span>Cap. {balda.capacidad || 0}</span>
      </div>
      <div className="balda-actions">
        <button type="button" onClick={() => setState('lleno')} aria-pressed={isFull}>
          <CheckCircle2 size={17} />
          Lleno
        </button>
        <button type="button" onClick={() => setState('vacio')} aria-pressed={!isFull}>
          <PackageOpen size={17} />
          Vacio
        </button>
      </div>
      {!isFull && hasArticle && (
        <button className="reposition-button" type="button" onClick={handleReposition}>
          <Bell size={16} />
          Reposicion
        </button>
      )}
    </article>
  );
}
