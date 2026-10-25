import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { imageBase64 } = await req.json();
    if (!imageBase64) {
      return new Response(JSON.stringify({ error: "Missing imageBase64 data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY secret not found in Supabase" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    let activeModel = "claude-sonnet-5-5";
    try {
      const modelsRes = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        }
      });
      const modelsData = await modelsRes.json();
      if (modelsData.data && Array.isArray(modelsData.data) && modelsData.data.length > 0) {
        const sonnet = modelsData.data.find((m: any) => m.id.includes("sonnet"));
        const haiku = modelsData.data.find((m: any) => m.id.includes("haiku"));
        activeModel = (sonnet || haiku || modelsData.data[0]).id;
      }
    } catch (_) {}

    const cleanBase64 = imageBase64.replace(/^data:image\/[a-z]+;base64,/, "");

    const promptText = `Analyze this flat-lay garment photo for an executive wardrobe curation platform.
Extract and return STRICTLY a single raw JSON object matching this schema:
{
  "brand": "Detected brand name from tags, collar labels, embroidery, or silhouette signatures (e.g., J.Crew, Vuori, Relwen, Peter Millar, Barbour). Leave empty string if unidentifiable.",
  "name": "Concise executive product name (e.g., 'Navy Cotton Pique Polo', 'Oatmeal Herringbone Sport Coat')",
  "category": "Top" | "Layer" | "Bottom" | "Footwear",
  "sub_category": "Tee" | "Oxford" | "Rugby" | "Knit" | "Overshirt" | "Blazer" | "Chino" | "5-Pocket" | "Shorts" | "Sneaker" | "Boot",
  "color": "Primary color family (e.g., Navy, Olive, Charcoal, Tobacco, Heather Grey)",
  "pattern": "Solid" | "Stripe" | "Plaid" | "Heathered" | "Texture",
  "formality": "Casual" | "Executive Casual" | "Business Formal",
  "season": ["Spring", "Summer", "Fall", "Winter"]
}
Do not include any Markdown backticks, explanation, or conversational text. Return only valid JSON.`;

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: activeModel,
        max_tokens: 1500,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/jpeg",
                  data: cleanBase64
                }
              },
              {
                type: "text",
                text: promptText
              }
            ]
          }
        ]
      })
    });

    const anthropicData = await anthropicRes.json();

    if (anthropicData.error) {
      return new Response(JSON.stringify({ error: `[${activeModel}] ${anthropicData.error.message}` }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const textBlocks = anthropicData.content?.filter((b: any) => b.type === "text") || [];
    const rawText = textBlocks.map((b: any) => b.text).join("").trim();

    if (!rawText) {
      return new Response(JSON.stringify({ 
        error: `No text block in vision output. Stop reason: ${anthropicData.stop_reason}. Raw: ${JSON.stringify(anthropicData.content || anthropicData)}` 
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("No JSON found in vision output: " + rawText.slice(0, 100));
    }
    const cleanJson = rawText.substring(firstBrace, lastBrace + 1);
    const parsedTags = JSON.parse(cleanJson);

    return new Response(JSON.stringify(parsedTags), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});