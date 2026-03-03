import { extractText, detectBank, parseTransactions, BANK_NAMES } from './parser.js';
import { els, show, hide, showError, renderTable, formatBR } from './ui.js';
import { downloadExcel } from './excel.js';

// State
let currentTransactions = [];
let currentFileName = '';

// Events
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.dropZone.addEventListener('dragover', e => { e.preventDefault(); els.dropZone.classList.add('dragover'); });
els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
els.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  els.dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file?.type === 'application/pdf') processFile(file);
  else showError('Por favor, selecione um arquivo PDF.');
});
els.fileInput.addEventListener('change', () => { if (els.fileInput.files[0]) processFile(els.fileInput.files[0]); });
document.getElementById('btn-download').addEventListener('click', () => downloadExcel(currentTransactions, currentFileName));
document.getElementById('btn-reset').addEventListener('click', resetUI);

function resetUI() {
  currentTransactions = [];
  els.tableBody.innerHTML = '';
  els.badgeCont.innerHTML = '';
  hide(els.tableWrap, els.actions, els.infoBar, els.warnBar, els.errorBar, els.loading);
  show(els.dropZone);
  els.fileInput.value = '';
}

async function processFile(file) {
  resetUI();
  currentFileName = file.name.replace(/\.pdf$/i, '');
  show(els.loading);
  hide(els.dropZone);

  try {
    const text = await extractText(new Uint8Array(await file.arrayBuffer()));
    const bank = detectBank(text);
    const result = parseTransactions(text, bank);
    currentTransactions = result.transactions;

    if (currentTransactions.length === 0) {
      showError('Nenhum lancamento encontrado neste PDF. Verifique se o arquivo e um extrato bancario com movimentacoes.');
      return;
    }

    const bankName = BANK_NAMES[bank] ?? 'Banco nao identificado';
    els.badgeCont.innerHTML = `<div class="bank-badge">${bankName}</div>`;

    if (result.hadInferredSign) {
      els.warnBar.innerHTML = 'Alguns valores nao tinham indicador C/D ou +/-. O sinal foi inferido pela descricao. <strong>Confira os valores na tabela.</strong>';
      show(els.warnBar);
    }

    renderTable(currentTransactions);

    const totalC = currentTransactions.filter(t => t.value > 0).reduce((s, t) => s + t.value, 0);
    const totalD = currentTransactions.filter(t => t.value < 0).reduce((s, t) => s + t.value, 0);
    els.infoBar.innerHTML =
      `<strong>${currentTransactions.length}</strong> lancamentos &mdash; ` +
      `Creditos: <strong style="color:#2e7d32">R$ ${formatBR(totalC)}</strong> &nbsp;|&nbsp; ` +
      `Debitos: <strong style="color:#c62828">R$ ${formatBR(totalD)}</strong>`;
    show(els.infoBar);
    show(els.tableWrap);
    show(els.actions, 'flex');

  } catch (err) {
    showError('Erro ao processar o PDF: ' + err.message);
  } finally {
    hide(els.loading);
  }
}
