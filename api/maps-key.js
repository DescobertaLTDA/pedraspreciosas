// api/maps-key.js
// Endpoint serverless da Vercel que expõe a chave do Google Maps/Places
// para o front-end, sem deixá-la hardcoded no HTML/repositório.
//
// Configuração na Vercel:
// 1. Vá em Project Settings → Environment Variables
// 2. Adicione GOOGLE_MAPS_API_KEY com o valor da sua chave
// 3. Redeploy o projeto
//
// A chave em si continua visível no navegador (é assim que a Maps
// JavaScript API funciona — a proteção real é a restrição por
// HTTP referrer configurada no Google Cloud Console).

export default function handler(req, res) {
  const key = process.env.GOOGLE_MAPS_API_KEY || '';

  // Cache leve no edge/CDN da Vercel (5 min) já que a chave raramente muda
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate');
  res.status(200).json({ key: key });
}
