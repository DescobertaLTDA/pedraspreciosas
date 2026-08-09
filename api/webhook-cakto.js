// /api/webhook-cakto.js
// Recebe a notificação da Cakto quando o order bump "Avaliação Individual da Sua Pedra"
// é pago, e libera o crédito vinculado ao e-mail do comprador.
// (Antes era vinculado a um cookie/sessão; agora é vinculado à conta/e-mail.)

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

  // ---- 3. Filtrar só pela oferta do order bump ----
  const offerIdEsperado = process.env.CAKTO_OFFER_ID;
  if (offerIdEsperado && data.offer && data.offer.id !== offerIdEsperado) {
    return res.status(200).json({ ok: true, ignorado: true });
  }

  // ---- 4. Extrair e-mail do comprador ----
  // Confira no payload real da Cakto o caminho exato — normalmente vem em
  // data.customer.email. Ajuste aqui se o campo tiver outro nome.
  const emailBruto = data.customer && data.customer.email;
  if (!emailBruto) {
    console.error('Payload sem e-mail do comprador:', JSON.stringify(data));
    return res.status(400).json({ error: 'Payload sem e-mail do comprador' });
  }
  const email = emailBruto.toLowerCase().trim();

  if (!data.id) {
    return res.status(400).json({ error: 'Payload sem ID do pedido' });
  }

  // ---- 5. Liberar o crédito para esse e-mail ----
  try {
    const { error } = await supabase
      .from('creditos_avaliacao')
      .upsert(
        {
          email,
          order_id: data.id,
          status: 'pago',
          limite: LIMITE_PADRAO
        },
        { onConflict: 'email' }
      );

    if (error) {
      console.error('Erro Supabase (webhook upsert):', error);
      return res.status(500).json({ error: 'Erro ao registrar crédito' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro inesperado no webhook:', err);
    return res.status(500).json({ error: 'Erro interno' });
  }
};
