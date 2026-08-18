const pedidoScriptUrl = import.meta.env.VITE_PEDIDO_SCRIPT_URL;
const fallbackNotificationEmail = 'fontagnol@hotmail.com';

async function getNotificationRecipients(warehouse) {
  try {
    const { db } = await import('./db');
    const emails = warehouse?.id
      ? await db.almacen_notificacion_emails.where('almacen_id').equals(warehouse.id).toArray()
      : [];
    const recipients = emails
      .filter((row) => !row.categoria || row.categoria === 'reposicion')
      .map((row) => String(row.email || '').trim())
      .filter(Boolean);

    if (recipients.length) return recipients.join(',');

    const settings = warehouse?.id ? await db.almacen_configuracion.get(warehouse.id) : null;
    return settings?.notificacion_reposicion_email || fallbackNotificationEmail;
  } catch {
    return fallbackNotificationEmail;
  }
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

export async function sendPedidoEmail({ rows, warehouse, operator }) {
  if (!rows.length) return { sent: false, reason: 'empty' };
  if (!pedidoScriptUrl) throw new Error('Falta configurar VITE_PEDIDO_SCRIPT_URL');

  const to = await getNotificationRecipients(warehouse);

  const response = await fetch(pedidoScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      type: 'pedido_reposicion',
      from: 'vmi.intelligent@gmail.com',
      to,
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
    throw new Error(data?.error || `Error enviando pedido (${response.status})`);
  }

  return data || { sent: true };
}
