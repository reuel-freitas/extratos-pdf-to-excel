// PDF.js setup
const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';

export async function extractText(data) {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let fullText = '';

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    // Group text items by Y coordinate (within 3px tolerance = same line)
    const rows = [];
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      const y = item.transform[5];
      const x = item.transform[4];
      let row = rows.find(r => Math.abs(r.y - y) < 3);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, str: item.str });
    }

    // Sort rows top-to-bottom (PDF Y-axis is bottom-up)
    rows.sort((a, b) => b.y - a.y);

    for (const row of rows) {
      row.items.sort((a, b) => a.x - b.x);
      fullText += row.items.map(i => i.str).join(' ') + '\n';
    }
    fullText += '\n';
  }

  return fullText;
}

// Bank detection (only looks at the first 3000 chars to avoid false positives from payee names)
export const BANK_NAMES = {
  sicoob:    'Sicoob',
  sicredi:   'Sicredi',
  bradesco:  'Bradesco',
  itau:      'Itau',
  bb:        'Banco do Brasil',
  caixa:     'Caixa Economica',
  nubank:    'Nubank',
  inter:     'Banco Inter',
  santander: 'Santander',
  safra:     'Banco Safra',
  c6:        'C6 Bank',
  original:  'Banco Original',
  banrisul:  'Banrisul',
  btg:       'BTG Pactual',
  bs2:       'Banco BS2',
};

export function detectBank(text) {
  const header = text.substring(0, 3000).toUpperCase();

  // BB doesn't put its name prominently — detect by format signature
  if (header.includes('DT. BALANCETE') || header.includes('AG. ORIGEM') ||
      header.includes('CONSULTAS - EXTRATO DE CONTA CORRENTE')) return 'bb';

  if (header.includes('SICOOB') || header.includes('SISBR'))        return 'sicoob';
  if (header.includes('SICREDI'))                                    return 'sicredi';
  // Bradesco: nome nem sempre aparece no texto (pode ser imagem); usar assinatura de formato
  if (header.includes('BRADESCO'))                                   return 'bradesco';
  if (header.includes('DCTO.') && (header.includes('CRÉDITO') || header.includes('CREDITO'))) return 'bradesco';
  if (/ITA[ÚU]/.test(header))                                       return 'itau';
  // Itaú format signature (bank name often in logo only, not in PDF text)
  if (header.includes('SALDO DISPONÍVEL EM CONTA') || header.includes('SALDO DISPONIVEL EM CONTA') ||
      header.includes('LIMITE DA CONTA CONTRATADO') ||
      header.includes('LANÇAMENTOS PERÍODO') || header.includes('LANCAMENTOS PERIODO')) return 'itau';
  if (header.includes('BANCO DO BRASIL'))                            return 'bb';
  if (/CAIXA ECON[ÔO]MICA/.test(header))                            return 'caixa';
  if (header.includes('NUBANK') || header.includes('NU PAGAMENTOS')) return 'nubank';
  if (header.includes('BANCO INTER'))                                return 'inter';
  if (header.includes('SANTANDER'))                                  return 'santander';
  if (header.includes('SAFRA'))                                      return 'safra';
  if (header.includes('C6 BANK') || header.includes('C6BANK'))      return 'c6';
  if (header.includes('ORIGINAL'))                                   return 'original';
  if (header.includes('BANRISUL'))                                   return 'banrisul';
  if (header.includes('BTG'))                                        return 'btg';
  return 'generico';
}

// Transaction parsing
export function parseTransactions(text, bank = detectBank(text)) {
  const normalized = normalizeText(text);

  if (bank === 'bradesco') return parseBradesco(normalized);

  const period    = extractPeriod(normalized);
  const transText = trimAtSummary(normalized);

  const result = parseGenericFormat(transText, period);

  // Fallback for formats where R$ values and dates are in separate text columns
  if (result.transactions.length === 0 && /R\$/.test(transText)) {
    const fallback = parseRsColumnFormat(transText);
    if (fallback) return { transactions: fallback, hadInferredSign: true };
  }

  return result;
}

// ── Private: text normalization ──────────────────────────────────────────────

const MONTHS_PT = {
  jan:'01', fev:'02', mar:'03', abr:'04', mai:'05', jun:'06',
  jul:'07', ago:'08', set:'09', out:'10', nov:'11', dez:'12',
};

function normalizeText(text) {
  // Convert Itaú dates: "DD / mmm" → "DD/MM"
  text = text.replace(
    /\b(\d{2})\s*\/\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/gi,
    (_, d, m) => `${d}/${MONTHS_PT[m.toLowerCase()]}`,
  );

  // Convert dash dates: "DD-MM-YYYY" → "DD/MM/YYYY"
  text = text.replace(/\b(\d{2})-(\d{2})-(\d{4})\b/g, '$1/$2/$3');

  return text;
}

// ── Private: generic line-based parser ───────────────────────────────────────

function parseGenericFormat(transText, period) {
  // (?<!\S) = not preceded by a non-whitespace char, so dates inside words are ignored
  const segments = transText.split(/(?<!\S)(?=\d{2}\/\d{2}(?:\/\d{2,4})?\s)/);

  const transactions = [];
  let hadInferredSign = false;

  for (const seg of segments) {
    const match = seg.match(
      /^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?\s+(.*?)\s+(?:R\$\s*)?([+-]?\s*\d{1,3}(?:\.\d{3})*,\d{2})\s*([CD+-])?\b/,
    );
    if (!match) continue;

    const day   = +match[1];
    const month = +match[2];
    let   year  = match[3] ? +match[3] : null;

    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    if (year !== null && year < 100) year += 2000;
    if (year === null) {
      year = period.startYear === period.endYear
        ? period.endYear
        : (month >= period.startMonth ? period.startYear : period.endYear);
    }

    const description = match[4].trim();
    const valueRaw    = match[5].replace(/\s/g, '');
    const indicator   = match[6];

    if (isBalanceLine(description))                                    continue;
    if (/^(DATA|HIST|VALOR|DESCRI|LAN[CÇ])/i.test(description))      continue;

    const absValue = parseBrazilianNumber(valueRaw.replace(/^[+-]/, ''));
    const { sign, inferred } = resolveSign(indicator, valueRaw, description);
    if (inferred) hadInferredSign = true;
    const signedValue = sign * absValue;

    const detail = seg.substring(match[0].length)
      .replace(/DOC\.?:\s*\S*/gi, '')
      .replace(/NR\.?:\s*\S*/gi, '')
      .replace(/^\s*-?\d{1,3}(?:\.\d{3})*,\d{2}\s*/g, '') // remove saldo no início do detail
      .replace(/\s*-?\d{1,3}(?:\.\d{3})*,\d{2}\s*$/g, '') // remove saldo no fim do detail
      .replace(/\s+/g, ' ')
      .trim();

    transactions.push({
      day, month, year,
      excelDate:    dateToExcelSerial(year, month, day),
      description:  detail ? `${description} - ${detail}` : description,
      value:        signedValue,
      col525credit: signedValue > 0 ? 525 : null,
      col525debit:  signedValue < 0 ? 525 : null,
    });
  }

  return { transactions, hadInferredSign };
}

// ── Private: fallback for column-ordered R$ format (e.g. TESTE 4) ────────────
//
// Some PDFs store columns separately in drawing order, so values appear in
// the text before the dates/descriptions. We extract them independently and
// pair by order.

function parseRsColumnFormat(text) {
  // Strip header R$ totals so we only count transaction values
  const clean = text.replace(
    /(?:Entradas|Sa[íi]das|Saldo\s+(?:inicial|final|anterior))[^\n]*R\$[^\n]*/gi, '',
  );

  // Each transaction row has TWO R$ values: [Valor, Saldo]
  const allValues = [...clean.matchAll(/R\$\s*([+-]?\d{1,3}(?:\.\d{3})*,\d{2})/g)]
    .map(m => parseBrazilianNumber(m[1]));

  // Transaction values are at even indices (Valor), odd are Saldo
  const txValues = allValues.filter((_, i) => i % 2 === 0);

  // Extract date occurrences — skip period header dates
  const allDates = [...clean.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
  const txDates  = allDates.filter(m => {
    const before = clean.substring(Math.max(0, m.index - 40), m.index);
    return !/(?:de|per[íi]odo|al|at[eé]|período)\s*$/i.test(before);
  });

  if (txDates.length === 0 || txValues.length === 0) return null;

  const transactions = [];
  const count = Math.min(txDates.length, txValues.length);

  for (let i = 0; i < count; i++) {
    const [, dayS, monthS, yearS] = txDates[i];
    const day = +dayS, month = +monthS, year = +yearS;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;

    const signedValue = txValues[i];

    // Description: text between previous date and this date
    const prev = i > 0 ? txDates[i - 1].index + txDates[i - 1][0].length : 0;
    const curr = txDates[i].index;
    const desc = clean.substring(prev, curr)
      .replace(/\d{9,}/g, '')       // strip long ID numbers
      .replace(/R\$\s*[\d.,]+/g, '') // strip R$ values
      .replace(/\s+/g, ' ')
      .trim();

    if (isBalanceLine(desc)) continue;

    transactions.push({
      day, month, year,
      excelDate:    dateToExcelSerial(year, month, day),
      description:  desc || 'Transação',
      value:        signedValue,
      col525credit: signedValue > 0 ? 525 : null,
      col525debit:  signedValue < 0 ? 525 : null,
    });
  }

  return transactions.length > 0 ? transactions : null;
}

// ── Private: Bradesco-specific parser ────────────────────────────────────────
//
// Bradesco layout (pdftotext -layout / PDF.js coordenadas):
//
//   [pre-desc linha]          <- texto puro, sem data nem valores
//   [DATA]  [espaços]  [DOCTO]  [CRÉDITO ou DÉBITO]  [SALDO]  <- linha de valores
//   [post-desc linha]         <- continuação (REM:, DES:, CONTR, etc.)
//
// A descrição é construída a partir das linhas de texto ao redor da linha de valores.

function parseBradesco(text) {
  const lines = text.split('\n');
  const transactions = [];
  let currentDate = null;
  let hadInferredSign = false;

  const moneyRe = /(-?\d{1,3}(?:\.\d{3})*,\d{2})/g;

  // "Linha de valores": número de docto (4–8 dígitos) seguido de 3+ espaços e valor monetário
  // Funciona mesmo quando há texto antes do docto (ex: "RENILDA RAMOS COSTA DOS SANTOS   1822393   1.900,00")
  const valueLineRe = /\b\d{4,8}\s{3,}-?\d{1,3}(?:\.\d{3})*,\d{2}/;

  const isDescLine = (line) => {
    const t = line.trim();
    if (!t) return false;
    if (valueLineRe.test(line)) return false;
    if (/^(Data\b|Ag[eê]ncia|Extrato\s+de|Folha\s+\d|Nome\s+do|CNPJ|Total\s+Disp)/i.test(t)) return false;
    if (/Crédito\s*\(R\$\)|Débito\s*\(R\$\)|Dcto\./i.test(t)) return false;
    if (/\bSALDO\s+(ANTERIOR|TOTAL|FINAL|INICIAL)\b/i.test(t)) return false;
    return true;
  };

  // Extrai texto da "coluna Lançamento" dentro da própria linha de valores (antes do docto)
  const inlineDesc = (line) =>
    line.replace(/^(\d{2}\/\d{2}\/\d{4})?\s+/, '')  // remove data inicial
        .replace(/\b\d{4,8}\s{3,}.*$/, '')           // remove a partir do docto
        .trim();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Atualiza data corrente
    const dateMatch = line.match(/^(\d{2}\/\d{2}\/\d{4})/);
    if (dateMatch) currentDate = dateMatch[1];

    if (!valueLineRe.test(line)) continue;

    const moneys = [...line.matchAll(moneyRe)];
    if (moneys.length < 2) continue; // precisa de valor de tx + saldo
    if (!currentDate) continue;

    // Primeiro valor = transação; último = saldo (ignorar)
    const txRaw   = moneys[0][1];
    const txValue = parseBrazilianNumber(txRaw);

    const parts = [];

    // Pré-descrição: exatamente 1 linha antes, somente se NÃO for REM:/DES: (que seria pós-desc do tx anterior)
    const prevLine = lines[i - 1] ?? '';
    if (isDescLine(prevLine) && !/^\s*(REM:|DES:)/i.test(prevLine)) {
      // Linha pode ter data + texto (ex: "12/01/2024  ESTORNO DE LANCAMENTO*")
      const text = prevLine.trim().replace(/^\d{2}\/\d{2}\/\d{4}\s+/, '');
      if (text) parts.push(text);
    }

    // Texto embutido na própria linha de valores (coluna Lançamento antes do docto)
    const inline = inlineDesc(line);
    if (inline) parts.push(inline);

    // Pós-descrição: 1 linha depois
    // Se a linha seguinte for outra linha de valores, só inclui se esta for REM:/DES:
    // (senão seria pré-desc do próximo tx, ex: "TRANSFERENCIA PIX")
    const nextLine      = lines[i + 1] ?? '';
    const lineAfterNext = lines[i + 2] ?? '';
    const nextIsValue   = valueLineRe.test(lineAfterNext);
    if (isDescLine(nextLine) && (!nextIsValue || /^\s*(REM:|DES:)/i.test(nextLine))) {
      parts.push(nextLine.trim());
    }

    const description = parts.join(' ').replace(/\s+/g, ' ').trim() || 'Transação';
    if (isBalanceLine(description)) continue;

    const [dayS, monthS, yearS] = currentDate.split('/');
    const day = +dayS, month = +monthS, year = +yearS;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;

    let signedValue;
    if (txRaw.startsWith('-')) {
      signedValue = txValue;
    } else {
      const { sign, inferred } = resolveSign(null, txRaw, description);
      signedValue = sign * Math.abs(txValue);
      if (inferred) hadInferredSign = true;
    }

    transactions.push({
      day, month, year,
      excelDate:    dateToExcelSerial(year, month, day),
      description,
      value:        signedValue,
      col525credit: signedValue > 0 ? 525 : null,
      col525debit:  signedValue < 0 ? 525 : null,
    });
  }

  return { transactions, hadInferredSign };
}

// ── Private: helpers ─────────────────────────────────────────────────────────

function isBalanceLine(description) {
  const d = description.trim();
  return /\bSALDO\s+(ANTERIOR|TOTAL|FINAL|INICIAL|DO\s+DIA|ATUAL)/i.test(d) ||
         /\bSALDO\s+TOTAL\s+DISPON/i.test(d) ||
         /^SALDO\b/i.test(d) ||                               // linha que começa com "Saldo"
         /^(Entradas?:|Sa[íi]das?:)/i.test(d) ||             // resumo de entradas/saídas
         /Saldo\s+(inicial|final)\s*:/i.test(d) ||            // sumário de saldo inicial/final
         /^DETALHE\s+DOS\s+MOVIMENTOS/i.test(d);             // cabeçalho de seção
}

function trimAtSummary(text) {
  const stopMarkers = [
    'RESUMO', 'S A L D O', 'TOTAL GERAL', 'TOTAL DO PERIODO',
    'ENCARGOS VENCIDOS', '(+) SALDO', '(=) SALDO',
    'INFORMACOES COMPLEMENTARES', 'OUTRAS INFORMACOES',
  ];
  let result = text;
  for (const marker of stopMarkers) {
    const idx = result.indexOf(marker);
    if (idx > -1 && idx > result.length * 0.2) result = result.substring(0, idx);
  }
  return result;
}

function extractPeriod(text) {
  const rangePatterns = [
    /PER[ÍI]ODO[:\s]*(\d{2})\/(\d{2})\/(\d{4})\s*[-–a]\s*(\d{2})\/(\d{2})\/(\d{4})/i,
    /[Dd]e\s*(\d{2})\/(\d{2})\/(\d{4})\s*[aà]\s*(\d{2})\/(\d{2})\/(\d{4})/,
    /(\d{2})\/(\d{2})\/(\d{4})\s*(?:[-–a]|at[eé]|al)\s*(\d{2})\/(\d{2})\/(\d{4})/,
  ];
  for (const re of rangePatterns) {
    const m = text.match(re);
    if (m) return { startMonth: +m[2], startYear: +m[3], endMonth: +m[5], endYear: +m[6] };
  }
  const single = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (single) return { startMonth: +single[2], startYear: +single[3], endMonth: +single[2], endYear: +single[3] };

  const y = new Date().getFullYear();
  return { startMonth: 1, startYear: y, endMonth: 12, endYear: y };
}

function parseBrazilianNumber(str) {
  return parseFloat(str.replace(/\./g, '').replace(',', '.'));
}

function inferSign(description) {
  const d = description.toUpperCase();

  // ── CRÉDITO (verificado PRIMEIRO para evitar falsos positivos com palavras como "PAGO") ──
  if (/\bCR[EÉ]DITO?\b|CR[EÉ]D\./.test(d))                            return  1;
  if (/\bRECEBIMENTO\b|\bRECEB\b/.test(d))                             return  1;
  if (/\bDEP[OÓ]SITO\b/.test(d))                                       return  1;
  if (/\bRENDIMENTO\b|\bREND\s+PAGO\b/.test(d))                        return  1; // deve vir antes do check "PAGO" → débito
  if (/\bESTORNO\b|\bDEVOLU[CÇ]/.test(d))                             return  1;
  if (/\bRESGATE?\b/.test(d))                                           return  1;
  if (/PIX\s*[-–]\s*RECEBIDO|PIX\s+RECEBIDO|\bPIX\s+REC\b/.test(d))  return  1;
  if (/TRANSFER[EÊ]NCIA\s+(PIX\s+)?REM:/.test(d))                      return  1; // Bradesco: REM = remetente (entrada)
  if (/TRANSF(ERENCIA)?\s+REC|\bRECEBIDO\b/.test(d))                   return  1;
  if (/\bMOV\s+TIT\s+COB\b/.test(d))                                   return  1; // Itaú: boleto cobrado = recebimento
  if (/\bSAL[AÁ]RIO\b|\bPROVENTOS\b|\bDIVIDENDO\b/.test(d))           return  1;
  if (/RECEBIMENTOS\s+DIVERS/.test(d))                                  return  1; // BB: Recebimentos Diversos

  // ── DÉBITO ────────────────────────────────────────────────────────────────
  if (/\bD[EÉ]BITO?\b|D[EÉ]B\./.test(d))                              return -1;
  if (/\bPAGAMENTO\b|\bPAGTO\b/.test(d))                               return -1; // PAGAMENTO genérico
  if (/\bBOLETO\s+PAG|\bPAGAMENTO\s+DE\s+BOLETO/.test(d))             return -1; // Boleto pago
  if (/PAGTO\s+ELETRON|CONTA\s+DE\s+(LUZ|AGUA|GAS)/.test(d))          return -1; // contas / débito automático
  if (/\bSAQUE\b|\bCOMPRA\b/.test(d))                                  return -1;
  if (/\bTARIFA\b|\bTAR\s|\bTAR\./.test(d))                            return -1; // TAR COBRANCA, TAR MENSAL
  if (/\bTAXA\b|\bIOF\b|\bJUROS\b|\bANUIDADE\b/.test(d))              return -1;
  if (/PIX\s*[-–]\s*ENVIADO|PIX\s+ENVIADO|\bPIX\s+ENV\b/.test(d))     return -1;
  if (/\bTED\s+ENVIADO|\bDOC\s+ENVIADO/.test(d))                       return -1;
  if (/TRANSFER[EÊ]NCIA\s+(PIX\s+)?DES:/.test(d))                      return -1; // Bradesco: DES = saída
  if (/TRANSF(ERENCIA)?\s+ENV|\bENVIO\b/.test(d))                      return -1;
  if (/\bPRESTAC[AÃ]O\b|\bPARCELA\b|\bMENSALIDADE\b/.test(d))         return -1;
  if (/BB\s+GIRO|PRONAMPE|CONS[OÓ]RCIO/.test(d))                       return -1; // empréstimos BB
  if (/OPERACAO\s+CAPITAL|CAPITAL\s+GIRO/.test(d))                     return -1;
  if (/\bTRIBUTO\b|\bFGTS\b|\bDARF\b/.test(d))                        return -1;
  if (/\bEMISS[AÃ]O\b|\bEMIT\b/.test(d))                               return -1;
  if (/\bSEGURO\b/.test(d))                                             return -1;

  return 0; // genuinely unknown — caller will use default (+1) and warn
}

// Returns { sign: 1|-1, inferred: bool }
// inferred: true ONLY when we had to guess with the +1 default (sign truly unknown)
function resolveSign(indicator, valueRaw, description) {
  if (indicator === 'D' || indicator === '-') return { sign: -1, inferred: false };
  if (indicator === 'C' || indicator === '+') return { sign:  1, inferred: false };
  if (valueRaw.startsWith('-'))               return { sign: -1, inferred: false };
  if (valueRaw.startsWith('+'))               return { sign:  1, inferred: false };
  const sign = inferSign(description);
  return { sign: sign || 1, inferred: sign === 0 }; // warn only when truly unknown
}

function dateToExcelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}
