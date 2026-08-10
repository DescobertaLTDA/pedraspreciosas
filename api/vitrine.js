// /api/vitrine.js
// GET  -> Endpoint PÚBLICO (sem login obrigatório) que alimenta a seção
//         "Veja o que outras pessoas encontraram". Mostra só identificações
//         já DESBLOQUEADAS (clientes que pagaram e consumiram um crédito) E
//         que a pessoa autorizou aparecer publicamente (permite_vitrine = true).
//         Se a requisição vier com um Bearer token válido, cada item recebe
//         um campo extra "pode_deletar": true quando a foto é do próprio
//         usuário logado — usado no front pra mostrar o ícone de lixeira.
//         O e-mail nunca é exposto na resposta, nem para o dono da foto.
//
// DELETE -> Remove a foto da VITRINE (não apaga a identificação nem o
//           histórico do cliente — só marca permite_vitrine = false).
//           Exige login e só funciona se o e-mail do token bater com o
//           e-mail dono da identificação.
//           Chamada: DELETE /api/vitrine?id=<identificacao_id>
//
// Paginação (GET): 10 itens por página (grade de 5 colunas x 2 linhas no front).
// Chamada: GET /api/vitrine?pagina=1

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const POR_PAGINA = 10;

function pegarToken(req) {
  const cabecalho = req.headers.authorization || '';
  if (cabecalho.indexOf('Bearer ') === 0) {
    return cabecalho.slice(7);
  }
  return null;
}

// Tenta identificar o e-mail de quem está fazendo a requisição a partir do
// Bearer token. Não falha a requisição se não conseguir — a vitrine
// continua pública mesmo sem login (só não marca nenhum item como "meu").
async function pegarEmailOpcional(req) {
  const token = pegarToken(req);
  if (!token) return null;

  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData || !userData.user || !userData.user.email) return null;

  return userData.user.email.toLowerCase();
}

module.exports = async function handler(req, res) {
  if (req.method === 'DELETE') {
    return tratarDelete(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const paginaBruta = (req.query && req.query.pagina) || (req.body && req.body.pagina) || '1';
  const pagina = Math.max(1, parseInt(paginaBruta, 10) || 1);
  const de = (pagina - 1) * POR_PAGINA;
  const ate = de + POR_PAGINA - 1;

  try {
    const emailUsuarioAtual = await pegarEmailOpcional(req);

    const { data: linhas, error, count } = await supabase
      .from('identificacoes')
      .select('id, email, nome_exibicao, whatsapp, nome_provavel, faixa_preco_brasil, foto_base64, foto_media_type, criado_em', { count: 'exact' })
      .eq('desbloqueada', true)
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
        pode_deletar: !!(emailUsuarioAtual && item.email && item.email.toLowerCase() === emailUsuarioAtual)
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

// Remove uma foto específica da vitrine pública. Não apaga a identificação:
// só desliga permite_vitrine, então o cliente continua vendo ela no
// histórico normalmente, só não aparece mais pros outros.
async function tratarDelete(req, res) {
  const token = pegarToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Você precisa entrar na sua conta primeiro.' });
  }

  const { data: userData, error: erroAuth } = await supabase.auth.getUser(token);
  if (erroAuth || !userData || !userData.user || !userData.user.email) {
    return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
  }

  const email = userData.user.email.toLowerCase();
  const id = (req.query && req.query.id) || (req.body && req.body.id);

  if (!id) {
    return res.status(400).json({ error: 'Identificação não informada.' });
  }

  try {
    // Confirma que a identificação é dessa conta ANTES de alterar.
    const { data: linha, error: erroBusca } = await supabase
      .from('identificacoes')
      .select('id, email')
      .eq('id', id)
      .single();

    if (erroBusca || !linha) {
      return res.status(404).json({ error: 'Foto não encontrada.' });
    }

    if (!linha.email || linha.email.toLowerCase() !== email) {
      return res.status(403).json({ error: 'Você não pode remover essa foto.' });
    }

    const { error: erroUpdate } = await supabase
      .from('identificacoes')
      .update({ permite_vitrine: false })
      .eq('id', id);

    if (erroUpdate) {
      console.error('Erro Supabase (delete vitrine):', erroUpdate);
      return res.status(500).json({ error: 'Erro ao remover a foto. Tente novamente.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro inesperado (delete vitrine):', err);
    return res.status(500).json({ error: 'Erro interno. Tente novamente em instantes.' });
  }
}

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
