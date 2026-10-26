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
    const { garments, heroAnchor, dailySchedules, locationName } = await req.json();

    if (!garments || garments.length === 0) {
      return new Response(JSON.stringify({ error: "No garments provided" }), {
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

    const catalogSummary = garments.map((g: any) => ({
      id: g.id,
      brand: g.brand || "Unspecified",
      name: g.name,
      cat: g.category,
      sub: g.sub_category || "",
      col: g.color || "",
      form: g.formality || "Executive Casual"
    }));

    // Inventory preflight: distinct pieces per slot, so the model knows where reuse is permitted
    const countCategory = (cat: string) => catalogSummary.filter((g: any) => g.cat === cat).length;
    const inventory = {
      Top: countCategory("Top"),
      Layer: countCategory("Layer"),
      Bottom: countCategory("Bottom"),
      Footwear: countCategory("Footwear")
    };

    const systemPrompt = `You are Sloane, an elite executive wardrobe architect.
Curate a tailored 5-day workweek board (Monday through Friday) for an executive in ${locationName || "Minnetonka, MN"}.

STRICT RULES:
1. ROTATION INTEGRITY (INVENTORY-AWARE): The payload includes "inventory", the number of distinct pieces in each category (Top, Layer, Bottom, Footwear). Apply rotation per category:
- Tops (shirts, knits, tees): No top may repeat across Monday through Friday. Only if inventory.Top is fewer than 5 may a top be worn twice; then repeat the fewest tops possible, never on consecutive days.
- Layers (outerwear), Bottoms (trousers, chinos), and Footwear: Prioritize variety and use every suitable distinct piece before repeating any. Only if a category has fewer distinct pieces than the 5 days require, re-style versatile staple pieces (neutral trousers, a navy blazer, brown loafers) across 2 non-consecutive days, paired with different complementary garments each time.
- Use a repeated piece on at most 2 days. Only if a category has so few pieces that 5 days cannot be covered otherwise (e.g. 1 or 2 bottoms) may a piece appear on more days; still avoid consecutive days wherever the inventory allows.
- When a piece repeats, say so in that day's rationale and explain how the restyle makes the outfit distinct.
2. HERO ANCHOR INTEGRITY: If active, lock it to THAT SINGLE DAY ONLY in its category. Harmonize other pieces around it. Never assign that piece to any other day, even when inventory is limited.
3. COMPLETE SCHEDULE: Always return all 5 days with all four slots (top_id, layer_id, bottom_id, footwear_id) filled with an id from the wardrobe. Never drop a day, return null, or invent an id because inventory is limited. If a category is depleted, restyle its best-matching piece with distinct complementary garments. Only if a category has zero pieces, set that slot to an empty string "" for every day and note the gap in the executiveBriefing.
4. ADAPTIVE METEOROLOGY & CONTEXT:
- Synchronize with each day's SPECIFIC temperature and conditions (cooler temperatures mandate knits, flannels, chore jackets; milder temperatures allow lighter layers).
- Match each day's SPECIFIC ACTIVITY:
 * "In-Person Meeting": Tailored, elevated (blazers, structured sport coats, dress chinos/trousers, clean leather loafers/shoes).
 * "Work From Home / Focus": Elevated comfort (merino knits, luxury tees, 5-pocket pants, elevated sneakers).
 * "Executive Casual / Office": Refined balance (overshirts, casual blazers, oxfords, derbies/boots).
 * "Client Dinner / Evening": Sharp, richer tones (monochrome, dark charcoal/navy, elevated boots or dress shoes).
 * "Travel / Transit": Versatile stretch, comfortable layering.
5. EXECUTIVE HARMONY: Anchor outfits in elevated neutrals (navy, charcoal, tobacco, olive, grey) with at most one textured statement piece per outfit.

Return ONLY raw JSON matching this schema exactly: the same keys, all five day keys, no extra fields, no markdown fences, no commentary.
{
"executiveBriefing": "2 sentences summarizing the weekly sartorial strategy, local weather shifts, and activity adaptability.",
"days": {
"Monday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence explaining the pairing logic." },
"Tuesday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence explaining the pairing logic." },
"Wednesday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence explaining the pairing logic." },
"Thursday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence explaining the pairing logic." },
"Friday": { "top_id": "UUID", "layer_id": "UUID", "bottom_id": "UUID", "footwear_id": "UUID", "rationale": "1 concise sentence explaining the pairing logic." }
}
}`;

    const userPayload = JSON.stringify({
      location: locationName || "Minnetonka, MN",
      wardrobe: catalogSummary,
      inventory,
      anchor: heroAnchor || null,
      dailySchedules: dailySchedules || null
    });

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: activeModel,
        max_tokens: 3500,
        system: systemPrompt,
        messages: [{ role: "user", content: userPayload }]
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
      return new Response(JSON.stringify({ error: "Empty response from curation model" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      throw new Error("No JSON found in model output");
    }

    const cleanJson = rawText.substring(firstBrace, lastBrace + 1);
    const curatedPlan = JSON.parse(cleanJson);

    return new Response(JSON.stringify(curatedPlan), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});