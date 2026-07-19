import { Bell, CheckCircle2, PackageOpen } from 'lucide-react';
import { syncService } from '../lib/syncService';

export function BaldaCard({ balda, estado = 'vacio' }) {
  const isFull = estado === 'lleno';

  const setState = async (nextState) => {
    await syncService.updateShelfState(balda.id, nextState);
  };

  const handleReposition = async () => {
    await syncService.requestReposition(balda);
  };

  return (
    <article className={`balda-card ${isFull ? 'full' : 'empty'}`}>
      <div className="balda-heading">
        <strong>{balda.sku || 'Sin SKU'}</strong>
        <small>{balda.modulo}E{balda.estante}P{balda.posicion}</small>
      </div>
      <p>{balda.descripcion || 'Balda sin articulo configurado'}</p>
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
      {!isFull && balda.sku && (
        <button className="reposition-button" type="button" onClick={handleReposition}>
          <Bell size={16} />
          Reposicion
        </button>
      )}
    </article>
  );
}
