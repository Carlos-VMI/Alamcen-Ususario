function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      return jsonResponse({ sent: false, error: 'Sin filas para enviar' });
    }

    var spreadsheet = SpreadsheetApp.create('CTD_ES_pedido_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
    var sheet = spreadsheet.getActiveSheet();
    sheet.setName('CTD_ES');

    sheet.getRange('A1').setValue('Codigo de articulo');
    sheet.getRange('B1').setValue('Referencia / Codigo de cliente');
    sheet.getRange('C1').setValue('Cantidad');
    sheet.getRange('E1').setValue('Estado');

    rows.forEach(function(row, index) {
      var targetRow = index + 2;
      sheet.getRange(targetRow, 1).setValue(row.codigo_articulo || '');
      sheet.getRange(targetRow, 2).setValue(row.codigo_cliente || '');
      sheet.getRange(targetRow, 3).setValue(Number(row.cantidad) || 0);
      sheet.getRange(targetRow, 5).setValue('PED');
    });

    SpreadsheetApp.flush();

    var exportUrl = 'https://www.googleapis.com/drive/v3/files/' + spreadsheet.getId() + '/export?mimeType=application/vnd.ms-excel';
    var blob = UrlFetchApp.fetch(exportUrl, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }
    }).getBlob().setContentType('application/vnd.ms-excel').setName('CTD_ES.xls');

    var to = data.to || 'fontagnol@hotmail.com';
    var subject = data.subject || 'Pedido de reposicion';
    var warehouseName = data.warehouse && data.warehouse.nombre ? data.warehouse.nombre : 'Almacen';
    var operatorName = data.operator && data.operator.nombre ? data.operator.nombre : 'Operario';
    var html = '<p>Pedido de reposicion generado desde ' + warehouseName + '.</p>' +
      '<p>Operario: ' + operatorName + '</p>' +
      '<p>Adjunto: CTD_ES.xls</p>';

    GmailApp.sendEmail(to, subject, 'Pedido de reposicion adjunto.', {
      htmlBody: html,
      attachments: [blob],
      replyTo: data.from || 'vmi.intelligent@gmail.com'
    });

    DriveApp.getFileById(spreadsheet.getId()).setTrashed(true);
    return jsonResponse({ sent: true, rows: rows.length });
  } catch (error) {
    return jsonResponse({ sent: false, error: String(error && error.message ? error.message : error) });
  }
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
