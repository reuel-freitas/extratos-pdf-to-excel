'use client';

import { useState, useCallback, useRef } from 'react';
import { extractText, detectBank, parseTransactions, BANK_NAMES } from '../lib/parser';
import { downloadExcel } from '../lib/excel';

function formatBR(n) {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(t) {
  return `${String(t.day).padStart(2, '0')}/${String(t.month).padStart(2, '0')}/${t.year}`;
}

export default function Home() {
  const [transactions, setTransactions] = useState([]);
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [errorMsg, setErrorMsg] = useState('');
  const [bankName, setBankName] = useState('');
  const [hadInferredSign, setHadInferredSign] = useState(false);
  const [fileName, setFileName] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const reset = useCallback(() => {
    setTransactions([]);
    setStatus('idle');
    setErrorMsg('');
    setBankName('');
    setHadInferredSign(false);
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const processFile = useCallback(async (file) => {
    if (!file || file.type !== 'application/pdf') {
      setErrorMsg('Por favor, selecione um arquivo PDF.');
      setStatus('error');
      return;
    }

    reset();
    setFileName(file.name.replace(/\.pdf$/i, ''));
    setStatus('loading');

    try {
      const buffer = await file.arrayBuffer();
      const text = await extractText(new Uint8Array(buffer));
      const bank = detectBank(text);
      const result = parseTransactions(text);

      if (result.transactions.length === 0) {
        setErrorMsg('Nenhum lançamento encontrado neste PDF. Verifique se o arquivo é um extrato bancário com movimentações.');
        setStatus('error');
        return;
      }

      setBankName(BANK_NAMES[bank] ?? 'Banco não identificado');
      setHadInferredSign(result.hadInferredSign);
      setTransactions(result.transactions);
      setStatus('done');
    } catch (err) {
      setErrorMsg('Erro ao processar o PDF: ' + err.message);
      setStatus('error');
    }
  }, [reset]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragOver(false);
    processFile(e.dataTransfer.files[0]);
  }, [processFile]);

  const totalC = transactions.filter(t => t.value > 0).reduce((s, t) => s + t.value, 0);
  const totalD = transactions.filter(t => t.value < 0).reduce((s, t) => s + t.value, 0);

  return (
    <>
      <header>
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
          <polyline points="10 9 9 9 8 9"/>
        </svg>
        <div>
          <h1>Conversor de Extratos Bancários</h1>
          <p>PDF do extrato → Planilha Excel — Qualquer banco</p>
        </div>
      </header>

      <div className="container">
        {status !== 'done' && (
          <div
            className={`drop-zone${isDragOver ? ' dragover' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={onDrop}
          >
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#90cdf4" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div className="main-text">Arraste o PDF do extrato aqui</div>
            <div className="sub-text">ou clique para selecionar — funciona com qualquer banco</div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); }}
        />

        {status === 'loading' && (
          <div className="loading">
            <div className="spinner" />
            <div>Processando extrato...</div>
          </div>
        )}

        {status === 'error' && (
          <div className="error-bar">{errorMsg}</div>
        )}

        {status === 'done' && (
          <>
            <div>
              <span className="bank-badge">{bankName}</span>
            </div>

            {hadInferredSign && (
              <div className="warn-bar">
                Alguns valores não tinham indicador C/D ou +/-. O sinal foi inferido pela descrição.{' '}
                <strong>Confira os valores na tabela.</strong>
              </div>
            )}

            <div className="info-bar">
              <strong>{transactions.length}</strong> lançamentos &mdash;{' '}
              Créditos: <strong style={{ color: '#2e7d32' }}>R$ {formatBR(totalC)}</strong>
              {' '}&nbsp;|&nbsp;{' '}
              Débitos: <strong style={{ color: '#c62828' }}>R$ {formatBR(totalD)}</strong>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Descrição</th>
                    <th>525 (Créd.)</th>
                    <th>525 (Déb.)</th>
                    <th>Valor (R$)</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t, i) => (
                    <tr key={i}>
                      <td>{fmtDate(t)}</td>
                      <td>{t.description}</td>
                      <td className="code-525">{t.col525credit !== null ? '525' : ''}</td>
                      <td className="code-525">{t.col525debit  !== null ? '525' : ''}</td>
                      <td className={t.value >= 0 ? 'val-positive' : 'val-negative'}>{formatBR(t.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <button className="btn btn-primary" onClick={() => downloadExcel(transactions, fileName)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                Baixar Excel
              </button>
              <button className="btn btn-secondary" onClick={reset}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="1 4 1 10 7 10"/>
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
                Novo arquivo
              </button>
            </div>
          </>
        )}
      </div>

      <footer>Conversor de extratos bancários — Processamento local (seus dados não saem do computador)</footer>
    </>
  );
}
