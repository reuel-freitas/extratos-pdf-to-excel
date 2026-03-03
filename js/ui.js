// DOM refs
export const els = {
  dropZone:   document.getElementById('drop-zone'),
  fileInput:  document.getElementById('file-input'),
  loading:    document.getElementById('loading'),
  infoBar:    document.getElementById('info-bar'),
  warnBar:    document.getElementById('warn-bar'),
  errorBar:   document.getElementById('error-bar'),
  badgeCont:  document.getElementById('bank-badge-container'),
  tableWrap:  document.getElementById('table-wrapper'),
  tableBody:  document.getElementById('table-body'),
  actions:    document.getElementById('actions'),
};

export const show = (el, display = 'block') => { el.style.display = display; };
export const hide = (...els) => els.forEach(el => { el.style.display = 'none'; });

export function showError(msg) {
  els.errorBar.textContent = msg;
  show(els.errorBar);
  hide(els.loading);
  show(els.dropZone);
}

export function renderTable(transactions) {
  els.tableBody.innerHTML = transactions.map(t => `
    <tr>
      <td>${fmtDate(t)}</td>
      <td>${esc(t.description)}</td>
      <td class="code-525">${t.col525credit !== null ? '525' : ''}</td>
      <td class="code-525">${t.col525debit  !== null ? '525' : ''}</td>
      <td class="${t.value >= 0 ? 'val-positive' : 'val-negative'}">${formatBR(t.value)}</td>
    </tr>`).join('');
}

export function formatBR(n) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// -- Private helpers --

function fmtDate(t) {
  return `${String(t.day).padStart(2,'0')}/${String(t.month).padStart(2,'0')}/${t.year}`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
