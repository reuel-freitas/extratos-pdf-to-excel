import * as XLSX from 'xlsx';

export function downloadExcel(transactions, fileName) {
  const data = transactions.map(t => [
    t.excelDate, t.description, t.col525credit, t.col525debit, t.value,
  ]);
  const ws = XLSX.utils.aoa_to_sheet(data);

  for (let i = 0; i < data.length; i++) {
    const cell = col => ws[XLSX.utils.encode_cell({ r: i, c: col })];
    if (cell(0)) cell(0).z = 'dd/mm/yyyy';
    if (cell(4)) cell(4).z = '#,##0.00';
  }

  ws['!cols'] = [{ wch: 12 }, { wch: 60 }, { wch: 8 }, { wch: 8 }, { wch: 15 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Planilha1');
  XLSX.writeFile(wb, `${fileName}.xlsx`);
}
