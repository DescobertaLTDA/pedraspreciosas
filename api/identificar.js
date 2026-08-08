export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Método não permitido." });
    return;
  }

  const { base64, mediaType } = req.body || {};

  if (!base64 || !mediaType) {
    res.status(400).json({ error: "Imagem ausente." });
    return;
  }

  try {
    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: mediaType, data: base64 },
              },
              {
                type: "text",
                text:
                  "Você é um especialista em gemologia e mineralogia. Olhe a foto dessa pedra e responda em português do Brasil, em formato JSON puro (sem markdown, sem crases), com as chaves: nome_provavel (string), nomes_alternativos (array de até 3 strings, outras possibilidades), caracteristicas (array de até 4 strings curtas sobre cor, brilho, textura), faixa_preco_brasil (string, estimativa em reais por grama ou por peça, deixando claro que é uma estimativa), confianca (string: alta, media ou baixa), observacao (string curta, avisando que uma avaliação profissional presencial é recomendada para confirmar autenticidade e valor).",
              },
            ],
          },
        ],
      }),
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error("Erro da API Anthropic:", errText);
      res.status(502).json({ error: "Falha ao consultar a IA." });
      return;
    }

    const data = await anthropicResponse.json();
    const textBlock = data?.content?.find((b) => b.type === "text");

    if (!textBlock) {
      res.status(502).json({ error: "Resposta inesperada da IA." });
      return;
    }

    const clean = textBlock.text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);

    res.status(200).json(parsed);
  } catch (error) {
    console.error("Erro no handler /api/identificar:", error);
    res.status(500).json({ error: "Erro interno ao identificar a pedra." });
  }
}
