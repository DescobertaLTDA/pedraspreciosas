// /api/webhook-cakto.js
// Recebe a notificação da Cakto quando o order bump "Avaliação Individual da Sua Pedra"
// é pago, e registra um crédito pendente que a página do identificador vai reivindicar.

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const LIMITE_PADRAO = 3;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const payload = req.body || {};

  // ---- 1. Validar o segredo configurado na Cakto ----
  if (!payload.secret || payload.secret !== process.env.CAKTO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  // ---- 2. Só nos interessa compra aprovada e paga ----
  if (payload.event !== 'purchase_approved') {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  const data = payload.data || {};

  if (data.status !== 'paid') {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  // ---- 3. Filtrar só pela oferta do order bump (evita liberar crédito na venda do ebook principal) ----
  const offerIdEsperado = process.env.CAKTO_OFFER_ID;
  if (offerIdEsperado && data.offer && data.offer.id !== offerIdEsperado) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  if (!data.id) {
    return res.status(400).json({ error: 'Payload sem ID do pedido' });
  }

  // ---- 4. Registrar o crédito pendente ----
  try {
    const { error } = await supabase
      .from('creditos_avaliacao')
      .insert({
        order_id: data.id,
        status: 'pendente',
        limite: LIMITE_PADRAO
      });

    // código 23505 = order_id duplicado (a Cakto reenviou o mesmo webhook) — não é erro real
    if (error && error.code !== '23505') {
      console.error('Erro Supabase (webhook insert):', error);
      return res.status(500).json({ error: 'Erro ao registrar crédito' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro inesperado no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
