import { db } from './db';
import { supabase } from './supabaseClient';

const pedidoScriptUrl = import.meta.env.VITE_PEDIDO_SCRIPT_URL;

function isActiveRecipient(row) {
  const value = row?.activo;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return !['false', '0', 'bloqueado', 'blocked', 'inactivo', 'inactive'].includes(normalized);
  }
  return true;
}

function isReposicionRecipient(row) {
  const category = String(row?.categoria || 'reposicion').trim().toLowerCase();
  return category === 'reposicion';
}

function normalizeRecipients(rows) {
  return Array.from(new Set(
    (rows || [])
      .filter((row) => isActiveRecipient(row) && isReposicionRecipient(row))
      .map((row) => String(row.email || row.correo || row.notificacion_reposicion_email || '').trim().toLowerCase())
      .filter(Boolean)
  ));
}

async function readLocalRecipients(warehouseId) {
  if (!warehouseId) return [];

  const emails = await db.almacen_notificacion_emails
    .where('almacen_id')
    .equals(warehouseId)
    .toArray();

  return normalizeRecipients(emails);
}

async function fetchRemoteRecipients(warehouseId) {
  if (!warehouseId || !navigator.onLine) return [];

  const { data, error } = await supabase
    .from('almacen_notificacion_emails')
    .select('*')
    .eq('almacen_id', warehouseId);

  if (error) {
    console.warn('[Pedido] No se pudieron leer correos de reposicion desde Supabase', error);
    return [];
  }

  if (Array.isArray(data)) {
    await db.transaction('rw', db.almacen_notificacion_emails, async () => {
      await db.almacen_notificacion_emails
        .where('almacen_id')
        .equals(warehouseId)
        .and((row) => isReposicionRecipient(row))
        .delete();
      if (data.length) await db.almacen_notificacion_emails.bulkPut(data);
    });
  }

  return normalizeRecipients(data);
}

async function readLegacyRecipient(warehouseId) {
  if (!warehouseId) return [];

  const settings = await db.almacen_configuracion.get(warehouseId);
  const localEmail = String(settings?.notificacion_reposicion_email || '').trim().toLowerCase();
  if (localEmail) return [localEmail];

  if (!navigator.onLine) return [];

  const { data, error } = await supabase
    .from('almacen_configuracion')
    .select('almacen_id, notificacion_reposicion_email, updated_at')
    .eq('almacen_id', warehouseId)
    .maybeSingle();

  if (error) {
    console.warn('[Pedido] No se pudo leer configuracion legacy de reposicion', error);
    return [];
  }

  if (data?.almacen_id) {
    await db.almacen_configuracion.put(data);
  }

  const remoteEmail = String(data?.notificacion_reposicion_email || '').trim().toLowerCase();
  return remoteEmail ? [remoteEmail] : [];
}

async function getNotificationRecipients(warehouse) {
  const warehouseId = warehouse?.id || warehouse?.almacen_id;
  if (!warehouseId) {
    throw new Error('No se pudo identificar el almacen activo para leer correos de reposicion');
  }

  try {
    const localRecipients = await readLocalRecipients(warehouseId);
    if (localRecipients.length) return localRecipients.join(',');

    const remoteRecipients = await fetchRemoteRecipients(warehouseId);
    if (remoteRecipients.length) return remoteRecipients.join(',');

    const legacyRecipients = await readLegacyRecipient(warehouseId);
    if (legacyRecipients.length) return legacyRecipients.join(',');
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

  console.info('[Pedido] Enviando correo de reposicion', {
    pedidoId,
    destinatarios: recipients,
    filas: rows.length
  });

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
    throw new Error(data?.error || data?.raw || `Error enviando pedido (${response.status})`);
  }

  if (!data?.sent) {
    throw new Error(data?.reason || 'Apps Script no confirmo el envio del pedido');
  }

  console.info('[Pedido] Correo confirmado', data);
  return data;
}
