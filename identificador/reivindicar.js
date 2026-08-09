// /api/reivindicar.js
// Chamado automaticamente quando a página do identificador carrega.
// Vincula o navegador do visitante ao crédito de compra mais antigo ainda não usado,
// e grava isso num cookie de sessão (sem precisar de token na URL nem de e-mail).

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function lerCookie(req, nome) {
  const cabecalho = req.headers.cookie || '';
  const partes = cabecalho.split(';').map(function (p) { return p.trim(); });
  for (const parte of partes) {
    if (parte.indexOf(nome + '=') === 0) {
      return decodeURIComponent(parte.slice(nome.length + 1));
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const sessaoExistente = lerCookie(req, 'sessao_pedra');

  // ---- 1. Se já existe sessão válida (ex: pessoa recarregou a página), reaproveita ----
  if (sessaoExistente) {
    const { data: registro, error } = await supabase
      .from('creditos_avaliacao')
      .select('usos, limite, status')
      .eq('sessao_id', sessaoExistente)
      .eq('status', 'reivindicado')
      .single();

    if (!error && registro) {
      return res.status(200).json({ ok: true, usos: registro.usos, limite: registro.limite });
    }
    // se não achou nada, cai para tentar reivindicar um crédito novo abaixo
  }

  // ---- 2. Tentar reivindicar o crédito pendente mais antigo (FIFO, atômico) ----
  const novaSessao = crypto.randomUUID();

  const { data: registro, error } = await supabase.rpc('reivindicar_credito', {
    p_sessao_id: novaSessao
  });

  if (error) {
    console.error('Erro ao reivindicar crédito:', error);
    return res.status(500).json({ error: 'Erro ao verificar seu acesso. Tente novamente.' });
  }

  if (!registro) {
    return res.status(403).json({
      error: 'Não encontramos uma compra recente vinculada a este acesso. Se você acabou de pagar, aguarde alguns segundos e recarregue a página.'
    });
  }

  res.setHeader(
    'Set-Cookie',
    'sessao_pedra=' + novaSessao + '; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax'
  );

  return res.status(200).json({ ok: true, usos: registro.usos, limite: registro.limite });
};
