function doPost(e) {
  var cacheKey = '';
  var fingerprintCacheKey = '';
  var cache = null;

  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      return jsonResponse({ sent: false, error: 'Sin filas para enviar' });
    }

    var pedidoId = String(data.pedido_id || '').trim();
    var pedidoFingerprint = String(data.pedido_fingerprint || '').trim();
    cache = CacheService.getScriptCache();
    var properties = PropertiesService.getScriptProperties();
    cacheKey = pedidoId ? 'pedido_enviado_' + pedidoId : '';
    fingerprintCacheKey = pedidoFingerprint ? 'pedido_fingerprint_' + pedidoFingerprint : '';
    var propertyKey = pedidoId ? 'pedido_enviado_' + pedidoId : '';

    if (propertyKey && properties.getProperty(propertyKey) === 'sent') {
      return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
    }

    var cachedState = cacheKey ? cache.get(cacheKey) : '';
    var fingerprintState = fingerprintCacheKey ? cache.get(fingerprintCacheKey) : '';
    if (fingerprintState === 'sent') {
      return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
    }
    if (fingerprintState === 'processing') {
      return jsonResponse({ sent: false, processing: true, error: 'Pedido en proceso' });
    }
    if (cachedState === 'sent') {
      return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
    }
    if (cachedState === 'processing') {
      return jsonResponse({ sent: false, processing: true, error: 'Pedido en proceso' });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (propertyKey && properties.getProperty(propertyKey) === 'sent') {
        return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
      }
      cachedState = cacheKey ? cache.get(cacheKey) : '';
      fingerprintState = fingerprintCacheKey ? cache.get(fingerprintCacheKey) : '';
      if (fingerprintState === 'sent') {
        return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
      }
      if (fingerprintState === 'processing') {
        return jsonResponse({ sent: false, processing: true, error: 'Pedido en proceso' });
      }
      if (cachedState === 'sent') {
        return jsonResponse({ sent: true, duplicate: true, rows: rows.length });
      }
      if (cachedState === 'processing') {
        return jsonResponse({ sent: false, processing: true, error: 'Pedido en proceso' });
      }
      if (cacheKey) {
        cache.put(cacheKey, 'processing', 600);
      }
      if (fingerprintCacheKey) {
        cache.put(fingerprintCacheKey, 'processing', 180);
      }
    } finally {
      lock.releaseLock();
    }

    var to = normalizeRecipients(data.to || data.recipients);
    if (!to) {
      throw new Error('Pedido sin destinatarios de reposicion configurados');
    }

    var blob = buildXlsBlob(rows);
    var subject = data.subject || 'Pedido de reposicion';
    var warehouseName = data.warehouse && data.warehouse.nombre ? data.warehouse.nombre : 'Almacen';
    var operatorName = data.operator && data.operator.nombre ? data.operator.nombre : 'Operario';
    var html = '<p>Pedido de reposicion generado desde ' + escapeHtml(warehouseName) + '.</p>' +
      '<p>Operario: ' + escapeHtml(operatorName) + '</p>' +
      '<p>Adjunto: CTD_ES.xls</p>';

    GmailApp.sendEmail(to, subject, 'Pedido de reposicion adjunto.', {
      htmlBody: html,
      attachments: [blob],
      replyTo: data.from || 'vmi.intelligent@gmail.com'
    });

    if (cacheKey) {
      cache.put(cacheKey, 'sent', 21600);
    }
    if (fingerprintCacheKey) {
      cache.put(fingerprintCacheKey, 'sent', 180);
    }
    if (propertyKey) {
      properties.setProperty(propertyKey, 'sent');
    }

    return jsonResponse({ sent: true, pedido_id: pedidoId, rows: rows.length, to: to });
  } catch (error) {
    if (cacheKey && cache) {
      cache.remove(cacheKey);
    }
    if (fingerprintCacheKey && cache) {
      cache.remove(fingerprintCacheKey);
    }
    return jsonResponse({ sent: false, error: String(error && error.message ? error.message : error) });
  }
}

function buildXlsBlob(rows) {
  var html = [
    '<html>',
    '<head>',
    '<meta charset="UTF-8">',
    '<style>',
    'table{border-collapse:collapse;}',
    'td,th{border:1px solid #999;padding:4px;mso-number-format:"\\@";}',
    '</style>',
    '</head>',
    '<body>',
    '<table>',
    '<tr>',
    '<th>Codigo de articulo</th>',
    '<th>Referencia / Codigo de cliente</th>',
    '<th>Cantidad</th>',
    '<th></th>',
    '<th>Estado</th>',
    '</tr>'
  ];

  rows.forEach(function(row) {
    html.push(
      '<tr>' +
      '<td>' + escapeHtml(row.codigo_articulo || '') + '</td>' +
      '<td>' + escapeHtml(row.codigo_cliente || '') + '</td>' +
      '<td>' + escapeHtml(Number(row.cantidad) || 0) + '</td>' +
      '<td></td>' +
      '<td>PED</td>' +
      '</tr>'
    );
  });

  html.push('</table>', '</body>', '</html>');

  return Utilities
    .newBlob(html.join(''), 'application/vnd.ms-excel', 'CTD_ES.xls')
    .setContentType('application/vnd.ms-excel');
}

function normalizeRecipients(value) {
  var input = Array.isArray(value) ? value.join(',') : String(value || '');
  var seen = {};
  var recipients = [];

  input.split(',').forEach(function(email) {
    var normalized = String(email || '').trim().toLowerCase();
    if (normalized && !seen[normalized]) {
      seen[normalized] = true;
      recipients.push(normalized);
    }
  });

  return recipients.join(',');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
