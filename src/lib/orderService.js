const pedidoScriptUrl = import.meta.env.VITE_PEDIDO_SCRIPT_URL;

async function getNotificationRecipients(warehouse) {
  try {
    const { db } = await import('./db');
    const emails = warehouse?.id
      ? await db.almacen_notificacion_emails.where('almacen_id').equals(warehouse.id).toArray()
      : [];
    const recipients = emails
      .filter((row) => row.activo !== false && (!row.categoria || String(row.categoria).toLowerCase() === 'reposicion'))
      .map((row) => String(row.email || '').trim())
      .filter(Boolean);

    if (recipients.length) return Array.from(new Set(recipients.map((email) => email.toLowerCase()))).join(',');

    const settings = warehouse?.id ? await db.almacen_configuracion.get(warehouse.id) : null;
    const legacyRecipient = String(settings?.notificacion_reposicion_email || '').trim();
    if (legacyRecipient) return legacyRecipient;
  } catch (error) {
    console.warn('No se pudieron leer los destinatarios de reposicion', error);
  }

  throw new Error('No hay correos activos de reposicion configurados para este almacen');
}

export function buildPedidoRows(shelves, statesById) {
  return shelves
    .flatMap((shelf) => (shelf.cubetas?.length ? shelf.cubetas : [shelf]))
    .filter((cubeta) => cubeta.sku && statesById.get(cubeta.id) === 'vacio')
    .map((cubeta) => ({
      id_balda: cubeta.id,
      codigo_articulo: cubeta.codigo_articulo || cubeta.sku_base || cubeta.sku || '',
      codigo_cliente: cubeta.codigo_cliente || '',
      cantidad: Number(cubeta.capacidad) || 0,
      estado: 'PED',
      sku: cubeta.sku || '',
      descripcion: cubeta.descripcion || '',
      ubicacion: cubeta.codigo_ubicacion || cubeta.ubicacion || ''
    }));
}

export async function sendPedidoEmail({ rows, warehouse, operator, pedidoId }) {
  if (!rows.length) return { sent: false, reason: 'empty' };
  if (!pedidoScriptUrl) throw new Error('Falta configurar VITE_PEDIDO_SCRIPT_URL');
  if (pedidoScriptUrl.includes('api.example.com')) {
    throw new Error('VITE_PEDIDO_SCRIPT_URL apunta a api.example.com; configura la URL real de Google Apps Script');
  }

  const to = await getNotificationRecipients(warehouse);
  const recipients = Array.from(new Set(
    String(to)
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  ));

  const response = await fetch(pedidoScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      type: 'pedido_reposicion',
      pedido_id: pedidoId,
      from: 'vmi.intelligent@gmail.com',
      to: recipients.join(','),
      recipients,
      subject: `Pedido de reposicion - ${warehouse?.nombre || 'Almacen'}`,
      warehouse,
      operator,
      rows
    })
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data?.error) {
    if (String(data?.error || '').toLowerCase().includes('pedido en proceso')) {
      return { sent: false, duplicate: true, processing: true, pedido_id: pedidoId };
    }
    throw new Error(data?.error || `Error enviando pedido (${response.status})`);
  }

  return data || { sent: true };
}
