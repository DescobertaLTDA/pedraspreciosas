// /api/vitrine.js
// Endpoint PÚBLICO (sem login) que alimenta a seção "Veja o que outras
// pessoas encontraram", logo abaixo da consulta. Mostra identificações de
// QUALQUER cliente (gratuito ou pago) que autorizou aparecer publicamente
// (permite_vitrine = true) — nunca fotos de quem negou consentimento.
//
// Não expõe e-mail: só nome de exibição (salvo em identificar.js a partir
// do nome informado no cadastro), foto e um valor de exibição extraído da
// faixa de preço.
//
// Paginação: 10 itens por página (grade de 5 colunas x 2 linhas no front).
// Chamada: GET /api/vitrine?pagina=1

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const POR_PAGINA = 10;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const paginaBruta = (req.query && req.query.pagina) || (req.body && req.body.pagina) || '1';
  const pagina = Math.max(1, parseInt(paginaBruta, 10) || 1);
  const de = (pagina - 1) * POR_PAGINA;
  const ate = de + POR_PAGINA - 1;

  try {
    const { data: linhas, error, count } = await supabase
      .from('identificacoes')
      .select('id, nome_exibicao, whatsapp, nome_provavel, faixa_preco_brasil, foto_base64, foto_media_type, criado_em', { count: 'exact' })
      .eq('permite_vitrine', true)
      .not('foto_base64', 'is', null)
      .order('criado_em', { ascending: false })
      .range(de, ate);

    if (error) {
      console.error('Erro Supabase (vitrine):', error);
      return res.status(500).json({ error: 'Erro ao buscar vitrine.' });
    }

    const itens = (linhas || []).map(function (item) {
      return {
        id: item.id,
        nome: mascararNome(item.nome_exibicao),
        whatsapp: item.whatsapp || null,
        pedra: item.nome_provavel,
        valor_exibicao: extrairValorExibicao(item.faixa_preco_brasil),
        foto: 'data:' + (item.foto_media_type || 'image/jpeg') + ';base64,' + item.foto_base64,
        criado_em: item.criado_em
      };
    });

    const totalPaginas = Math.max(1, Math.ceil((count || itens.length) / POR_PAGINA));

    return res.status(200).json({
      itens: itens,
      pagina: pagina,
      total_paginas: totalPaginas
    });
  } catch (err) {
    console.error('Erro inesperado (vitrine):', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
};

// Mostra só o primeiro nome + inicial do sobrenome (ex: "José A."), pra não
// expor o nome completo de um cliente numa vitrine pública.
function mascararNome(nomeCompleto) {
  if (!nomeCompleto) return 'Cliente';
  const partes = String(nomeCompleto).trim().split(/\s+/);
  if (partes.length === 1) return partes[0];
  return partes[0] + ' ' + partes[1].charAt(0).toUpperCase() + '.';
}

// Tenta extrair um número "de exibição" (o maior valor da faixa) do texto
// livre salvo pela IA, tipo "R$20 a R$150 por grama". Se não conseguir,
// devolve null (o front mostra "valor sob consulta").
function extrairValorExibicao(faixaTexto) {
  if (!faixaTexto) return null;
  const numeros = String(faixaTexto).match(/\d+[\.,]?\d*/g);
  if (!numeros || !numeros.length) return null;

  const maior = numeros
    .map(function (n) { return parseFloat(n.replace(/\./g, '').replace(',', '.')); })
    .filter(function (n) { return !isNaN(n); })
    .sort(function (a, b) { return b - a; })[0];

  return typeof maior === 'number' && !isNaN(maior) ? maior : null;
}
