// PDF.js — lazy-loaded on first use (runs only in the browser)
let _pdfjs = null;
async function getPdfjs() {
  if (!_pdfjs) {
    _pdfjs = await import('pdfjs-dist');
    _pdfjs.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${_pdfjs.version}/pdf.worker.min.mjs`;
  }
  return _pdfjs;
}

export async function extractText(data) {
  const pdfjsLib = await getPdfjs();
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let fullText = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(' ') + ' ';
  }
  return fullText;
}

// Bank detection (only looks at the first 3000 chars to avoid false positives from payee names)
export const BANK_NAMES = {
  sicoob:    'Sicoob',
  sicredi:   'Sicredi',
  bradesco:  'Bradesco',
  itau:      'Itaú',
  bb:        'Banco do Brasil',
  caixa:     'Caixa Econômica',
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
  if (header.includes('BRADESCO'))                                   return 'bradesco';
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
export function parseTransactions(text) {
  const normalized = normalizeText(text);
  const period     = extractPeriod(normalized);
  const transText  = trimAtSummary(normalized);

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

function parseRsColumnFormat(text) {
  const clean = text.replace(
    /(?:Entradas|Sa[íi]das|Saldo\s+(?:inicial|final|anterior))[^\n]*R\$[^\n]*/gi, '',
  );

  const allValues = [...clean.matchAll(/R\$\s*([+-]?\d{1,3}(?:\.\d{3})*,\d{2})/g)]
    .map(m => parseBrazilianNumber(m[1]));

  const txValues = allValues.filter((_, i) => i % 2 === 0);

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

    const prev = i > 0 ? txDates[i - 1].index + txDates[i - 1][0].length : 0;
    const curr = txDates[i].index;
    const desc = clean.substring(prev, curr)
      .replace(/\d{9,}/g, '')
      .replace(/R\$\s*[\d.,]+/g, '')
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

// ── Private: helpers ─────────────────────────────────────────────────────────

function isBalanceLine(description) {
  return /\bSALDO\s+(ANTERIOR|TOTAL|FINAL|INICIAL)/i.test(description) ||
         /\bSALDO\s+TOTAL\s+DISPON/i.test(description);
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
  if (/\bRENDIMENTO\b|\bREND\s+PAGO\b/.test(d))                        return  1;
  if (/\bESTORNO\b|\bDEVOLU[CÇ]/.test(d))                             return  1;
  if (/\bRESGATE?\b/.test(d))                                           return  1;
  if (/PIX\s*[-–]\s*RECEBIDO|PIX\s+RECEBIDO|\bPIX\s+REC\b/.test(d))  return  1;
  if (/TRANSFER[EÊ]NCIA\s+(PIX\s+)?REM:/.test(d))                      return  1;
  if (/TRANSF(ERENCIA)?\s+REC|\bRECEBIDO\b/.test(d))                   return  1;
  if (/\bMOV\s+TIT\s+COB\b/.test(d))                                   return  1;
  if (/\bSAL[AÁ]RIO\b|\bPROVENTOS\b|\bDIVIDENDO\b/.test(d))           return  1;
  if (/RECEBIMENTOS\s+DIVERS/.test(d))                                  return  1;

  // ── DÉBITO ────────────────────────────────────────────────────────────────
  if (/\bD[EÉ]BITO?\b|D[EÉ]B\./.test(d))                              return -1;
  if (/\bPAGAMENTO\b|\bPAGTO\b/.test(d))                               return -1;
  if (/\bBOLETO\s+PAG|\bPAGAMENTO\s+DE\s+BOLETO/.test(d))             return -1;
  if (/PAGTO\s+ELETRON|CONTA\s+DE\s+(LUZ|AGUA|GAS)/.test(d))          return -1;
  if (/\bSAQUE\b|\bCOMPRA\b/.test(d))                                  return -1;
  if (/\bTARIFA\b|\bTAR\s|\bTAR\./.test(d))                            return -1;
  if (/\bTAXA\b|\bIOF\b|\bJUROS\b|\bANUIDADE\b/.test(d))              return -1;
  if (/PIX\s*[-–]\s*ENVIADO|PIX\s+ENVIADO|\bPIX\s+ENV\b/.test(d))     return -1;
  if (/\bTED\s+ENVIADO|\bDOC\s+ENVIADO/.test(d))                       return -1;
  if (/TRANSFER[EÊ]NCIA\s+(PIX\s+)?DES:/.test(d))                      return -1;
  if (/TRANSF(ERENCIA)?\s+ENV|\bENVIO\b/.test(d))                      return -1;
  if (/\bPRESTAC[AÃ]O\b|\bPARCELA\b|\bMENSALIDADE\b/.test(d))         return -1;
  if (/BB\s+GIRO|PRONAMPE|CONS[OÓ]RCIO/.test(d))                       return -1;
  if (/OPERACAO\s+CAPITAL|CAPITAL\s+GIRO/.test(d))                     return -1;
  if (/\bTRIBUTO\b|\bFGTS\b|\bDARF\b/.test(d))                        return -1;
  if (/\bEMISS[AÃ]O\b|\bEMIT\b/.test(d))                               return -1;
  if (/\bSEGURO\b/.test(d))                                             return -1;

  return 0; // genuinely unknown — caller will use default (+1) and warn
}

function resolveSign(indicator, valueRaw, description) {
  if (indicator === 'D' || indicator === '-') return { sign: -1, inferred: false };
  if (indicator === 'C' || indicator === '+') return { sign:  1, inferred: false };
  if (valueRaw.startsWith('-'))               return { sign: -1, inferred: false };
  if (valueRaw.startsWith('+'))               return { sign:  1, inferred: false };
  const sign = inferSign(description);
  return { sign: sign || 1, inferred: sign === 0 };
}

function dateToExcelSerial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}
