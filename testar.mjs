import { execSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

// ── Mesma lógica de js/parser.js (adaptada para Node) ────────────────────────

const BANK_NAMES = {
  sicoob: 'Sicoob', sicredi: 'Sicredi', bradesco: 'Bradesco', itau: 'Itau',
  bb: 'Banco do Brasil', caixa: 'Caixa Economica', nubank: 'Nubank',
  inter: 'Banco Inter', santander: 'Santander', safra: 'Banco Safra',
  c6: 'C6 Bank', original: 'Banco Original', banrisul: 'Banrisul',
  btg: 'BTG Pactual', bs2: 'Banco BS2',
};

function detectBank(text) {
  const header = text.substring(0, 3000).toUpperCase();
  if (header.includes('DT. BALANCETE') || header.includes('AG. ORIGEM') ||
      header.includes('CONSULTAS - EXTRATO DE CONTA CORRENTE')) return 'bb';
  if (header.includes('SICOOB') || header.includes('SISBR'))        return 'sicoob';
  if (header.includes('SICREDI'))                                    return 'sicredi';
  if (header.includes('BRADESCO'))                                   return 'bradesco';
  if (/ITA[ÚU]/.test(header))                                       return 'itau';
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

const MONTHS_PT = {
  jan:'01', fev:'02', mar:'03', abr:'04', mai:'05', jun:'06',
  jul:'07', ago:'08', set:'09', out:'10', nov:'11', dez:'12',
};

function normalizeText(text) {
  text = text.replace(
    /\b(\d{2})\s*\/\s*(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\b/gi,
    (_, d, m) => `${d}/${MONTHS_PT[m.toLowerCase()]}`,
  );
  text = text.replace(/\b(\d{2})-(\d{2})-(\d{4})\b/g, '$1/$2/$3');
  return text;
}

function isBalanceLine(desc) {
  return /\bSALDO\s+(ANTERIOR|TOTAL|FINAL|INICIAL)/i.test(desc) ||
         /\bSALDO\s+TOTAL\s+DISPON/i.test(desc);
}

function trimAtSummary(text) {
  const stops = ['RESUMO', 'S A L D O', 'TOTAL GERAL', 'TOTAL DO PERIODO',
    'ENCARGOS VENCIDOS', '(+) SALDO', '(=) SALDO', 'INFORMACOES COMPLEMENTARES'];
  let r = text;
  for (const s of stops) {
    const i = r.indexOf(s);
    if (i > -1 && i > r.length * 0.2) r = r.substring(0, i);
  }
  return r;
}

function extractPeriod(text) {
  const patterns = [
    /PER[ÍI]ODO[:\s]*(\d{2})\/(\d{2})\/(\d{4})\s*[-–a]\s*(\d{2})\/(\d{2})\/(\d{4})/i,
    /[Dd]e\s*(\d{2})\/(\d{2})\/(\d{4})\s*[aà]\s*(\d{2})\/(\d{2})\/(\d{4})/,
    /(\d{2})\/(\d{2})\/(\d{4})\s*(?:[-–a]|at[eé]|al)\s*(\d{2})\/(\d{2})\/(\d{4})/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { startMonth: +m[2], startYear: +m[3], endMonth: +m[5], endYear: +m[6] };
  }
  const s = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (s) return { startMonth: +s[2], startYear: +s[3], endMonth: +s[2], endYear: +s[3] };
  const y = new Date().getFullYear();
  return { startMonth: 1, startYear: y, endMonth: 12, endYear: y };
}

function parseBR(str) { return parseFloat(str.replace(/\./g, '').replace(',', '.')); }

function inferSign(description) {
  const d = description.toUpperCase();
  // Crédito primeiro (evita falsos positivos com palavras como "PAGO" em "REND PAGO")
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
  // Débito
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
  if (/OPERACAO\s+CAPITAL|CAPITAL\s+GIRO/.test(d))                      return -1;
  if (/\bTRIBUTO\b|\bFGTS\b|\bDARF\b/.test(d))                        return -1;
  if (/\bEMISS[AÃ]O\b|\bEMIT\b/.test(d))                               return -1;
  if (/\bSEGURO\b/.test(d))                                             return -1;
  return 0;
}

function resolveSign(ind, raw, desc) {
  if (ind === 'D' || ind === '-') return { sign: -1, inferred: false };
  if (ind === 'C' || ind === '+') return { sign:  1, inferred: false };
  if (raw.startsWith('-'))        return { sign: -1, inferred: false };
  if (raw.startsWith('+'))        return { sign:  1, inferred: false };
  const sign = inferSign(desc);
  return { sign: sign || 1, inferred: sign === 0 };
}

function parseGenericFormat(transText, period) {
  const segments = transText.split(/(?<!\S)(?=\d{2}\/\d{2}(?:\/\d{2,4})?\s)/);
  const transactions = [];
  let hadInferredSign = false;

  for (const seg of segments) {
    const m = seg.match(
      /^(\d{2})\/(\d{2})(?:\/(\d{2,4}))?\s+(.*?)\s+(?:R\$\s*)?([+-]?\s*\d{1,3}(?:\.\d{3})*,\d{2})\s*([CD+-])?\b/,
    );
    if (!m) continue;
    const day = +m[1], month = +m[2];
    let year = m[3] ? +m[3] : null;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    if (year !== null && year < 100) year += 2000;
    if (year === null) year = period.startYear === period.endYear
      ? period.endYear : (month >= period.startMonth ? period.startYear : period.endYear);

    const description = m[4].trim();
    const valueRaw    = m[5].replace(/\s/g, '');
    const indicator   = m[6];

    if (isBalanceLine(description)) continue;
    if (/^(DATA|HIST|VALOR|DESCRI|LAN[CÇ])/i.test(description)) continue;

    const abs = parseBR(valueRaw.replace(/^[+-]/, ''));
    const { sign, inferred } = resolveSign(indicator, valueRaw, description);
    if (inferred) hadInferredSign = true;
    const val = sign * abs;

    const detail = seg.substring(m[0].length)
      .replace(/DOC\.?:\s*\S*/gi, '').replace(/NR\.?:\s*\S*/gi, '')
      .replace(/\s+/g, ' ').trim();

    transactions.push({
      date: `${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`,
      description: detail ? `${description} - ${detail}` : description,
      value: val,
    });
  }
  return { transactions, hadInferredSign };
}

function parseRsColumnFormat(text) {
  const clean = text.replace(
    /(?:Entradas|Sa[íi]das|Saldo\s+(?:inicial|final|anterior))[^\n]*R\$[^\n]*/gi, '',
  );
  const allValues = [...clean.matchAll(/R\$\s*([+-]?\d{1,3}(?:\.\d{3})*,\d{2})/g)]
    .map(m => parseBR(m[1]));
  const txValues = allValues.filter((_, i) => i % 2 === 0);

  const allDates = [...clean.matchAll(/(\d{2})\/(\d{2})\/(\d{4})/g)];
  const txDates  = allDates.filter(m => {
    const before = clean.substring(Math.max(0, m.index - 40), m.index);
    return !/(?:de|per[íi]odo|al|at[eé]|período)\s*$/i.test(before);
  });

  if (!txDates.length || !txValues.length) return null;
  const count = Math.min(txDates.length, txValues.length);
  const transactions = [];

  for (let i = 0; i < count; i++) {
    const [, d, mo, y] = txDates[i];
    const day = +d, month = +mo, year = +y;
    if (day < 1 || day > 31 || month < 1 || month > 12) continue;
    const val = txValues[i];
    const prev = i > 0 ? txDates[i-1].index + txDates[i-1][0].length : 0;
    const desc = clean.substring(prev, txDates[i].index)
      .replace(/\d{9,}/g, '').replace(/R\$\s*[\d.,]+/g, '')
      .replace(/\s+/g, ' ').trim();
    if (isBalanceLine(desc)) continue;
    transactions.push({
      date: `${String(day).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`,
      description: desc || 'Transação',
      value: val,
    });
  }
  return transactions.length > 0 ? transactions : null;
}

function parseTransactions(text) {
  const normalized = normalizeText(text);
  const period     = extractPeriod(normalized);
  const transText  = trimAtSummary(normalized);

  const result = parseGenericFormat(transText, period);

  if (result.transactions.length === 0 && /R\$/.test(transText)) {
    const fallback = parseRsColumnFormat(transText);
    if (fallback) return { transactions: fallback, hadInferredSign: true };
  }

  return result;
}

// ── Runner ────────────────────────────────────────────────────────────────────

const dir = new URL('.', import.meta.url).pathname;
const pdfs = readdirSync(dir).filter(f => f.endsWith('.pdf')).sort();

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[34m', BOLD = '\x1b[1m', X = '\x1b[0m';
let ok = 0, fail = 0;

for (const pdf of pdfs) {
  const path = join(dir, pdf);
  console.log(`\n${BOLD}${B}━━━ ${pdf} ${X}`);

  let raw;
  try {
    // No -layout flag: closer to how PDF.js concatenates text items
    raw = execSync(`pdftotext "${path}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  ${R}✗ Erro ao extrair texto: ${e.message}${X}`);
    fail++; continue;
  }

  // Join lines with a space, simulating PDF.js item concatenation
  const text = raw.split('\n').map(l => l.trim()).filter(Boolean).join(' ');

  const bank  = detectBank(text);
  const label = BANK_NAMES[bank] ?? 'Desconhecido';
  const { transactions, hadInferredSign } = parseTransactions(text);

  const fmtBR = n => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalC = transactions.filter(t => t.value > 0).reduce((s, t) => s + t.value, 0);
  const totalD = transactions.filter(t => t.value < 0).reduce((s, t) => s + t.value, 0);

  if (transactions.length === 0) {
    console.log(`  ${R}✗ Nenhum lançamento encontrado${X}`); fail++; continue;
  }

  const warn = hadInferredSign ? ` ${Y}⚠ sinal inferido${X}` : ` ${G}✓${X}`;
  console.log(`  Banco    : ${BOLD}${label}${X}${warn}`);
  console.log(`  Lançamentos: ${BOLD}${transactions.length}${X}  |  Créditos: ${G}R$ ${fmtBR(totalC)}${X}  |  Débitos: ${R}R$ ${fmtBR(totalD)}${X}`);
  console.log(`  ${BOLD}Primeiros 5:${X}`);

  for (const t of transactions.slice(0, 5)) {
    const color = t.value >= 0 ? G : R;
    console.log(`    ${t.date}  ${color}${fmtBR(t.value).padStart(14)}${X}  ${t.description.substring(0, 60)}`);
  }
  ok++;
}

console.log(`\n${BOLD}━━━ Resultado: ${G}${ok} ok${X}${BOLD}  |  ${R}${fail} falhou${X}\n`);
